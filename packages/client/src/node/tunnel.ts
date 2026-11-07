// One saved machine, kept reachable: an `ssh -L` forward from a free local port to the daemon on the other machine,
// watched, and re-made with a growing delay when it drops. The daemon never listens beyond loopback; OpenSSH does the
// authentication, host-key checking and encryption. Nothing here ever answers a prompt or installs or starts anything
// on the other machine (the same rule herdr follows for its saved machines).
import { execFile, spawn as spawnProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { DaemonApi } from '../api.ts';
import { DaemonHttp } from '../http.ts';
import type { MachineProfile } from './catalog.ts';

/**
 * connecting: first attempt · online: forward up and daemon answering · reconnecting: dropped, retrying with backoff ·
 * attention: needs a person (see `attention`), not retried until `retry()` · stopped.
 */
export type ConnectionState = 'connecting' | 'online' | 'reconnecting' | 'attention' | 'stopped';
export type AttentionKind = 'auth' | 'hostkey' | 'token';

export interface TunnelProcess {
  kill(): void;
  /** Called once with the exit code and what ssh wrote to stderr. */
  onExit(fn: (code: number | null, stderr: string) => void): void;
}
export type SpawnTunnel = (a: { profile: MachineProfile; localPort: number; args: string[] }) => TunnelProcess;

export interface ConnectionOptions {
  spawn?: SpawnTunnel;
  freePort?: () => Promise<number>;
  fetch?: typeof fetch;
  /** Reads the daemon's API token over SSH (needs `remoteRoot`). Tests replace it. */
  readToken?: (profile: MachineProfile) => Promise<string>;
  /** How long to wait for the daemon to answer through a new forward. */
  readyTimeoutMs?: number;
  /** How often a live forward is checked. Two misses in a row mean it is dead. */
  checkIntervalMs?: number;
  /** How long one health check may take before it counts as a miss. */
  checkTimeoutMs?: number;
  /** Retry delay: starts at `minMs`, doubles to `maxMs`, and starts over only after a connection stayed healthy for `healthyMs`. */
  backoff?: { minMs?: number; maxMs?: number; healthyMs?: number };
}

/** The ssh arguments for a forward. Never prompts (BatchMode) and drops dead peers; `--` keeps the target from being read as an option. */
export function tunnelArgs(profile: MachineProfile, localPort: number, extra: string[] = sshExtraArgs()): string[] {
  return [
    '-N',
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-L', `127.0.0.1:${localPort}:127.0.0.1:${profile.remotePort}`,
    ...(profile.sshPort ? ['-p', String(profile.sshPort)] : []),
    ...extra,
    '--',
    profile.target,
  ];
}

/**
 * Extra ssh options from the person's own environment (`IH_SSH_ARGS="-F /path/to/config"`), for setups ~/.ssh/config
 * cannot express. Never read from a saved profile: a catalog entry must not be able to add ssh options.
 */
export function sshExtraArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.IH_SSH_ARGS ?? '').split(/\s+/).filter(Boolean);
}

/** Which failures need a person (a key to load, a host key to approve) and which are the network having a bad moment. */
export function classifySshFailure(stderr: string): AttentionKind | null {
  if (/permission denied|too many authentication failures|no supported authentication/i.test(stderr)) return 'auth';
  if (/host key verification failed|remote host identification has changed|host key.*(not|mismatch)/i.test(stderr)) return 'hostkey';
  return null;
}

const defaultSpawn: SpawnTunnel = ({ args }) => {
  const child = spawnProcess('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
  return {
    kill: () => child.kill('SIGTERM'),
    onExit: (fn) => {
      child.on('exit', (code) => fn(code, stderr));
      child.on('error', (err) => fn(null, err.message));
    },
  };
};

const defaultFreePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

/** A path as the remote shell should read it: `~/x` keeps its home expansion, everything else is quoted. */
export function remotePath(path: string): string {
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return path.startsWith('~/') ? `"$HOME"/${quote(path.slice(2))}` : quote(path);
}

const defaultReadToken = (profile: MachineProfile) =>
  new Promise<string>((resolve, reject) => {
    if (!profile.remoteRoot) return reject(new Error('the daemon wants its API token; set the remote folder of this machine so it can be read over SSH'));
    const command = `cat -- ${remotePath(`${profile.remoteRoot.replace(/\/$/, '')}/.meta-harness/api-token`)}`;
    const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', ...(profile.sshPort ? ['-p', String(profile.sshPort)] : []), ...sshExtraArgs(), '--', profile.target, command];
    execFile('ssh', args, { timeout: 30_000 }, (err, stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout.trim())));
  });

const sleep = (ms: number, wake: { fn: (() => void) | null }) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      wake.fn = null;
      resolve();
    }
    wake.fn = done;
  });

/** A saved machine, connected. Create it, call `start()`, then use `api` once `state` is `online` (or await `ready()`). */
export class MachineConnection {
  readonly profile: MachineProfile;
  readonly api: DaemonApi;
  state: ConnectionState = 'stopped';
  /** Why the last attempt failed, in words for a person. */
  error: string | null = null;
  attention: AttentionKind | null = null;
  localPort: number | null = null;
  private http: DaemonHttp;
  private opts: Required<Pick<ConnectionOptions, 'spawn' | 'freePort' | 'readToken' | 'readyTimeoutMs' | 'checkIntervalMs' | 'checkTimeoutMs'>> & { backoff: Required<NonNullable<ConnectionOptions['backoff']>>; fetch: typeof fetch };
  private listeners = new Set<(c: MachineConnection) => void>();
  private proc: TunnelProcess | null = null;
  private running = false;
  private stopRequested = false;
  private wake: { fn: (() => void) | null } = { fn: null };

  constructor(profile: MachineProfile, opts: ConnectionOptions = {}) {
    this.profile = profile;
    this.http = new DaemonHttp({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 15_000 });
    this.api = new DaemonApi(this.http);
    this.opts = {
      spawn: opts.spawn ?? defaultSpawn,
      freePort: opts.freePort ?? defaultFreePort,
      readToken: opts.readToken ?? defaultReadToken,
      readyTimeoutMs: opts.readyTimeoutMs ?? 20_000,
      checkIntervalMs: opts.checkIntervalMs ?? 15_000,
      checkTimeoutMs: opts.checkTimeoutMs ?? 3_000,
      backoff: { minMs: opts.backoff?.minMs ?? 1_000, maxMs: opts.backoff?.maxMs ?? 120_000, healthyMs: opts.backoff?.healthyMs ?? 60_000 },
      fetch: opts.fetch ?? ((i, init) => fetch(i, init)),
    };
  }

  /** The local address the other machine's daemon is reachable at while `online`. */
  get baseUrl(): string | null {
    return this.state === 'online' ? this.http.baseUrl : null;
  }

  onChange(fn: (c: MachineConnection) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(state: ConnectionState, error: string | null = null, attention: AttentionKind | null = null) {
    this.state = state;
    this.error = error;
    this.attention = attention;
    for (const fn of this.listeners) fn(this);
  }

  start() {
    if (this.running) return;
    this.stopRequested = false;
    this.running = true;
    void this.loop().finally(() => (this.running = false));
  }

  /** Try again now, e.g. after the person fixed what `attention` named. */
  retry() {
    if (this.state === 'attention' || this.state === 'stopped') this.start();
    else this.wake.fn?.();
  }

  stop() {
    this.stopRequested = true;
    this.proc?.kill();
    this.wake.fn?.();
    if (!this.running) this.set('stopped');
  }

  /** Resolves when `online`; rejects with the reason if the connection needs attention or is stopped first. */
  ready(timeoutMs = 60_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.state === 'online') return done(resolve);
        if (this.state === 'attention' || this.state === 'stopped') return done(() => reject(new Error(this.error ?? this.state)));
      };
      const off = this.onChange(check);
      const timer = setTimeout(() => done(() => reject(new Error(this.error ?? 'timed out waiting for the connection'))), timeoutMs);
      function done(finish: () => void) {
        clearTimeout(timer);
        off();
        finish();
      }
      check();
    });
  }

  private async healthy(): Promise<{ ok: boolean; auth?: string }> {
    try {
      const res = await this.opts.fetch(new URL('/api/health', this.http.baseUrl), { signal: AbortSignal.timeout(this.opts.checkTimeoutMs) });
      if (!res.ok) return { ok: false };
      return { ok: true, auth: ((await res.json()) as { auth?: string }).auth };
    } catch {
      return { ok: false };
    }
  }

  private async loop() {
    const { minMs, maxMs, healthyMs } = this.opts.backoff;
    let delay = minMs;
    let first = true;
    while (!this.stopRequested) {
      this.set(first ? 'connecting' : 'reconnecting', this.error);
      first = false;
      const outcome = await this.attempt();
      this.proc?.kill();
      this.proc = null;
      if (this.stopRequested) break;
      if (outcome.attention) {
        this.set('attention', outcome.error, outcome.attention);
        return;
      }
      if (outcome.healthyFor >= healthyMs) delay = minMs;
      this.set('reconnecting', outcome.error);
      await sleep(delay, this.wake);
      delay = Math.min(delay * 2, maxMs);
    }
    this.set('stopped');
  }

  /** One connection: forward, wait for the daemon, then watch it until it fails. */
  private async attempt(): Promise<{ error: string | null; attention?: AttentionKind; healthyFor: number }> {
    const fail = (error: string, attention?: AttentionKind) => ({ error, attention, healthyFor: 0 });
    let localPort: number;
    try {
      localPort = await this.opts.freePort();
    } catch (err) {
      return fail(`no free local port: ${(err as Error).message}`);
    }
    this.localPort = localPort;
    this.http.baseUrl = `http://127.0.0.1:${localPort}`;
    this.http.token = '';

    let exited: { code: number | null; stderr: string } | null = null;
    const proc = this.opts.spawn({ profile: this.profile, localPort, args: tunnelArgs(this.profile, localPort) });
    this.proc = proc;
    let onExited: (() => void) | null = null;
    proc.onExit((code, stderr) => {
      exited = { code, stderr };
      onExited?.();
    });
    const exitReason = (): { error: string; attention?: AttentionKind } => {
      const text = (exited?.stderr ?? '').trim();
      const kind = classifySshFailure(text);
      const line = text.split('\n').filter(Boolean).at(-1) ?? `ssh exited with code ${exited?.code}`;
      return kind ? { error: line, attention: kind } : { error: line };
    };

    // Wait for the daemon to answer through the forward (or ssh to give up).
    const deadline = Date.now() + this.opts.readyTimeoutMs;
    let health: { ok: boolean; auth?: string } = { ok: false };
    while (!exited && !this.stopRequested && Date.now() < deadline) {
      health = await this.healthy();
      if (health.ok) break;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 150);
        onExited = () => (clearTimeout(t), resolve());
      });
    }
    if (this.stopRequested) return { error: null, healthyFor: 0 };
    if (!health.ok) {
      if (exited) return { ...exitReason(), healthyFor: 0 };
      return fail(`${this.profile.target} is reachable but no Infinity Harness daemon answers on its port ${this.profile.remotePort}. Start it there.`);
    }

    if (health.auth === 'token') {
      try {
        this.http.token = await this.opts.readToken(this.profile);
      } catch (err) {
        return fail((err as Error).message, 'token');
      }
    }

    const since = Date.now();
    this.set('online');
    // Watch it: a dead forward keeps the local port open, so ask the daemon, not the process.
    let misses = 0;
    while (!exited && !this.stopRequested) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.opts.checkIntervalMs);
        onExited = () => (clearTimeout(t), resolve());
        this.wake.fn = () => (clearTimeout(t), resolve());
      });
      this.wake.fn = null;
      if (exited || this.stopRequested) break;
      misses = (await this.healthy()).ok ? 0 : misses + 1;
      if (misses >= 2) {
        proc.kill();
        return { error: 'the connection stopped answering', healthyFor: Date.now() - since };
      }
    }
    if (this.stopRequested) return { error: null, healthyFor: Date.now() - since };
    return { ...exitReason(), healthyFor: Date.now() - since };
  }
}
