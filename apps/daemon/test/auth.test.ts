// Who may call the daemon (master plan 6.6, remote prerequisites): the token, Host and Origin checks, and
// catching a reconnecting client up from the events log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonEvent, LiveMessage } from '@ih/core';
import { checkRequest, loadApiToken, type AuthOptions, type RequestFacts } from '../src/auth.ts';
import { REPLAY_LIMIT } from '../src/server.ts';
import { setup } from './harness.ts';

const TOKEN = 'secret-token';
const opts = (o: Partial<AuthOptions> = {}): AuthOptions => ({ token: TOKEN, requireToken: false, loopbackBound: true, allowedHosts: [], ...o });
const facts = (f: Partial<RequestFacts> = {}): RequestFacts => ({ path: '/api/boards', remote: '127.0.0.1', host: '127.0.0.1:7420', origin: undefined, authorization: undefined, queryToken: undefined, ...f });

test('access rules: a local caller needs nothing, another machine needs the token, a wrong token never passes', () => {
  assert.equal(checkRequest(opts(), facts()), null, 'local, no token');
  assert.equal(checkRequest(opts(), facts({ host: 'localhost:7420' })), null);
  assert.equal(checkRequest(opts(), facts({ host: '[::1]:7420' })), null);
  assert.deepEqual(checkRequest(opts(), facts({ remote: '10.0.0.5' })), { status: 401, error: 'token required' });
  assert.equal(checkRequest(opts(), facts({ remote: '10.0.0.5', authorization: `Bearer ${TOKEN}` })), null);
  assert.deepEqual(checkRequest(opts(), facts({ authorization: 'Bearer nope' })), { status: 401, error: 'invalid token' }, 'wrong token from a local caller is refused too');
  assert.deepEqual(checkRequest(opts(), facts({ authorization: 'Bearer short' })), { status: 401, error: 'invalid token' });
  assert.equal(checkRequest(opts(), facts({ remote: '::ffff:127.0.0.1' })), null, 'an IPv4-mapped loopback address is loopback');
});

test('access rules: required everywhere on request, but only for the operator surface', () => {
  const strict = opts({ requireToken: true });
  assert.deepEqual(checkRequest(strict, facts()), { status: 401, error: 'token required' });
  assert.deepEqual(checkRequest(strict, facts({ path: '/ws' })), { status: 401, error: 'token required' });
  assert.equal(checkRequest(strict, facts({ authorization: `Bearer ${TOKEN}` })), null);
  // Agents on this machine have no token: the board MCP server, telemetry, Claude's own hook, health and the web files stay open locally.
  for (const path of ['/mcp', '/v1/metrics', '/hooks/claude', '/api/health', '/', '/assets/index.js']) assert.equal(checkRequest(strict, facts({ path })), null, path);
  // ...but not from another machine (health and static files excepted).
  assert.deepEqual(checkRequest(strict, facts({ path: '/mcp', remote: '10.0.0.5' })), { status: 401, error: 'token required' });
  assert.equal(checkRequest(strict, facts({ path: '/api/health', remote: '10.0.0.5' })), null);
});

test('access rules: a web page on another site cannot drive a local daemon', () => {
  // DNS rebinding: the page's own domain now resolves to 127.0.0.1, so Host names it.
  assert.deepEqual(checkRequest(opts(), facts({ host: 'evil.example:7420' })), { status: 403, error: 'unexpected Host header' });
  assert.equal(checkRequest(opts({ allowedHosts: ['workbox.lan'] }), facts({ host: 'workbox.lan:7420' })), null, 'unless listed');
  // Cross-site request (and cross-site WebSocket, which has no preflight): Origin differs from Host.
  assert.deepEqual(checkRequest(opts(), facts({ origin: 'https://evil.example' })), { status: 403, error: 'cross-origin request refused' });
  assert.deepEqual(checkRequest(opts(), facts({ path: '/ws/terminal/c_1', origin: 'http://localhost:9999' })), { status: 403, error: 'cross-origin request refused' });
  assert.equal(checkRequest(opts(), facts({ origin: 'http://127.0.0.1:7420' })), null, 'the daemon\'s own web UI');
  assert.equal(checkRequest(opts(), facts({ host: 'localhost:5173', origin: 'http://localhost:5173' })), null, 'the dev server proxying to it');
  // With the token, the page would have had to read it from somewhere it cannot.
  assert.equal(checkRequest(opts(), facts({ origin: 'https://evil.example', authorization: `Bearer ${TOKEN}` })), null);
  // A daemon deliberately listening beyond loopback is guarded by the token alone.
  assert.equal(checkRequest(opts({ loopbackBound: false }), facts({ host: '192.168.1.5:7420', remote: '127.0.0.1' })), null);
  assert.deepEqual(checkRequest(opts({ loopbackBound: false }), facts({ host: '192.168.1.5:7420', remote: '192.168.1.9' })), { status: 401, error: 'token required' });
});

test('the query token is accepted on WebSockets only', () => {
  assert.equal(checkRequest(opts(), facts({ path: '/ws', remote: '10.0.0.5', queryToken: TOKEN })), null);
  assert.equal(checkRequest(opts(), facts({ path: '/ws/terminal/c_1', remote: '10.0.0.5', queryToken: TOKEN })), null);
  assert.deepEqual(checkRequest(opts(), facts({ path: '/api/boards', remote: '10.0.0.5', queryToken: TOKEN })), { status: 401, error: 'token required' }, 'tokens in REST URLs would end up in logs');
});

test('the token is generated once, kept private, and overridable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ih-token-'));
  const file = join(dir, 'nested', 'api-token');
  const first = loadApiToken(file, {});
  assert.match(first, /^[0-9a-f]{48}$/);
  assert.equal(statSync(file).mode & 0o777, 0o600, 'readable by this user only');
  assert.equal(loadApiToken(file, {}), first, 'the same token next time');
  assert.equal(loadApiToken(file, { IH_API_TOKEN: ' from-env ' }), 'from-env');
  assert.ok(existsSync(file));
});

/** A GET with chosen headers (fetch will not let a test spoof Host or Origin). */
function get(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the server applies the rules to REST and WebSocket requests, and /api/health says what it asks for', async () => {
  const t = await setup({ auth: opts({ requireToken: true }) });
  try {
    const url = `http://127.0.0.1:${t.cfg.port}`;
    assert.deepEqual(await (await fetch(`${url}/api/health`)).json(), { ok: true, auth: 'token' });
    assert.equal((await fetch(`${url}/api/boards`)).status, 401);
    assert.equal((await fetch(`${url}/api/boards`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    const ok = await fetch(`${url}/api/boards`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { id: string }[])[0]?.id, t.board.id);

    // A page on another site, even with the browser's own Host.
    const cross = await get(t.cfg.port, '/api/boards', { host: `127.0.0.1:${t.cfg.port}`, origin: 'https://evil.example', authorization: '' });
    assert.equal(cross.status, 403);

    // WebSocket: refused without the token, open with it in the query.
    const refused = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${t.cfg.port}/ws`);
      ws.onopen = () => resolve('open');
      ws.onerror = () => resolve('refused');
    });
    assert.equal(refused, 'refused');
    const accepted = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${t.cfg.port}/ws?token=${TOKEN}`);
      ws.onopen = () => (ws.close(), resolve('open'));
      ws.onerror = () => resolve('refused');
    });
    assert.equal(accepted, 'open');
  } finally {
    await t.close();
  }
});

type Msg = DaemonEvent | LiveMessage;
/** Connects to /ws with a query and collects messages until `done` says enough. */
function listen(port: number, query: string, done: (all: Msg[]) => boolean, ms = 5000): Promise<{ all: Msg[]; ws: WebSocket }> {
  return new Promise((resolve, reject) => {
    const all: Msg[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`);
    const timer = setTimeout(() => reject(new Error(`timed out; got ${JSON.stringify(all.map((m) => ('live' in m ? m.type : m.seq)))}`)), ms);
    ws.onmessage = (m) => {
      all.push(JSON.parse(String(m.data)) as Msg);
      if (done(all)) {
        clearTimeout(timer);
        resolve({ all, ws });
      }
    };
    ws.onerror = () => reject(new Error('socket error'));
  });
}
const isStatus = (m: Msg): m is LiveMessage => 'live' in m && m.type === 'stream.status';

test('a reconnecting client is caught up from the events log, in order, then goes live without a gap or a repeat', async () => {
  const t = await setup();
  try {
    const first = t.store.createCard({ boardId: t.board.id, title: 'one' });
    const seen = t.store.lastEventSeq();
    const second = t.store.createCard({ boardId: t.board.id, title: 'two' });
    t.store.createCard({ boardId: t.board.id, title: 'three' });
    assert.ok(t.store.lastEventSeq() > seen);

    const { all, ws } = await listen(t.cfg.port, `?since=${seen}`, (a) => a.some(isStatus));
    // (Context capture saves artifacts a moment after a card is created, so the log can grow while we connect: trust what the daemon reports.)
    const status = all.at(-1)!;
    assert.ok(isStatus(status), 'the status message comes after the replay');
    const { latest, replayed, lost } = status.payload as { latest: number; replayed: number; lost: string | null };
    const events = all.filter((m): m is DaemonEvent => !('live' in m));
    assert.equal(lost, null);
    assert.equal(replayed, events.length);
    assert.deepEqual(events.map((e) => e.seq), Array.from({ length: latest - seen }, (_, i) => seen + 1 + i), 'exactly the events after `since`, oldest first');
    assert.ok(events.some((e) => e.type === 'card.created' && e.subject === second.id));
    assert.ok(!events.some((e) => e.subject === first.id), 'nothing from before');

    // And then it is live.
    const live = new Promise<DaemonEvent[]>((resolve) => {
      const got: DaemonEvent[] = [];
      ws.addEventListener('message', (m) => {
        got.push(JSON.parse(String(m.data)) as DaemonEvent);
        if (got.some((e) => e.type === 'card.created')) resolve(got);
      });
    });
    const fourth = t.store.createCard({ boardId: t.board.id, title: 'four' });
    const got = await live;
    assert.equal(got[0]!.seq, latest + 1, 'the very next event, nothing skipped');
    assert.deepEqual(got.map((e) => e.seq), got.map((_, i) => latest + 1 + i), 'in order');
    assert.ok(got.some((e) => e.type === 'card.created' && e.subject === fourth.id));
    ws.close();
  } finally {
    await t.close();
  }
});

test('since=now only reports where the log is; a position the daemon cannot honour says the client must reload', async () => {
  const t = await setup();
  try {
    t.store.createCard({ boardId: t.board.id, title: 'one' });
    const latest = t.store.lastEventSeq();
    const now = await listen(t.cfg.port, '?since=now', (a) => a.length >= 1);
    assert.equal(now.all.length, 1, 'no replay');
    assert.deepEqual(isStatus(now.all[0]!) ? now.all[0]!.payload : null, { latest, replayed: 0, lost: null });
    now.ws.close();

    const ahead = await listen(t.cfg.port, `?since=${latest + 50}`, (a) => a.length >= 1);
    assert.deepEqual(isStatus(ahead.all[0]!) ? ahead.all[0]!.payload : null, { latest, replayed: 0, lost: 'ahead' }, 'the log was replaced since the client last connected');
    ahead.ws.close();

    const junk = await listen(t.cfg.port, '?since=abc', (a) => a.length >= 1);
    assert.equal(isStatus(junk.all[0]!) ? (junk.all[0]!.payload as { lost: string }).lost : null, 'invalid');
    junk.ws.close();

    // Without the parameter nothing changes: no status message, only live events.
    const plain = await listen(t.cfg.port, '', () => false, 200).catch((e: Error) => e);
    assert.ok(plain instanceof Error, 'a plain connection receives nothing until something happens');

    for (let i = 0; i <= REPLAY_LIMIT; i++) t.store.append('card.narrated', 'bulk', { i });
    const far = await listen(t.cfg.port, '?since=0', (a) => a.length >= 1);
    const payload = (isStatus(far.all[0]!) ? far.all[0]!.payload : null) as { replayed: number; lost: string };
    assert.deepEqual([payload.replayed, payload.lost], [0, 'too_many'], 'too long a gap is not replayed piecemeal');
    far.ws.close();
  } finally {
    await t.close();
  }
});

test('agents reach the board server with their own session token, with the access layer switched on', async () => {
  // Found live: the layer treated any Bearer token that was not the API token as wrong, which refused every agent.
  assert.equal(checkRequest(opts(), facts({ path: '/mcp', authorization: 'Bearer some-session-token' })), null, 'a local agent with its session token');
  assert.equal(checkRequest(opts({ requireToken: true }), facts({ path: '/mcp', authorization: 'Bearer some-session-token' })), null, 'also when the API token is required for people');
  assert.equal(checkRequest(opts(), facts({ path: '/v1/metrics', authorization: 'Bearer anything' })), null, 'and telemetry');
  assert.deepEqual(checkRequest(opts(), facts({ path: '/mcp', authorization: 'Bearer some-session-token', remote: '10.0.0.5' })), { status: 401, error: 'token required' }, 'but not from another machine');
  assert.equal(checkRequest(opts(), facts({ path: '/mcp', authorization: `Bearer ${TOKEN}`, remote: '10.0.0.5' })), null, 'unless it has the API token');
  assert.deepEqual(checkRequest(opts(), facts({ path: '/mcp', authorization: 'Bearer some-session-token', host: 'evil.example' })), { status: 403, error: 'unexpected Host header' }, 'a rebinding page still cannot');
  // The operator surface is as strict as ever: a session token is not the API token.
  assert.deepEqual(checkRequest(opts(), facts({ path: '/api/boards', authorization: 'Bearer some-session-token' })), { status: 401, error: 'invalid token' });

  // End to end: a card's agent calls a board tool through the real access layer.
  const t = await setup({ auth: opts({ requireToken: true }) });
  try {
    const card = t.store.createCard({ boardId: t.board.id, title: 'x', description: 'y' });
    await t.runner.run(card.id, 'fa', { agentId: 'fa' });
    const token = (t.runner as unknown as { active: Map<string, { token: string }> }).active.get(card.id)!.token;
    const call = (authorization: string) =>
      fetch(`http://127.0.0.1:${t.cfg.port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }),
      });
    const ok = await call(`Bearer ${token}`);
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /Demo/);
    const bad = await call('Bearer not-a-session');
    assert.equal(bad.status, 401);
    assert.match(await bad.text(), /unknown or expired board session token/, 'refused by the board server itself, not as an invalid API token');
  } finally {
    await t.close();
  }
});
