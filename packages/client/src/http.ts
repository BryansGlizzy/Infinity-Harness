export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface HttpOptions {
  /** The daemon's address, e.g. `http://127.0.0.1:7420`. In a browser: `location.origin`. */
  baseUrl: string;
  /** The API token. Not needed for a daemon on this machine unless it was started with MH_REQUIRE_TOKEN=1. */
  token?: string;
  /** Read the token when a request is made (the web UI keeps it in browser storage). Wins over `token`. */
  tokenProvider?: () => string;
  /** Give up on a request after this long. Unset: wait. */
  timeoutMs?: number;
  /** Called on a 401. Resolve true to retry once (for example after asking the person for the token). */
  onUnauthorized?: (reason: string) => Promise<boolean>;
  fetch?: typeof fetch;
}

/** Calls to one daemon: JSON in and out, the token on every request, errors as `HttpError`. */
export class DaemonHttp {
  baseUrl: string;
  token: string;
  timeoutMs: number | undefined;
  private tokenProvider: (() => string) | undefined;
  private onUnauthorized: ((reason: string) => Promise<boolean>) | undefined;
  private fetchImpl: typeof fetch;

  constructor(opts: HttpOptions) {
    this.baseUrl = opts.baseUrl;
    this.token = opts.token ?? '';
    this.timeoutMs = opts.timeoutMs;
    this.tokenProvider = opts.tokenProvider;
    this.onUnauthorized = opts.onUnauthorized;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  currentToken(): string {
    return this.tokenProvider ? this.tokenProvider() : this.token;
  }

  async call<T>(method: string, path: string, body?: unknown, opts: { timeoutMs?: number } = {}, retried = false): Promise<T> {
    const token = this.currentToken();
    const timeout = opts.timeoutMs ?? this.timeoutMs;
    const res = await this.fetchImpl(new URL(path, this.baseUrl), {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: timeout ? AbortSignal.timeout(timeout) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 401 && !retried && this.onUnauthorized && (await this.onUnauthorized(data.error ?? 'unauthorized'))) return this.call<T>(method, path, body, opts, true);
    if (!res.ok) throw new HttpError(res.status, data.error ?? `${res.status} ${res.statusText}`);
    return data as T;
  }

  /** WebSocket address for a path on the daemon (`/ws`, `/ws/terminal/<card>`). The token rides in the query: a handshake carries no headers here. */
  wsUrl(path: string): string {
    const url = new URL(path, this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = this.currentToken();
    if (token) url.searchParams.set('token', token);
    return url.toString();
  }
}
