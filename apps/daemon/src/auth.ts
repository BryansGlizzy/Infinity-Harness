// Who may call the daemon's API (master plan Phase 6.6, remote prerequisites).
//
// The daemon listens on loopback, and an SSH port forward (the planned way to reach a daemon on another machine) arrives
// from loopback too, so "where the connection came from" cannot be the only gate. Three layers instead:
//   1. A token (generated on first run, kept in a 0600 file) that always works, and is required from any non-loopback
//      peer, or from everyone when MH_REQUIRE_TOKEN=1.
//   2. Without a token, a browser page on another site must not be able to drive the daemon: the Host header has to be a
//      loopback name (stops DNS rebinding) and an Origin header has to match Host (stops cross-site requests and
//      cross-site WebSockets, which have no preflight).
//   3. A wrong token is always refused, never quietly downgraded to "no token".
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AuthOptions {
  token: string;
  /** Loopback peers need the token too (MH_REQUIRE_TOKEN=1). Applies to the operator surface only. */
  requireToken: boolean;
  /** The daemon only listens on loopback, so a Host header naming anything else is a rebinding attempt. */
  loopbackBound: boolean;
  /** Extra Host names accepted when loopback-bound (MH_ALLOWED_HOSTS, comma separated). */
  allowedHosts: string[];
}

/** What a request is, for access purposes. */
export type Surface =
  /** Static files, health check, Claude's own hook endpoint (it has a per-session token). */
  | 'open'
  /** What agent processes on this machine call: the board MCP server and the telemetry receiver. */
  | 'agent'
  /** What people and their tools call: the REST API and the live sockets. */
  | 'operator';

export function surfaceOf(path: string): Surface {
  if (path === '/api/health' || path === '/hooks/claude') return 'open';
  if (path === '/mcp' || path.startsWith('/mcp/') || path.startsWith('/v1/')) return 'agent';
  if (path.startsWith('/api/') || path === '/ws' || path.startsWith('/ws/')) return 'operator';
  return 'open';
}

export interface RequestFacts {
  path: string;
  /** Peer address of the socket. */
  remote: string;
  host: string | undefined;
  origin: string | undefined;
  authorization: string | undefined;
  /** `?token=` on a WebSocket upgrade (browsers cannot set headers there). */
  queryToken: string | undefined;
}

export interface Refusal {
  status: 401 | 403;
  error: string;
}

export function isLoopbackAddress(address: string): boolean {
  const a = address.replace(/^::ffff:/, '');
  return a === '::1' || a === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(a);
}

/** The name in a Host header or URL authority, without port or brackets. */
function hostnameOf(authority: string): string {
  const a = authority.trim().toLowerCase();
  if (a.startsWith('[')) return a.slice(1, a.indexOf(']'));
  return a.replace(/:\d+$/, '');
}

function hostAllowed(host: string | undefined, extra: string[]): boolean {
  if (!host) return false;
  const name = hostnameOf(host);
  return name === 'localhost' || name.endsWith('.localhost') || isLoopbackAddress(name) || extra.includes(name);
}

function sameOrigin(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function tokensEqual(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Null when the request may proceed, otherwise why not. */
export function checkRequest(opts: AuthOptions, req: RequestFacts): Refusal | null {
  const surface = surfaceOf(req.path);
  if (surface === 'open') return null;

  const given = /^Bearer (.+)$/.exec(req.authorization ?? '')?.[1] ?? (req.path.startsWith('/ws') ? req.queryToken : undefined);
  if (given !== undefined) return tokensEqual(given, opts.token) ? null : { status: 401, error: 'invalid token' };

  if (opts.loopbackBound && !hostAllowed(req.host, opts.allowedHosts)) return { status: 403, error: 'unexpected Host header' };
  if (req.origin !== undefined && !sameOrigin(req.origin, req.host)) return { status: 403, error: 'cross-origin request refused' };
  if (!isLoopbackAddress(req.remote)) return { status: 401, error: 'token required' };
  if (opts.requireToken && surface === 'operator') return { status: 401, error: 'token required' };
  return null;
}

/** MH_API_TOKEN, else the token in `file`, else a new one written there (readable by this user only). */
export function loadApiToken(file: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.MH_API_TOKEN?.trim()) return env.MH_API_TOKEN.trim();
  if (existsSync(file)) {
    const saved = readFileSync(file, 'utf8').trim();
    if (saved) return saved;
  }
  const token = randomBytes(24).toString('hex');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, token + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function authOptionsFromEnv(token: string, host: string, env: NodeJS.ProcessEnv = process.env): AuthOptions {
  return {
    token,
    requireToken: env.MH_REQUIRE_TOKEN === '1',
    loopbackBound: LOOPBACK_HOSTS.has(host),
    allowedHosts: (env.MH_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
  };
}
