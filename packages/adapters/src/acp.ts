import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

type Json = any;
type RequestHandler = (params: Json) => Promise<Json> | Json;

export class AcpError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/**
 * Minimal Agent Client Protocol client: newline-delimited JSON-RPC 2.0 over a child process's stdio.
 * The agent can also call us (e.g. session/request_permission), which is served by `handle()`.
 */
export class AcpConnection {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private handlers = new Map<string, RequestHandler>();
  private notificationListeners = new Set<(method: string, params: Json) => void>();
  private buffer = '';
  private stderrTail: string[] = [];
  readonly exited: Promise<number | null>;

  constructor(command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) {
    this.proc = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk: string) => {
      this.stderrTail.push(chunk);
      if (this.stderrTail.length > 50) this.stderrTail.shift();
    });
    this.exited = new Promise((resolve) => {
      this.proc.on('exit', (code) => {
        const err = new AcpError(-32000, `agent process exited (${code}): ${this.stderr().slice(-500)}`);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        resolve(code);
      });
      this.proc.on('error', (err) => {
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        resolve(null);
      });
    });
  }

  stderr(): string {
    return this.stderrTail.join('');
  }

  request<T = Json>(method: string, params: Json): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: Json) {
    this.write({ jsonrpc: '2.0', method, params });
  }

  handle(method: string, handler: RequestHandler) {
    this.handlers.set(method, handler);
  }

  onNotification(fn: (method: string, params: Json) => void): () => void {
    this.notificationListeners.add(fn);
    return () => this.notificationListeners.delete(fn);
  }

  close() {
    if (this.proc.exitCode === null) this.proc.kill();
  }

  private write(msg: Json) {
    if (!this.proc.stdin.writable) return;
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: Json;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // agents occasionally print non-protocol lines; ignore them
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Json) {
    if (msg.id != null && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new AcpError(msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id != null) {
      void this.serve(msg.id, msg.method, msg.params);
      return;
    }
    for (const fn of this.notificationListeners) fn(msg.method, msg.params);
  }

  private async serve(id: number | string, method: string, params: Json) {
    const handler = this.handlers.get(method);
    if (!handler) {
      this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
      return;
    }
    try {
      this.write({ jsonrpc: '2.0', id, result: await handler(params) });
    } catch (err) {
      this.write({ jsonrpc: '2.0', id, error: { code: -32603, message: (err as Error).message } });
    }
  }
}
