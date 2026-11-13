import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { RateLimiter, extractUsage, startGateway } from '../src/index.ts';

test('limiter: warn at 80%, halt at 95%, queue until the window frees', async () => {
  let now = 0;
  const limiter = new RateLimiter({ now: () => now, minuteMs: 1000 });
  limiter.configure('nim', { rpm: 40 });

  for (let i = 0; i < 32; i++) (await limiter.acquire('nim'))();
  assert.equal(limiter.status('nim').state, 'warn'); // 32/40 = 80%
  for (let i = 0; i < 6; i++) (await limiter.acquire('nim'))();
  assert.equal(limiter.status('nim').state, 'halted'); // 38/40 = 95%, the cap

  let admitted = false;
  const waiting = limiter.acquire('nim').then((release) => {
    admitted = true;
    release();
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(admitted, false);
  assert.equal(limiter.status('nim').queued, 1);

  now = 1001; // the whole window has rolled over
  await waiting;
  assert.equal(admitted, true);
  assert.equal(limiter.status('nim').windows[0]!.used, 1);
});

test('limiter: a forced percentage sets the pool state alongside reported windows, and clears', () => {
  const limiter = new RateLimiter();
  const seen: string[] = [];
  limiter.onChange((s) => seen.push(`${s.poolId}:${s.state}`));
  limiter.report('claude', [{ window: '5h', pct: 20 }]);
  limiter.force('claude', 95);
  assert.equal(limiter.status('claude').state, 'halted');
  assert.deepEqual(limiter.status('claude').windows.map((w) => w.window), ['5h', 'forced']);
  limiter.report('claude', [{ window: '5h', pct: 25 }]); // a status-line update does not clear the override
  assert.equal(limiter.status('claude').state, 'halted');
  limiter.force('claude', 85);
  assert.equal(limiter.status('claude').state, 'warn');
  limiter.force('claude', null);
  assert.equal(limiter.status('claude').state, 'open');
  // Observed lockouts work on pools the limiter has never seen (subscription pools have no counted limits).
  limiter.lock('kimi', Date.now() + 60_000);
  assert.equal(limiter.status('kimi').state, 'locked');
  assert.deepEqual(seen, ['claude:open', 'claude:halted', 'claude:warn', 'claude:open', 'kimi:locked']);
});

test('limiter: concurrency caps and locks', async () => {
  let now = 0;
  const limiter = new RateLimiter({ now: () => now, minuteMs: 1000 });
  limiter.configure('local', { concurrency: 1 });
  const first = await limiter.acquire('local');
  let second = false;
  const pending = limiter.acquire('local').then((r) => {
    second = true;
    return r;
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(second, false);
  first();
  (await pending)();
  assert.equal(second, true);

  limiter.configure('groq', { tpm: 8000 });
  limiter.lock('groq', 500);
  assert.equal(limiter.status('groq').state, 'locked');
  now = 501;
  assert.equal(limiter.status('groq').state, 'open');
});

test('extractUsage reads JSON and the last SSE usage chunk', () => {
  assert.deepEqual(extractUsage('{"id":"x","usage":{"prompt_tokens":10,"completion_tokens":5}}'), { inputTokens: 10, outputTokens: 5 });
  const sse = 'data: {"choices":[{"delta":{"content":"hi"}}],"usage":null}\n\ndata: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}\n\ndata: [DONE]\n\n';
  assert.deepEqual(extractUsage(sse), { inputTokens: 7, outputTokens: 3 });
  assert.equal(extractUsage('no usage here'), null);
  const nested = '{"usage":{"prompt_tokens":277,"completion_tokens":62,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":34}}}';
  assert.deepEqual(extractUsage(nested), { inputTokens: 277, outputTokens: 62 });
});

test('gateway: auth, key swap, usage, 429 lock, and pacing a burst', async () => {
  const seen: { auth?: string; ua?: string; body: string }[] = [];
  let reply429 = false;
  const upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization, ua: req.headers['user-agent'], body });
      if (reply429) {
        res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' });
        return res.end('{"error":"slow down"}');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;

  const limiter = new RateLimiter({ minuteMs: 400 });
  limiter.configure('nim', { rpm: 40 });
  const usage: number[] = [];
  const gw = await startGateway({
    limiter,
    token: 'local-token',
    pools: [{ id: 'nim', baseUrl: base, apiKey: 'real-key' }],
    onUsage: (u) => usage.push(u.inputTokens + u.outputTokens),
  });
  const call = (token = 'local-token', body: object = { model: 'm', messages: [], stream: true }) =>
    fetch(`${gw.url}/p/nim/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  try {
    assert.equal((await call('wrong')).status, 401);
    assert.equal((await fetch(`${gw.url}/p/nope/v1/models`, { headers: { authorization: 'Bearer local-token' } })).status, 404);

    const ok = await call();
    assert.equal(ok.status, 200);
    await ok.text();
    assert.equal(seen[0]!.auth, 'Bearer real-key');
    assert.equal(seen[0]!.ua, 'infinity-harness/0.1');
    assert.deepEqual(JSON.parse(seen[0]!.body).stream_options, { include_usage: true });
    assert.deepEqual(usage, [16]);

    // Burst of 45: 37 more fit under the 38-request cap; the rest wait for the 400 ms window to roll.
    const started = Date.now();
    const statuses = await Promise.all(Array.from({ length: 45 }, () => call().then((r) => r.status)));
    const elapsed = Date.now() - started;
    assert.ok(statuses.every((s) => s === 200));
    assert.ok(elapsed >= 300, `burst should have been paced, took ${elapsed} ms`);
    assert.ok(limiter.status('nim').windows[0]!.used <= 38);

    reply429 = true;
    assert.equal((await call()).status, 429);
    assert.equal(limiter.status('nim').state, 'locked');
  } finally {
    await gw.close();
    upstream.close();
  }
});
