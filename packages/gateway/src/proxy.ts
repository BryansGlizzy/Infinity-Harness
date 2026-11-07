import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RateLimiter } from './limiter.ts';

export interface UpstreamPool {
  id: string;
  baseUrl: string;
  apiKey?: string;
}

export interface UsageRecord {
  poolId: string;
  path: string;
  status: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface GatewayOptions {
  limiter: RateLimiter;
  pools: UpstreamPool[];
  /** Local bearer token agents use instead of the real provider keys. */
  token: string;
  host?: string;
  port?: number;
  onUsage?: (u: UsageRecord) => void;
}

export interface Gateway {
  server: Server;
  url: string;
  close(): Promise<void>;
}

const USER_AGENT = 'meta-harness/0.1'; // Groq's Cloudflare rejects requests without a normal User-Agent
const DROP_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);
const DEFAULT_LOCK_MS = 30_000;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Asks for usage in streamed chat completions, so tokens can be counted. Returns the (possibly rewritten) body. */
function prepareBody(path: string, body: Buffer): { body: Buffer; estimate: number } {
  const estimate = Math.ceil(body.length / 4);
  if (!body.length || !path.endsWith('/chat/completions')) return { body, estimate };
  try {
    const json = JSON.parse(body.toString('utf8'));
    if (json.stream === true) {
      json.stream_options = { ...json.stream_options, include_usage: true };
      return { body: Buffer.from(JSON.stringify(json)), estimate };
    }
  } catch {
    // not JSON; forward untouched
  }
  return { body, estimate };
}

/** Finds the last OpenAI-style `usage` object in a JSON or SSE response body. */
export function extractUsage(text: string): { inputTokens: number; outputTokens: number } | null {
  const objects: string[] = [];
  for (const m of text.matchAll(/"usage"\s*:\s*\{/g)) {
    // usage objects nest (prompt_tokens_details: {...}), so take the balanced braces
    const start = m.index! + m[0].length - 1;
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) {
        objects.push(text.slice(start, i + 1));
        break;
      }
    }
  }
  for (let i = objects.length - 1; i >= 0; i--) {
    try {
      const u = JSON.parse(objects[i]!);
      const input = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
      const output = Number(u.completion_tokens ?? u.output_tokens ?? 0);
      if (input || output) return { inputTokens: input, outputTokens: output };
    } catch {
      // keep looking
    }
  }
  return null;
}

function retryAfterMs(headers: Headers): number {
  const retry = headers.get('retry-after');
  if (retry) {
    const secs = Number(retry);
    if (Number.isFinite(secs)) return secs * 1000;
    const at = Date.parse(retry);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  for (const name of ['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens']) {
    const v = headers.get(name);
    const m = v?.match(/^(?:(\d+)m)?(\d+(?:\.\d+)?)s$/);
    if (m) return (Number(m[1] ?? 0) * 60 + Number(m[2])) * 1000;
  }
  return DEFAULT_LOCK_MS;
}

function fail(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message, type: 'gateway_error' } }));
}

/**
 * OpenAI-compatible reverse proxy: `/p/<pool>/v1/<path>` → `<pool baseUrl>/<path>`. Every request passes
 * through the shared limiter first, so agents (e.g. OpenCode) are paced without knowing about it.
 */
export async function startGateway(opts: GatewayOptions): Promise<Gateway> {
  const pools = new Map(opts.pools.map((p) => [p.id, p]));

  const server = createServer(async (req, res) => {
    const match = /^\/p\/([^/]+)\/v1(\/[^?]*)(\?.*)?$/.exec(req.url ?? '');
    if (!match) return fail(res, 404, 'expected /p/<pool>/v1/...');
    const [, poolId, path, query = ''] = match as unknown as [string, string, string, string?];
    const pool = pools.get(poolId);
    if (!pool) return fail(res, 404, `unknown pool ${poolId}`);
    if (req.headers.authorization !== `Bearer ${opts.token}`) return fail(res, 401, 'invalid gateway token');

    const { body, estimate } = prepareBody(path, await readBody(req));
    const release = await opts.limiter.acquire(poolId, estimate);
    const started = Date.now();
    let status = 502;
    let tail = '';
    try {
      const headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: String(req.headers.accept ?? '*/*') };
      if (req.headers['content-type']) headers['content-type'] = String(req.headers['content-type']);
      if (pool.apiKey) headers.authorization = `Bearer ${pool.apiKey}`;
      const upstream = await fetch(`${pool.baseUrl.replace(/\/$/, '')}${path}${query}`, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : new Uint8Array(body),
      });
      status = upstream.status;
      if (status === 429) opts.limiter.lock(poolId, Date.now() + retryAfterMs(upstream.headers));

      const out: Record<string, string> = {};
      upstream.headers.forEach((v, k) => {
        if (!DROP_RESPONSE_HEADERS.has(k)) out[k] = v;
      });
      res.writeHead(status, out);
      if (upstream.body) {
        const decoder = new TextDecoder();
        for await (const chunk of upstream.body) {
          res.write(chunk);
          tail = (tail + decoder.decode(chunk, { stream: true })).slice(-16_384);
        }
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) fail(res, 502, `upstream error: ${(err as Error).message}`);
      else res.end();
    } finally {
      const usage = extractUsage(tail);
      release(usage ? usage.inputTokens + usage.outputTokens : undefined);
      opts.onUsage?.({
        poolId,
        path,
        status,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        latencyMs: Date.now() - started,
      });
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://${opts.host ?? '127.0.0.1'}:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
