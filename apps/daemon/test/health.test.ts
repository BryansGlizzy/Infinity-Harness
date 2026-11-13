// Pool health: is the model answering, and what happens when it stops (no blame, out of rotation until restored).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from '@ih/core';
import { Store } from '@ih/db';
import { KevClient } from '@ih/router';
import { PROVIDER_DOWN_PATTERN, PoolHealth } from '../src/health.ts';
import { setup } from './harness.ts';

const pools: Pool[] = [
  { id: 'local', label: 'Local LLM', harness: 'opencode', model: 'local/qwen', kind: 'local' },
  { id: 'claude', label: 'Claude', harness: 'claude', model: 'sonnet', kind: 'subscription' },
];
const upstreams = [{ id: 'local', baseUrl: 'http://127.0.0.1:9/v1/', apiKey: 'k' }];

function health(store: Store, fetcher: typeof fetch, extra: Partial<ConstructorParameters<typeof PoolHealth>[0]> = {}) {
  return new PoolHealth({ store, pools, upstreams, probeHarness: async () => ['m'], fetch: fetcher, ...extra });
}

test('the provider-down pattern catches an unreachable provider and nothing that is the model\'s doing', () => {
  for (const m of ['Internal error: upstream error: fetch failed', 'connect ECONNREFUSED 127.0.0.1:8080', '502 Bad Gateway', 'socket hang up', 'service unavailable', 'gateway_error']) {
    assert.ok(PROVIDER_DOWN_PATTERN.test(m), m);
  }
  for (const m of ['Blocked: missing API key', 'tests failed: 2 of 10', 'could not edit src/app.ts', 'rate limit reached (429)']) assert.ok(!PROVIDER_DOWN_PATTERN.test(m), m);
});

test('check: an answering endpoint is online with its latency, a refused key is said so, a dead one is offline with the reason', async () => {
  const store = new Store(':memory:');
  let mode: 'ok' | 'auth' | 'down' | 'bad' = 'ok';
  const seen: string[] = [];
  const h = health(store, (async (url: string, init?: RequestInit) => {
    seen.push(`${url} ${JSON.stringify(init?.headers)}`);
    if (mode === 'down') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    return new Response('{}', { status: mode === 'auth' ? 401 : mode === 'bad' ? 502 : 200 });
  }) as typeof fetch);

  assert.equal(h.view('local').reachable, 'unknown');
  const up = await h.check('local');
  assert.deepEqual([up.reachable, up.checked, up.detail], ['online', 'endpoint', null]);
  assert.ok(up.latencyMs !== null && up.checkedAt);
  assert.match(seen[0]!, /^http:\/\/127\.0\.0\.1:9\/v1\/models .*Bearer k/, 'the models endpoint, with the key');

  mode = 'auth';
  assert.match((await h.check('local')).detail!, /rejected the key \(401\)/);
  assert.equal(h.view('local').reachable, 'online', 'a refused key is not an outage');
  mode = 'bad';
  assert.equal((await h.check('local')).reachable, 'offline');
  mode = 'down';
  const down = await h.check('local');
  assert.deepEqual([down.reachable, down.latencyMs], ['offline', null]);
  assert.match(down.detail!, /fetch failed \(ECONNREFUSED\)/);
  // A harness pool is checked by starting the harness.
  mode = 'ok';
  const slow = health(store, (async () => Promise.reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))) as typeof fetch, { endpointTimeoutMs: 3000 });
  assert.equal((await slow.check('local')).detail, 'no answer within 3 s', 'a timeout says how long it waited');
  assert.deepEqual([(await h.check('claude')).reachable, h.view('claude').checked], ['online', 'harness']);
  const broken = health(store, (async () => new Response('{}')) as typeof fetch, { probeHarness: async () => Promise.reject(new Error('not logged in')) });
  assert.match((await broken.check('claude')).detail!, /not logged in/);
});

test('suspect: a failure on an endpoint pool is checked, and only a real outage takes the pool out of rotation until restored', async () => {
  const store = new Store(':memory:');
  let up = true;
  const told: string[] = [];
  const h = health(store, (async () => {
    if (!up) throw new TypeError('fetch failed');
    return new Response('{}');
  }) as typeof fetch, { notify: (id, reason) => told.push(`${id}: ${reason}`) });

  assert.equal(await h.suspect('local', 'upstream error: fetch failed'), false, 'one failed run, but the endpoint answers: not an outage');
  assert.equal(h.ejection('local'), null);
  assert.equal(await h.suspect('claude', 'fetch failed'), false, 'subscription harnesses are left to the stall watchdog and lockouts');

  up = false;
  assert.equal(await h.suspect('local', 'upstream error: fetch failed'), true);
  assert.match(h.ejection('local')!.reason, /fetch failed/);
  assert.equal(h.view('local').ejected?.reason, h.ejection('local')!.reason);
  assert.equal(told.length, 1);
  assert.equal(await h.suspect('local', 'again'), false, 'already out: said once');
  assert.equal(told.length, 1);
  assert.ok(store.eventsFor('local').some((e) => e.type === 'pool.ejected'));

  // Coming back up does not put it back: a person does.
  up = true;
  assert.equal((await h.check('local')).reachable, 'online');
  assert.ok(h.view('local').ejected, 'still out of rotation');
  assert.equal(h.restore('local'), true);
  assert.equal(h.ejection('local'), null);
  assert.equal(h.restore('local'), false);
  assert.ok(store.eventsFor('local').some((e) => e.type === 'pool.restored'));
});

test('ejections survive a restart', () => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/ih-health-${process.pid}.db`;
  const first = new Store(dir);
  first.ejectPool('local', 'down');
  first.close();
  const again = new Store(dir);
  assert.deepEqual(again.poolEjections().map((e) => [e.poolId, e.reason]), [['local', 'down']]);
  again.close();
});

test('a run that failed because the provider was unreachable is not held against the model', async () => {
  const kev = new KevClient({ url: 'http://kev', model: 'kev-9b', fetch: (async () => new Response(JSON.stringify({ answers: { quality: { score: 3 }, in_scope: { noul: 0.9 } } }))) as typeof fetch });
  const { store, scheduler, refinery, board, close } = await setup({ outcomeKev: kev });
  try {
    store.updateSettings(board.id, {
      agents: [
        { id: 'fa', poolId: 'fa', model: 'fake/one', role: 'worker', delegatesTo: [], enabled: true },
        { id: 'fb', poolId: 'fb', model: 'fake/two', role: 'worker', delegatesTo: [], enabled: true },
      ],
      crossReview: false,
      testCommand: 'test -f notes.md',
      landMode: 'local',
      scarcity: { fa: 1, fb: 0.95 },
    });
    const description = ['Do the thing.', 'FAIL[fake/one]', 'FAILMSG(Internal error: upstream error: fetch failed)'].join('\n');
    const card = store.createCard({ boardId: board.id, title: 'Unlucky card', description, status: 'ready', workType: 'feature' });
    store.updateCard(card.id, { classification: { workType: 'feature', workTypeProbs: {}, complexity: 1, complexityProbs: {}, needsReview: 0, source: 'kev', at: '' } });
    scheduler.start();
    refinery.start();
    const deadline = Date.now() + 40_000;
    while (store.getCard(card.id)!.status !== 'done') {
      if (Date.now() > deadline) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 100));
    }
    if (process.env.DEBUG_HEALTH) console.log(store.getCard(card.id)!.status, store.listSessions(card.id).map((s) => [s.poolId, s.state]), store.eventsFor(card.id).filter((e) => e.type !== 'session.event').map((e) => e.type + ' ' + JSON.stringify(e.payload).slice(0, 160)));
    assert.deepEqual(store.listSessions(card.id).map((s) => s.poolId), ['fa', 'fb'], 'the card moved on to another agent');
    const results = store.outcomesFor(card.id).map((o) => [o.agentId, o.result]);
    assert.ok(!results.some(([a, r]) => a === 'fa' && r === 'failed_run'), `fa was not marked as failing: ${JSON.stringify(results)}`);
  } finally {
    await close();
  }
});

test('the pools API shows health, tests a pool, and an ejected pool is out of routing until restored', async () => {
  const { store, scheduler, board, cfg, health: h, close } = await setup();
  try {
    const api = async (method: string, path: string) => (await fetch(`http://127.0.0.1:${cfg.port}/api${path}`, { method })).json() as Promise<any>;
    store.updateSettings(board.id, { agents: [{ id: 'fa', poolId: 'fa', model: 'fake/one', role: 'worker', delegatesTo: [], enabled: true }, { id: 'fb', poolId: 'fb', model: 'fake/two', role: 'worker', delegatesTo: [], enabled: true }] });
    const card = store.createCard({ boardId: board.id, title: 'Some card', status: 'backlog', workType: 'feature' });

    const before = (await api('GET', '/pools')).find((p: any) => p.id === 'fa');
    assert.equal(before.health.reachable, 'unknown');
    const tested = await api('POST', '/pools/fa/test');
    assert.deepEqual([tested.reachable, tested.checked, tested.ejected], ['online', 'harness', null]);
    assert.equal((await api('GET', '/pools')).find((p: any) => p.id === 'fa').health.reachable, 'online');

    assert.ok(h.eject('fa', 'upstream error: fetch failed'));
    const out = (await api('GET', '/pools')).find((p: any) => p.id === 'fa');
    assert.match(out.health.ejected.reason, /fetch failed/);
    const ranked = scheduler.rank(store.getCard(card.id)!);
    const fa = ranked.find((c) => c.agentId === 'fa')!;
    assert.equal(fa.eligible, false);
    assert.match(fa.reasons.join(), /offline: upstream error: fetch failed/);
    assert.equal(ranked.find((c) => c.agentId === 'fb')!.eligible, true, 'the other pool still takes cards');

    const back = await api('POST', '/pools/fa/restore');
    assert.equal(back.ejected, null);
    assert.equal(scheduler.rank(store.getCard(card.id)!).find((c) => c.agentId === 'fa')!.eligible, true);
    assert.equal((await fetch(`http://127.0.0.1:${cfg.port}/api/pools/nope/test`, { method: 'POST' })).status, 404);
  } finally {
    await close();
  }
});

test('a pool taken out of rotation hands its running card to another agent, with no failure on record', async () => {
  const { store, scheduler, runner, health: h, board, close } = await setup();
  try {
    store.updateSettings(board.id, {
      agents: [
        { id: 'fa', poolId: 'fa', model: 'fake/one', role: 'worker', delegatesTo: [], enabled: true },
        { id: 'fb', poolId: 'fb', model: 'fake/two', role: 'worker', delegatesTo: [], enabled: true },
      ],
      crossReview: false,
      testCommand: 'test -f notes.md',
      landMode: 'local',
      scarcity: { fa: 1, fb: 0.95 },
    });
    const card = store.createCard({ boardId: board.id, title: 'SLOW card on a dying pool', description: 'SLOW', status: 'ready', workType: 'feature' });
    store.updateCard(card.id, { classification: { workType: 'feature', workTypeProbs: {}, complexity: 1, complexityProbs: {}, needsReview: 0, source: 'kev', at: '' } });
    scheduler.start();
    const wait = async (ok: () => boolean) => {
      const deadline = Date.now() + 30_000;
      while (!ok()) {
        if (Date.now() > deadline) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    await wait(() => store.getCard(card.id)!.status === 'in_progress' && store.getCard(card.id)!.poolId === 'fa');
    await new Promise((r) => setTimeout(r, 300)); // the turn is busy
    h.eject('fa', 'no answer');
    runner.evictPool('fa', 'no answer');
    await wait(() => store.listSessions(card.id).some((s) => s.poolId === 'fb'));
    const sessions = store.listSessions(card.id);
    assert.deepEqual(sessions.slice(0, 2).map((s) => s.poolId), ['fa', 'fb']);
    assert.equal(sessions[0]!.state, 'failed', 'the first session was closed, not left running')
    assert.ok(store.eventsFor(card.id).some((e) => e.type === 'session.event' && /went offline \(no answer\)/.test(JSON.stringify(e.payload))), 'the card says why it moved');
    assert.equal(store.outcomesFor(card.id).filter((o) => o.result === 'failed_run').length, 0);
  } finally {
    await close();
  }
});
