import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Pool } from '@ih/core';
import type { HarnessAuthStatus, HarnessLoginFlow, SystemHarnessId, SystemHarnessStatus } from '@ih/client';
import { refreshConfigPools, type DaemonConfig } from './config.ts';

const INSTALL_TIMEOUT_MS = 15 * 60_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const CHECK_TIMEOUT_MS = 4_000;

/** Strips ANSI escape sequences from CLI output. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

/** Extracts the first https:// URL from CLI output. */
function extractUrl(text: string): string | null {
  const m = /https:\/\/[^\s"'<>)\]]+/i.exec(stripAnsi(text));
  return m ? m[0].replace(/[.,;]+$/, '') : null;
}

/** Extracts a device/verification code (e.g. ABCD-1234 or 8-char code) from CLI output. */
function extractDeviceCode(text: string): string | null {
  const clean = stripAnsi(text);
  const labeled = /(?:one-time code|user code|verification code|enter code|code)\s*[:is]*\s*([A-Z0-9]{4,8}-[A-Z0-9]{4,8}|[A-Z0-9]{6,12})/i.exec(clean);
  if (labeled?.[1]) return labeled[1];
  const standalone = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(clean);
  return standalone?.[1] ?? null;
}

function augmentedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const extra = [
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.npm-global', 'bin'),
    join(homedir(), '.opencode', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  const current = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const merged = [...new Set([...current, ...extra])].join(delimiter);
  return { ...env, PATH: merged };
}

function execQuick(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeout = CHECK_TIMEOUT_MS): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, timeout, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

function hasFilesIn(dir: string): boolean {
  try {
    return existsSync(dir) && readdirSync(dir).some((f) => !f.startsWith('.'));
  } catch {
    return false;
  }
}

/** Updates or appends key=value pairs in a .env file while preserving comments and other keys. */
export function updateDotEnvFile(envFile: string, updates: Record<string, string | undefined>): void {
  const current = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
  const lines = current ? current.split(/\r?\n/) : [];
  const seen = new Set<string>();
  const nextLines = lines.map((line) => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!m) return line;
    const key = m[1]!;
    if (!(key in updates) || updates[key] === undefined) return line;
    seen.add(key);
    return `${key}=${updates[key]}`;
  });
  for (const [key, val] of Object.entries(updates)) {
    if (val === undefined || seen.has(key)) continue;
    nextLines.push(`${key}=${val}`);
  }
  writeFileSync(envFile, nextLines.join('\n').replace(/\n*$/, '\n'));
}

export interface HarnessManagerDeps {
  config: DaemonConfig;
  env?: NodeJS.ProcessEnv;
  /** Called whenever pools or binaries change so limiter/health/scheduler can react. */
  onPoolsChanged?: (pools: Pool[]) => void;
  /** Optional override for tests. */
  runInstallCommand?: (command: string, cwd: string, env: NodeJS.ProcessEnv) => Promise<{ ok: boolean; output: string }>;
}

export class HarnessManager {
  private config: DaemonConfig;
  private env: NodeJS.ProcessEnv;
  private onPoolsChanged?: (pools: Pool[]) => void;
  private runInstallOverride?: HarnessManagerDeps['runInstallCommand'];
  private versionCache = new Map<string, string | null>();
  private flows = new Map<SystemHarnessId, { flow: HarnessLoginFlow; proc: ChildProcess | null; timer: NodeJS.Timeout | null }>();

  constructor(deps: HarnessManagerDeps) {
    this.config = deps.config;
    this.env = deps.env ?? process.env;
    this.onPoolsChanged = deps.onPoolsChanged;
    this.runInstallOverride = deps.runInstallCommand;
  }

  /** Re-detects system binaries and refreshes `config.pools` in-place. */
  syncPools(): Pool[] {
    const pools = refreshConfigPools(this.config, this.env);
    this.onPoolsChanged?.(pools);
    return pools;
  }

  private async versionOf(key: string, bin: string | null, args = ['--version']): Promise<string | null> {
    if (!bin) return null;
    if (this.versionCache.has(`${key}:${bin}`)) return this.versionCache.get(`${key}:${bin}`) ?? null;
    const res = await execQuick(bin, args, augmentedEnv(this.env), 2_500);
    const first = stripAnsi(`${res.stdout}\n${res.stderr}`).trim().split(/\r?\n/)[0]?.trim() || null;
    const ver = first ? first.slice(0, 64) : null;
    this.versionCache.set(`${key}:${bin}`, ver);
    return ver;
  }

  private async inspectClaude(): Promise<SystemHarnessStatus> {
    const bin = this.config.binaries.claude;
    const version = await this.versionOf('claude', bin);
    let auth: SystemHarnessStatus['auth'] = { status: 'signed_out', detail: bin ? 'Sign in with your Claude account' : 'Install Claude Code CLI first', account: null };
    if (bin) {
      const res = await execQuick(bin, ['auth', 'status'], augmentedEnv(this.env));
      try {
        const parsed = JSON.parse(res.stdout.trim()) as { loggedIn?: boolean; email?: string; subscriptionType?: string; authMethod?: string };
        if (parsed.loggedIn) {
          auth = {
            status: 'signed_in',
            account: parsed.email ?? null,
            detail: [parsed.subscriptionType ? `Claude ${parsed.subscriptionType}` : null, parsed.authMethod].filter(Boolean).join(' · ') || 'Signed in',
          };
        }
      } catch {
        if (/logged\s*in.*true/i.test(res.stdout)) {
          auth = { status: 'signed_in', account: null, detail: 'Signed in' };
        }
      }
    }
    return {
      id: 'claude',
      label: 'Claude Code',
      description: 'Anthropic Claude subscription pool (Opus, Sonnet, Haiku) with live terminal and telemetry.',
      poolIds: ['claude'],
      installed: !!bin,
      binaryPath: bin,
      missingParts: bin ? [] : ['claude'],
      version,
      auth,
      installCommand: 'npm install -g @anthropic-ai/claude-code',
      loginCommand: 'claude auth login',
      loginFlow: this.flows.get('claude')?.flow ?? null,
    };
  }

  private async inspectCodex(): Promise<SystemHarnessStatus> {
    const codex = this.config.binaries.codex ?? null;
    const codexAcp = this.config.binaries.codexAcp ?? null;
    const missingParts = [...(!codex ? ['codex'] : []), ...(!codexAcp ? ['codex-acp'] : [])];
    const installed = !missingParts.length;
    const version = await this.versionOf('codex', codex);
    let auth: SystemHarnessStatus['auth'] = {
      status: 'signed_out',
      detail: codex ? 'Sign in with ChatGPT or an OpenAI API key' : 'Install Codex CLI & ACP bridge first',
      account: null,
    };
    if (codex) {
      const res = await execQuick(codex, ['login', 'status'], augmentedEnv(this.env));
      const text = stripAnsi(`${res.stdout}\n${res.stderr}`).trim();
      if (res.ok && /logged in/i.test(text)) {
        const clean = text.replace(/^[^\w]+/, '').trim();
        auth = { status: 'signed_in', account: null, detail: clean || 'Logged in' };
      }
    }
    const installCommand = !codex
      ? 'npm install -g @openai/codex @agentclientprotocol/codex-acp'
      : 'npm install -g @agentclientprotocol/codex-acp';
    return {
      id: 'codex',
      label: 'OpenAI Codex',
      description: 'ChatGPT / Codex subscription pool via the ACP bridge, with 5-hour & weekly rate-limit tracking.',
      poolIds: ['codex'],
      installed,
      binaryPath: codexAcp ?? codex,
      missingParts,
      version,
      auth,
      installCommand,
      loginCommand: 'codex login --device-auth',
      supportsApiKeyLogin: true,
      loginFlow: this.flows.get('codex')?.flow ?? null,
    };
  }

  private async inspectKimi(): Promise<SystemHarnessStatus> {
    const bin = this.config.binaries.kimi;
    const version = await this.versionOf('kimi', bin);
    let auth: SystemHarnessStatus['auth'] = {
      status: 'signed_out',
      detail: bin ? 'Authenticate via Kimi device-code flow' : 'Install Kimi Code CLI first',
      account: null,
    };
    if (bin) {
      const kimiDir = join(homedir(), '.kimi-code');
      const hasCreds = hasFilesIn(join(kimiDir, 'credentials')) || hasFilesIn(join(kimiDir, 'oauth')) || existsSync(join(homedir(), '.kimi', 'config.toml'));
      if (hasCreds) {
        auth = { status: 'signed_in', account: null, detail: 'Kimi Code credentials active' };
      }
    }
    return {
      id: 'kimi',
      label: 'Kimi Code',
      description: 'Moonshot Kimi Plus subscription pool running over ACP (`kimi acp`).',
      poolIds: ['kimi'],
      installed: !!bin,
      binaryPath: bin,
      missingParts: bin ? [] : ['kimi'],
      version,
      auth,
      installCommand: 'npm install -g @moonshot-ai/kimi-code',
      loginCommand: 'kimi login',
      loginFlow: this.flows.get('kimi')?.flow ?? null,
    };
  }

  private async inspectAgy(): Promise<SystemHarnessStatus> {
    const bin = this.config.binaries.agyAcp;
    const verFile = join(this.config.dataDir, 'bin', 'agy-acp', 'VERSION');
    const version = existsSync(verFile) ? readFileSync(verFile, 'utf8').trim() : null;
    const tokenFile = join(homedir(), '.gemini', 'antigravity-acp', 'acp_token.json');
    const hasToken = existsSync(tokenFile) && readFileSync(tokenFile, 'utf8').trim().length > 2;
    let auth: SystemHarnessStatus['auth'] = {
      status: 'signed_out',
      detail: bin ? 'Sign in with your Google AI Pro account' : 'Install the Antigravity ACP server first',
      account: null,
    };
    if (bin && (hasToken || process.platform === 'darwin')) {
      auth = {
        status: 'signed_in',
        account: null,
        detail: hasToken ? 'Google OAuth token cached' : 'macOS Keychain login ready',
      };
    }
    return {
      id: 'agy',
      label: 'Google Antigravity',
      description: 'Google AI Pro / Gemini pool via the verified Antigravity ACP server.',
      poolIds: ['agy'],
      installed: !!bin,
      binaryPath: bin,
      missingParts: bin ? [] : ['agy-acp'],
      version,
      auth,
      installCommand: 'bash scripts/install-agy-acp.sh',
      loginCommand: 'node scripts/agy-acp-login.mjs',
      loginFlow: this.flows.get('agy')?.flow ?? null,
    };
  }

  private async inspectOpenCode(): Promise<SystemHarnessStatus> {
    const bin = this.config.binaries.opencode ?? null;
    const version = await this.versionOf('opencode', bin);
    const nimApiKeySet = !!(this.env.NVIDIA_API_KEY && this.env.NVIDIA_API_KEY.trim());
    const nimModel = this.env.NVIDIA_MODEL || 'deepseek-ai/deepseek-v3.2';
    const localBaseUrl = this.env.LOCAL_LLM_BASE_URL || '';
    const localModel = this.env.LOCAL_LLM_MODEL || '';
    const activeProviders = [
      ...(nimApiKeySet && nimModel ? ['NVIDIA NIM'] : []),
      ...(localBaseUrl && localModel ? ['Local LLM'] : []),
    ];
    const authStatus: HarnessAuthStatus = activeProviders.length > 0 ? 'configured' : 'unconfigured';
    return {
      id: 'opencode',
      label: 'OpenCode (NIM & Local LLM)',
      description: 'Drives NVIDIA NIM API models and local OpenAI-compatible servers (vLLM, llama.cpp, Ollama) through the daemon gateway.',
      poolIds: ['nim', 'local'],
      installed: !!bin,
      binaryPath: bin,
      missingParts: bin ? [] : ['opencode'],
      version,
      auth: {
        status: authStatus,
        account: null,
        detail: activeProviders.length ? `${activeProviders.join(' + ')} configured` : 'Set NVIDIA NIM key or Local LLM URL below',
      },
      installCommand: 'curl -fsSL https://opencode.ai/v2/install | bash',
      loginCommand: null,
      loginFlow: null,
      envConfig: {
        nimApiKeySet,
        nimModel,
        localBaseUrl,
        localModel,
      },
    };
  }

  private async inspectGh(): Promise<SystemHarnessStatus> {
    const bin = this.config.binaries.gh ?? null;
    const version = await this.versionOf('gh', bin);
    let auth: SystemHarnessStatus['auth'] = {
      status: 'signed_out',
      detail: bin ? 'Optional: sign in so the refinery can land cards as GitHub PRs' : 'Optional: install GitHub CLI for PR landing',
      account: null,
    };
    if (bin) {
      const res = await execQuick(bin, ['auth', 'status'], augmentedEnv(this.env));
      const text = stripAnsi(`${res.stdout}\n${res.stderr}`);
      const m = /Logged in to [^\s]+ account ([^\s(]+)/i.exec(text);
      if (res.ok || m) {
        auth = {
          status: 'signed_in',
          account: m?.[1] ?? null,
          detail: m?.[1] ? `Signed in as ${m[1]}` : 'GitHub CLI authenticated',
        };
      }
    }
    const installCommand =
      process.platform === 'darwin'
        ? 'brew install gh'
        : 'conda install -y -c conda-forge gh || (type -p curl >/dev/null && sudo apt-get update && sudo apt-get install -y gh)';
    return {
      id: 'gh',
      label: 'GitHub CLI (PR Landing)',
      description: 'Optional helper used by the Refinery to open and merge GitHub Pull Requests instead of local-only merges.',
      poolIds: [],
      installed: !!bin,
      binaryPath: bin,
      missingParts: bin ? [] : ['gh'],
      version,
      auth,
      installCommand,
      loginCommand: 'gh auth login --web -h github.com',
      supportsApiKeyLogin: true,
      loginFlow: this.flows.get('gh')?.flow ?? null,
    };
  }

  async get(id: SystemHarnessId): Promise<SystemHarnessStatus> {
    this.syncPools();
    switch (id) {
      case 'claude':
        return this.inspectClaude();
      case 'codex':
        return this.inspectCodex();
      case 'kimi':
        return this.inspectKimi();
      case 'agy':
        return this.inspectAgy();
      case 'opencode':
        return this.inspectOpenCode();
      case 'gh':
        return this.inspectGh();
      default:
        throw new Error(`unknown harness: ${String(id)}`);
    }
  }

  async list(): Promise<SystemHarnessStatus[]> {
    this.syncPools();
    return Promise.all([
      this.inspectClaude(),
      this.inspectCodex(),
      this.inspectKimi(),
      this.inspectAgy(),
      this.inspectOpenCode(),
      this.inspectGh(),
    ]);
  }

  async install(id: SystemHarnessId): Promise<{ ok: boolean; output: string; harness: SystemHarnessStatus; pools: Pool[] }> {
    const info = await this.get(id);
    const cmd = info.installCommand;
    const env = augmentedEnv(this.env);
    const result = this.runInstallOverride
      ? await this.runInstallOverride(cmd, this.config.root, env)
      : await new Promise<{ ok: boolean; output: string }>((resolve) => {
          execFile('sh', ['-c', cmd], { cwd: this.config.root, env, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
            const output = stripAnsi(`${stdout ?? ''}${stderr ?? ''}`).slice(-4000);
            resolve({ ok: !err, output });
          });
        });
    this.versionCache.clear();
    const pools = this.syncPools();
    const harness = await this.get(id);
    return { ok: result.ok, output: result.output, harness, pools };
  }

  cancelLogin(id: SystemHarnessId): void {
    const existing = this.flows.get(id);
    if (!existing) return;
    if (existing.timer) clearTimeout(existing.timer);
    try {
      existing.proc?.kill();
    } catch {
      // ignore
    }
    this.flows.delete(id);
  }

  async login(id: SystemHarnessId, opts: { apiKey?: string; mode?: string } = {}): Promise<{ flow: HarnessLoginFlow | null; harness: SystemHarnessStatus; pools: Pool[] }> {
    this.syncPools();
    const env = augmentedEnv(this.env);

    // Direct API-key / token login for Codex or GitHub CLI
    if (opts.apiKey?.trim()) {
      const key = opts.apiKey.trim();
      if (id === 'codex') {
        const bin = this.config.binaries.codex;
        if (!bin) throw new Error('Codex CLI is not installed yet');
        await new Promise<void>((resolve, reject) => {
          const child = spawn(bin, ['login', '--with-api-key'], { cwd: this.config.root, env, stdio: ['pipe', 'pipe', 'pipe'] });
          let errOut = '';
          child.stderr.on('data', (d) => (errOut += String(d)));
          child.on('error', reject);
          child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stripAnsi(errOut).trim() || `codex login exited with ${code}`))));
          child.stdin.write(key + '\n');
          child.stdin.end();
        });
        const pools = this.syncPools();
        return { flow: null, harness: await this.get(id), pools };
      }
      if (id === 'gh') {
        const bin = this.config.binaries.gh;
        if (!bin) throw new Error('GitHub CLI is not installed yet');
        await new Promise<void>((resolve, reject) => {
          const child = spawn(bin, ['auth', 'login', '--with-token'], { cwd: this.config.root, env, stdio: ['pipe', 'pipe', 'pipe'] });
          let errOut = '';
          child.stderr.on('data', (d) => (errOut += String(d)));
          child.on('error', reject);
          child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stripAnsi(errOut).trim() || `gh auth login exited with ${code}`))));
          child.stdin.write(key + '\n');
          child.stdin.end();
        });
        const pools = this.syncPools();
        return { flow: null, harness: await this.get(id), pools };
      }
    }

    this.cancelLogin(id);

    let cmd: string;
    let args: string[];
    let stdinInitial: string | null = null;
    switch (id) {
      case 'claude': {
        if (!this.config.binaries.claude) throw new Error('Claude Code CLI is not installed');
        cmd = this.config.binaries.claude;
        args = ['auth', 'login'];
        break;
      }
      case 'codex': {
        if (!this.config.binaries.codex) throw new Error('Codex CLI is not installed');
        cmd = this.config.binaries.codex;
        args = opts.mode === 'browser' ? ['login'] : ['login', '--device-auth'];
        break;
      }
      case 'kimi': {
        if (!this.config.binaries.kimi) throw new Error('Kimi Code CLI is not installed');
        cmd = this.config.binaries.kimi;
        args = ['login'];
        break;
      }
      case 'agy': {
        if (!this.config.binaries.agyAcp) throw new Error('Antigravity ACP server is not installed');
        cmd = process.execPath;
        args = [join(this.config.root, 'scripts', 'agy-acp-login.mjs')];
        break;
      }
      case 'gh': {
        if (!this.config.binaries.gh) throw new Error('GitHub CLI is not installed');
        cmd = this.config.binaries.gh;
        args = ['auth', 'login', '--web', '-h', 'github.com', '-p', 'https'];
        stdinInitial = '\n';
        break;
      }
      default:
        throw new Error(`Interactive sign-in is not supported for ${id}`);
    }

    const flow: HarnessLoginFlow = {
      active: true,
      url: null,
      code: null,
      output: '',
      error: null,
      startedAt: new Date().toISOString(),
    };

    const child = spawn(cmd, args, {
      cwd: this.config.root,
      env: { ...env, BROWSER: 'echo' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (stdinInitial) {
      try {
        child.stdin.write(stdinInitial);
      } catch {
        // ignore
      }
    }

    const timer = setTimeout(() => {
      flow.active = false;
      flow.error = 'Sign-in timed out after 5 minutes.';
      try {
        child.kill();
      } catch {
        // ignore
      }
    }, LOGIN_TIMEOUT_MS);
    timer.unref?.();

    this.flows.set(id, { flow, proc: child, timer });

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const onChunk = (chunk: Buffer) => {
        const text = stripAnsi(String(chunk));
        flow.output = (flow.output + text).slice(-3000);
        if (!flow.url) flow.url = extractUrl(flow.output);
        if (!flow.code) flow.code = extractDeviceCode(flow.output);
        if (flow.url) done();
      };
      child.stdout.on('data', onChunk);
      child.stderr.on('data', onChunk);
      child.on('error', (err) => {
        flow.active = false;
        flow.error = err.message;
        clearTimeout(timer);
        done();
      });
      child.on('close', (code) => {
        flow.active = false;
        clearTimeout(timer);
        if (code !== 0 && !flow.error) {
          flow.error = flow.output.trim().split('\n').slice(-2).join(' ') || `Process exited with code ${code}`;
        }
        this.syncPools();
        done();
      });
      setTimeout(done, 2_200).unref?.();
    });

    const pools = this.syncPools();
    return { flow, harness: await this.get(id), pools };
  }

  async configureEnv(patch: {
    nimApiKey?: string;
    nimModel?: string;
    localBaseUrl?: string;
    localModel?: string;
  }): Promise<{ harness: SystemHarnessStatus; pools: Pool[] }> {
    const updates: Record<string, string | undefined> = {};
    if (patch.nimApiKey !== undefined) {
      const v = patch.nimApiKey.trim();
      updates.NVIDIA_API_KEY = v;
      if (v) this.env.NVIDIA_API_KEY = v;
      else delete this.env.NVIDIA_API_KEY;
    }
    if (patch.nimModel !== undefined) {
      const v = patch.nimModel.trim() || 'deepseek-ai/deepseek-v3.2';
      updates.NVIDIA_MODEL = v;
      this.env.NVIDIA_MODEL = v;
    }
    if (patch.localBaseUrl !== undefined) {
      const v = patch.localBaseUrl.trim();
      updates.LOCAL_LLM_BASE_URL = v;
      if (v) this.env.LOCAL_LLM_BASE_URL = v;
      else delete this.env.LOCAL_LLM_BASE_URL;
    }
    if (patch.localModel !== undefined) {
      const v = patch.localModel.trim();
      updates.LOCAL_LLM_MODEL = v;
      if (v) this.env.LOCAL_LLM_MODEL = v;
      else delete this.env.LOCAL_LLM_MODEL;
    }
    updateDotEnvFile(join(this.config.root, '.env'), updates);
    const pools = this.syncPools();
    return { harness: await this.get('opencode'), pools };
  }
}
