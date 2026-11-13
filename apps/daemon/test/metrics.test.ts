// Phase 6.3: telemetry in, usage attributed to cards and agents, metrics rolled up the card tree, budgets in the limiter,
// pool usage history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '@ih/db';
import { RateLimiter } from '@ih/gateway';
import { claudeTelemetryEnv, usageFrom } from '@ih/adapters';
import { DEFAULT_SETTINGS } from '@ih/core';
import { Budgets, budgetScopeId, describeBudget, periodStart } from '../src/budgets.ts';
import { PoolHistory, outages } from '../src/history.ts';
import { buildMetrics } from '../src/metrics.ts';
import { TelemetryIngest, parseOtlpMetrics } from '../src/telemetry.ts';
import { setup, status, waitFor } from './harness.ts';

async function api(port: number, method: string, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
}

const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });
const point = (value: number, attrs: Record<string, string>): { asInt?: string; asDouble?: number; timeUnixNano: string; attributes: ReturnType<typeof attr>[] } => ({ asInt: String(value), timeUnixNano: String(Date.now() * 1e6), attributes: Object.entries(attrs).map(([k, v]) => attr(k, v)) });
const otlp = (session: string, metrics: { name: string; points: ReturnType<typeof point>[]; cumulative?: boolean }[]) => ({
  resourceMetrics: [
    {
      resource: { attributes: [attr('ih.session', session), attr('service.name', 'claude-code')] },
      scopeMetrics: [{ metrics: metrics.map((m) => ({ name: m.name, sum: { aggregationTemporality: m.cumulative ? 2 : 1, dataPoints: m.points } })) }],
    },
  ],
});

test('Claude telemetry: OTLP metrics become usage records on the card and agent whose session sent them', async () => {
  const { store, board, close } = await setup();
  try {
    const card = store.createCard({ boardId: board.id, title: 'Work' });
    store.updateCard(card.id, { agentId: 'sonnet-lead' });
    const session = store.createSession({ cardId: card.id, poolId: 'fa', harness: 'claude', model: 'sonnet' });
    const ingest = new TelemetryIngest(store);

    const body = otlp(session.id, [
      { name: 'claude_code.token.usage', points: [point(1200, { type: 'input', model: 'claude-sonnet' }), point(300, { type: 'output', model: 'claude-sonnet' }), point(5000, { type: 'cacheRead', model: 'claude-sonnet' })] },
      { name: 'claude_code.cost.usage', points: [{ asDouble: 0.042, timeUnixNano: String(Date.now() * 1e6), attributes: [attr('model', 'claude-sonnet')] }] },
      { name: 'claude_code.session.count', points: [point(1, {})] },
    ]);
    assert.equal(parseOtlpMetrics(body).length, 5);
    assert.equal(ingest.ingest(body), 4, 'the session counter is not usage');

    const t = store.usageTotals(board.id);
    assert.deepEqual([t.inputTokens, t.outputTokens, t.cacheTokens], [1200, 300, 5000]);
    assert.ok(Math.abs(t.costUsd - 0.042) < 1e-9);
    const [row] = store.usageBreakdown(board.id).filter((r) => r.cardId === card.id && r.inputTokens);
    assert.equal(row!.agentId, 'sonnet-lead');
    assert.equal(row!.model, 'claude-sonnet');

    // An unknown session is dropped.
    assert.equal(ingest.ingest(otlp('s_unknown', [{ name: 'claude_code.token.usage', points: [point(10, { type: 'input' })] }])), 0);

    // A cumulative series becomes increments: 100, then 250 total → 100 + 150.
    const cum = (v: number) => otlp(session.id, [{ name: 'claude_code.token.usage', cumulative: true, points: [point(v, { type: 'output', model: 'm' })] }]);
    ingest.ingest(cum(100));
    ingest.ingest(cum(250));
    assert.equal(store.usageTotals(board.id).outputTokens, 300 + 250);
  } finally {
    await close();
  }
});

test('the receiver is served by the daemon, and Claude sessions are told where to send telemetry', async () => {
  const { store, board, cfg, close } = await setup();
  try {
    const card = store.createCard({ boardId: board.id, title: 'Work' });
    const session = store.createSession({ cardId: card.id, poolId: 'fa', harness: 'claude', model: 'sonnet' });
    const res = await api(cfg.port, 'POST', '/v1/metrics', otlp(session.id, [{ name: 'claude_code.token.usage', points: [point(77, { type: 'input' })] }]));
    assert.equal(res.status, 200);
    assert.equal(store.usageTotals(board.id).inputTokens, 77);
    assert.equal((await api(cfg.port, 'POST', '/v1/logs', {})).status, 200);

    const env = claudeTelemetryEnv({ endpoint: 'http://127.0.0.1:7420', attributes: { 'ih.session': session.id, 'ih.card': card.id } });
    assert.equal(env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
    assert.equal(env.OTEL_EXPORTER_OTLP_PROTOCOL, 'http/json');
    assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://127.0.0.1:7420');
    assert.equal(env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE, 'delta');
    assert.equal(env.OTEL_RESOURCE_ATTRIBUTES, `ih.session=${session.id},ih.card=${card.id}`);
  } finally {
    await close();
  }
});

test('ACP harnesses that report a turn’s usage are counted against the card', async () => {
  const { store, runner, board, close } = await setup();
  try {
    assert.deepEqual(usageFrom({ usage: { input_tokens: 5, output_tokens: 7, cached_read_tokens: 2 } }), { inputTokens: 5, outputTokens: 7, cacheTokens: 2 });
    assert.equal(usageFrom({ stopReason: 'end_turn' }), null);

    const card = store.createCard({ boardId: board.id, title: 'Tally USAGE' });
    const done = waitFor(store, status(store, card.id, 'review'));
    await runner.run(card.id, 'fa', { agentId: 'fa' });
    await done;
    const t = store.usageTotals(board.id, { agentId: 'fa' });
    assert.deepEqual([t.inputTokens, t.outputTokens, t.cacheTokens], [1200, 340, 100]);
    assert.equal(store.usageBreakdown(board.id)[0]!.cardId, card.id);
  } finally {
    await close();
  }
});

test('metrics roll each card’s usage up through its parents, by agent, model and pool', async () => {
  const { store, board, cfg, close } = await setup();
  try {
    const goal = store.createCard({ boardId: board.id, title: 'Goal', role: 'orchestrator' });
    const lead = store.createCard({ boardId: board.id, title: 'Lead', role: 'lead', parentId: goal.id });
    const a = store.createCard({ boardId: board.id, title: 'A', parentId: lead.id });
    const b = store.createCard({ boardId: board.id, title: 'B', parentId: goal.id });
    const use = (cardId: string, agentId: string, poolId: string, model: string, i: number, o: number, usd?: number) =>
      store.recordUsage({ poolId, source: 'otel', boardId: board.id, cardId, agentId, model, inputTokens: i, outputTokens: o, costUsd: usd });
    use(goal.id, 'orchestrator', 'fa', 'opus', 1000, 200, 0.5);
    use(a.id, 'w1', 'fb', 'kimi', 3000, 1000);
    use(b.id, 'w1', 'fb', 'kimi', 500, 500);
    store.recordUsage({ poolId: 'fb', source: 'gateway', boardId: board.id, inputTokens: 40, outputTokens: 10 }); // no card

    const m = (await api(cfg.port, 'GET', `/api/boards/${board.id}/metrics?hours=24`)).body;
    assert.equal(m.totals.tokens, 1200 + 4000 + 1000 + 50);
    assert.equal(m.unattributed.tokens, 50);
    const by = Object.fromEntries(m.cards.map((c: any) => [c.title, c]));
    assert.equal(by.A.own.tokens, 4000);
    assert.equal(by.Lead.own.tokens, 0);
    assert.equal(by.Lead.subtree.tokens, 4000, 'a lead shows what its workers used');
    assert.equal(by.Goal.subtree.tokens, 1200 + 4000 + 1000);
    assert.ok(Math.abs(by.Goal.subtree.costUsd - 0.5) < 1e-9);
    assert.deepEqual(m.byAgent.map((x: any) => x.agentId), ['w1', 'orchestrator', 'fb']);
    assert.equal(m.byModel.find((x: any) => x.model === 'kimi').tokens, 5000);
    assert.equal(m.byPool.find((x: any) => x.poolId === 'fb').requests, 3);
    assert.ok(m.series.length >= 1);
  } finally {
    await close();
  }
});

test('buildMetrics with no usage is empty, not an error', () => {
  const m = buildMetrics({ rows: [], cards: [], series: [], since: '' });
  assert.equal(m.totals.tokens, 0);
  assert.deepEqual(m.cards, []);
});

test('budgets: warn at 80%, halt at 95% in the limiter, tell the humans, rank the agent out; removing the budget frees it', async () => {
  const { store, board, scheduler, limiter, close } = await setup({ kev: null });
  try {
    const notes: string[] = [];
    const budgets = new Budgets({ store, limiter, notify: (_b, s) => notes.push(describeBudget(s)) });
    const card = store.createCard({ boardId: board.id, title: 'Work' });
    store.updateSettings(board.id, {
      agents: [
        { id: 'orchestrator', poolId: 'fa', model: '', role: 'orchestrator', delegatesTo: [], enabled: true },
        { id: 'cheap', poolId: 'fa', model: '', role: 'worker', delegatesTo: [], enabled: true },
        { id: 'other', poolId: 'fb', model: '', role: 'worker', delegatesTo: [], enabled: true },
      ],
      budgets: { board: null, agents: { cheap: { limit: 1000, unit: 'tokens', period: 'total' } } },
    });
    const spend = (n: number) => store.recordUsage({ poolId: 'fa', source: 'otel', boardId: board.id, cardId: card.id, agentId: 'cheap', inputTokens: n, outputTokens: 0 });

    spend(500);
    assert.equal(budgets.evaluate(board.id)[0]!.state, 'open');
    spend(350); // 85%
    let s = budgets.evaluate(board.id)[0]!;
    assert.deepEqual([s.scope, s.pct, s.state], ['cheap', 85, 'warn']);
    assert.equal(limiter.status(budgetScopeId(board.id, 'cheap')).state, 'warn', 'a budget is a window in the same limiter as the pools');
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /Agent cheap's budget is at 85%/);

    spend(110); // 96%
    s = budgets.evaluate(board.id)[0]!;
    assert.equal(s.state, 'halted');
    assert.match(notes[1]!, /is used up/);
    budgets.evaluate(board.id);
    assert.equal(notes.length, 2, 'told once per step, not on every evaluation');

    // The scheduler's ranking drops the agent, with the reason; it still ranks the pool's other agents.
    const withBudget = new (scheduler.constructor as any)({ ...(scheduler as any).deps, budgets });
    const ranked = withBudget.rank(store.getCard(card.id)!);
    const cheap = ranked.find((c: any) => c.agentId === 'cheap');
    assert.equal(cheap.eligible, false);
    assert.match(cheap.reasons.join(), /budget used up \(96%\)/);
    assert.ok(ranked.find((c: any) => c.agentId === 'other').eligible);

    // Raising the limit reopens it; removing the budget clears the scope.
    store.updateSettings(board.id, { budgets: { board: null, agents: { cheap: { limit: 100_000, unit: 'tokens', period: 'total' } } } });
    assert.equal(budgets.evaluate(board.id)[0]!.state, 'open');
    store.updateSettings(board.id, { budgets: { board: null, agents: {} } });
    assert.deepEqual(budgets.evaluate(board.id), []);
    assert.equal(budgets.agent(board.id, 'cheap'), null);
  } finally {
    await close();
  }
});

test('a board past its budget starts no new cards and plans no new goals; dollars count where harnesses report them', async () => {
  const { store, board, scheduler, limiter, close } = await setup();
  try {
    const budgets = new Budgets({ store, limiter });
    const gated = new (scheduler.constructor as any)({ ...(scheduler as any).deps, budgets, tickMs: 50 });
    store.updateSettings(board.id, { budgets: { board: { limit: 1, unit: 'usd', period: 'day' }, agents: {} } });
    store.recordUsage({ poolId: 'fa', source: 'otel', boardId: board.id, inputTokens: 0, outputTokens: 0, costUsd: 0.97 });
    budgets.evaluate(board.id);
    assert.equal(budgets.boardHalted(board.id), true);
    await assert.rejects(gated.startGoal(board.id, 'More work'), /budget is used up/);

    const card = store.createCard({ boardId: board.id, title: 'Waits', status: 'ready' });
    gated.start();
    await new Promise((r) => setTimeout(r, 600));
    gated.stop();
    assert.equal(store.getCard(card.id)!.status, 'ready', 'nothing starts while the board budget is used up');

    store.updateSettings(board.id, { budgets: { board: { limit: 50, unit: 'usd', period: 'day' }, agents: {} } });
    budgets.evaluate(board.id);
    assert.equal(budgets.boardHalted(board.id), false);
  } finally {
    await close();
  }
});

test('budget windows: day and week roll, total does not', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  assert.equal(periodStart('day', now), '2026-11-09T12:00:00.000Z');
  assert.equal(periodStart('week', now), '2026-11-03T12:00:00.000Z');
  assert.equal(periodStart('total', now), '');
});

test('budgets only count usage inside their window', () => {
  const store = new Store(':memory:');
  const board = store.createBoard({ name: 'b', repoPath: '/x', defaultBranch: 'main' });
  const limiter = new RateLimiter();
  store.recordUsage({ ts: new Date(Date.now() - 3 * 86_400_000).toISOString(), poolId: 'p', source: 'otel', boardId: board.id, agentId: 'a', inputTokens: 900, outputTokens: 0 });
  store.recordUsage({ poolId: 'p', source: 'otel', boardId: board.id, agentId: 'a', inputTokens: 100, outputTokens: 0 });
  store.updateSettings(board.id, { budgets: { board: null, agents: { a: { limit: 1000, unit: 'tokens', period: 'day' } } } });
  const budgets = new Budgets({ store, limiter });
  assert.equal(budgets.evaluate(board.id)[0]!.pct, 10, 'the three-day-old usage is outside the daily window');
  store.updateSettings(board.id, { budgets: { board: null, agents: { a: { limit: 1000, unit: 'tokens', period: 'total' } } } });
  assert.equal(budgets.evaluate(board.id)[0]!.state, 'halted', '1000 of 1000 in total');
  assert.deepEqual(DEFAULT_SETTINGS.budgets, { board: null, agents: {} });
  store.close();
});

test('pool history: samples are stored when something changes, outages are read from them, the API serves both', async () => {
  const { store, limiter, runner, cfg, close } = await setup();
  try {
    let now = Date.now();
    const history = new PoolHistory({ store, limiter, poolIds: () => ['fa', 'fb'], running: (id) => runner.runningOn(id), now: () => now });
    assert.equal(history.sample(), 2, 'first sample for each pool');
    assert.equal(history.sample(), 0, 'nothing changed');
    now += 60_000;
    limiter.force('fa', 96);
    assert.equal(history.sample(), 1, 'fa went halted');
    now += 60_000;
    limiter.force('fa', null);
    history.sample();

    store.recordUsage({ poolId: 'fa', source: 'gateway', inputTokens: 10, outputTokens: 5 });
    store.recordUsage({ poolId: 'fa', source: 'gateway', status: 429, inputTokens: 0, outputTokens: 0 });

    const h = (await api(cfg.port, 'GET', '/api/pools/fa/history?hours=24')).body;
    assert.deepEqual(h.samples.map((x: any) => x.state), ['open', 'halted', 'open']);
    assert.equal(h.outages.length, 1);
    assert.equal(h.outages[0].state, 'halted');
    assert.equal(h.usage[0].requests, 2);
    assert.equal(h.usage[0].errors, 1);
    assert.equal((await api(cfg.port, 'GET', '/api/pools/nope/history')).status, 404);
    assert.deepEqual(outages([{ ts: 'a', poolId: 'x', state: 'locked', topPct: 0, windows: [], running: 0 }], 'z'), [{ from: 'a', to: 'z', state: 'locked' }]);
  } finally {
    await close();
  }
});
