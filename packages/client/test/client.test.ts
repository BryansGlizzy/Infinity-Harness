import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { DaemonEvent, LiveMessage } from '@ih/core';
import { DaemonApi, DaemonHttp, EventStream, HttpError, REPLAY_WITHIN_MS, type StreamMessage } from '../src/index.ts';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('DaemonHttp: JSON in and out, the token on every request, HttpError for failures', async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const http = new DaemonHttp({
    baseUrl: 'http://127.0.0.1:7420',
    token: 'abc',
    fetch: (async (url: URL, init: RequestInit) => {
      seen.push({ url: String(url), init });
      return url.pathname === '/api/missing' ? json(404, { error: 'no such thing' }) : json(200, { ok: true });
    }) as unknown as typeof fetch,
  });
  assert.deepEqual(await http.call('POST', '/api/x', { a: 1 }), { ok: true });
  assert.equal(seen[0]!.url, 'http://127.0.0.1:7420/api/x');
  assert.equal(seen[0]!.init.body, '{"a":1}');
  assert.deepEqual(seen[0]!.init.headers, { 'content-type': 'application/json', authorization: 'Bearer abc' });
  await http.call('GET', '/api/y');
  assert.deepEqual(seen[1]!.init.headers, { authorization: 'Bearer abc' }, 'no content type without a body');
  await assert.rejects(http.call('GET', '/api/missing'), (e: unknown) => e instanceof HttpError && e.status === 404 && e.message === 'no such thing');
  assert.equal(http.wsUrl('/ws/terminal/c_1'), 'ws://127.0.0.1:7420/ws/terminal/c_1?token=abc');
  http.token = '';
  assert.equal(http.wsUrl('/ws'), 'ws://127.0.0.1:7420/ws', 'no token, nothing added');
  assert.equal(new DaemonHttp({ baseUrl: 'https://box.example' }).wsUrl('/ws'), 'wss://box.example/ws');
});

test('DaemonHttp: a 401 asks for the token once and repeats the request; a provider is read on each call', async () => {
  let current = '';
  const calls: (string | undefined)[] = [];
  let asked = 0;
  const http = new DaemonHttp({
    baseUrl: 'http://x',
    tokenProvider: () => current,
    onUnauthorized: async () => {
      asked++;
      current = 'good';
      return true;
    },
    fetch: (async (_u: URL, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).authorization;
      calls.push(auth);
      return auth === 'Bearer good' ? json(200, { fine: 1 }) : json(401, { error: 'token required' });
    }) as unknown as typeof fetch,
  });
  assert.deepEqual(await http.call('GET', '/api/a'), { fine: 1 });
  assert.deepEqual(calls, [undefined, 'Bearer good']);
  assert.equal(asked, 1);
  await http.call('GET', '/api/b');
  assert.equal(asked, 1, 'now it has the token');

  const refusing = new DaemonHttp({ baseUrl: 'http://x', onUnauthorized: async () => false, fetch: (async () => json(401, { error: 'invalid token' })) as unknown as typeof fetch });
  await assert.rejects(refusing.call('GET', '/api/a'), (e: unknown) => e instanceof HttpError && e.status === 401 && e.message === 'invalid token');
});

test('DaemonApi: endpoints, query strings, per-call timeouts, health', async () => {
  const log: string[] = [];
  const api = new DaemonApi(
    new DaemonHttp({
      baseUrl: 'http://x',
      fetch: (async (url: URL, init: RequestInit) => {
        log.push(`${init.method} ${url.pathname}${url.search} ${init.body ?? ''}`.trim());
        return url.pathname === '/api/health' ? json(200, { ok: true, auth: 'local' }) : json(200, []);
      }) as unknown as typeof fetch,
    }),
  );
  await api.cards('b_1');
  await api.file('c_1', 'a b.ts', 'from');
  await api.file('c_1', 'a.ts');
  await api.review('c_1', 'changes', 'fix it', [{ path: 'a.ts', line: 3, body: 'why' }]);
  await api.review('c_1', 'approve');
  await api.models(true);
  const detached = api.approvals;
  await detached('b_1');
  assert.deepEqual(log, [
    'GET /api/boards/b_1/cards',
    'GET /api/cards/c_1/file?path=a+b.ts&side=from',
    'GET /api/cards/c_1/file?path=a.ts',
    'POST /api/cards/c_1/review {"verdict":"changes","notes":"fix it","comments":[{"path":"a.ts","line":3,"body":"why"}]}',
    'POST /api/cards/c_1/review {"verdict":"approve","notes":""}',
    'GET /api/models?refresh=1',
    'GET /api/boards/b_1/approvals?status=pending',
  ]);
  assert.equal(await api.healthy(), true);
  assert.deepEqual(await api.health(), { ok: true, auth: 'local' });
  assert.equal(await new DaemonApi(new DaemonHttp({ baseUrl: 'http://127.0.0.1:9' })).healthy(), false);
  api.baseUrl = 'http://y';
  assert.equal(api.http.baseUrl, 'http://y');
});

/** A WebSocket the test drives by hand. */
class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }
  open() {
    this.onopen?.();
  }
  send(m: StreamMessage) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  close() {
    this.onclose?.();
  }
}
const ev = (seq: number): DaemonEvent => ({ seq, ts: '', actor: 'daemon', type: 'card.created', subject: 'c', payload: {} });
const status = (latest: number, replayed = 0, lost: string | null = null): LiveMessage => ({ live: true, type: 'stream.status', subject: 'events', payload: { latest, replayed, lost }, ts: '' });
const since = (s: FakeSocket) => new URL(s.url).searchParams.get('since');

test('EventStream: first connection asks for the position only; a reconnect resumes after the last event; a long absence reloads', () => {
  const RealWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  FakeSocket.all = [];
  let now = 1_000_000;
  mock.method(Date, 'now', () => now);
  const got: StreamMessage[] = [];
  let resyncs = 0;
  const states: boolean[] = [];
  try {
    const stream = new EventStream(() => 'ws://x/ws', (m) => got.push(m), (c) => states.push(c), () => resyncs++);
    const first = FakeSocket.all[0]!;
    assert.equal(since(first), 'now', 'nothing seen yet');
    first.open();
    first.send(status(40));
    first.send(ev(41));
    first.send(ev(43));
    first.send(ev(42));
    assert.equal(stream.position, 43, 'the highest seen, even if delivered out of order');

    first.close();
    now += 60_000;
    stream.reconnect();
    const second = FakeSocket.all[1]!;
    assert.equal(since(second), '43', 'replay from the last event');
    second.open();
    assert.equal(resyncs, 0);
    second.send(status(50, 7));
    assert.equal(stream.position, 50);

    // Away for longer than the replay window: no replay, and the caller is told to reload once it is back.
    second.close();
    now += REPLAY_WITHIN_MS + 1;
    stream.reconnect();
    const third = FakeSocket.all[2]!;
    assert.equal(since(third), 'now');
    assert.equal(resyncs, 0, 'not until it is connected');
    third.open();
    assert.equal(resyncs, 1);
    third.send(status(900));

    // The daemon says it could not replay.
    third.send(status(900, 0, 'too_many'));
    assert.equal(resyncs, 2);
    assert.deepEqual(states, [true, false, true, false, true]);
    stream.dispose();
  } finally {
    globalThis.WebSocket = RealWebSocket;
    mock.restoreAll();
  }
});
