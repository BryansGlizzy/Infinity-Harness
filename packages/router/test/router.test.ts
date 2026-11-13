import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, outcomeValue, type Classification, type Pool } from '@ih/core';
import { KevClient, fallbackClassification, historyKey, priorFor, priorSuccess, rankPools, type PoolView } from '../src/index.ts';

const pool = (id: string, kind: Pool['kind'] = 'subscription'): Pool => ({ id, label: id, harness: 'opencode', model: `${id}/m`, kind });
const view = (id: string, over: Partial<PoolView> = {}): PoolView => ({ pool: pool(id), state: 'open', topPct: 0, running: 0, ...over });
const cls = (complexity: number): Classification => ({ ...fallbackClassification({ title: 't', description: '' }), complexity });

test('rankPools: halted, locked, full and rule-excluded pools are ineligible with reasons', () => {
  const ranked = rankPools({
    classification: cls(2),
    routing: { avoid: ['nim'] },
    pools: [view('kimi', { state: 'halted', topPct: 96 }), view('agy', { running: 2 }), view('nim'), view('local', { state: 'locked' }), view('claude')],
    settings: DEFAULT_SETTINGS,
  });
  const byId = Object.fromEntries(ranked.map((c) => [c.poolId, c]));
  assert.match(byId.kimi!.reasons.join(), /pool halted/);
  assert.match(byId.agy!.reasons.join(), /all 2 slot\(s\) busy/);
  assert.match(byId.nim!.reasons.join(), /avoided by routing rules/);
  assert.match(byId.local!.reasons.join(), /pool locked/);
  assert.equal(ranked[0]!.poolId, 'claude');
  assert.ok(ranked[0]!.eligible);
  assert.deepEqual(ranked.filter((c) => c.eligible).map((c) => c.poolId), ['claude']);
});

test('rankPools: scarcity keeps Claude for last; warn and load lower a pool; Claude reserve applies', () => {
  const settings = { ...DEFAULT_SETTINGS, claudeReservePct: 30 };
  const open = rankPools({ classification: cls(2), routing: null, pools: [view('claude'), view('kimi'), view('agy')], settings });
  assert.equal(open[open.length - 1]!.poolId, 'claude');

  const warned = rankPools({ classification: cls(2), routing: null, pools: [view('kimi', { state: 'warn', topPct: 85 }), view('agy')], settings });
  assert.equal(warned[0]!.poolId, 'agy');

  const busy = rankPools({ classification: cls(2), routing: null, pools: [view('kimi', { running: 1 }), view('agy')], settings });
  assert.equal(busy[0]!.poolId, 'agy');

  const reserved = rankPools({ classification: cls(2), routing: null, pools: [view('claude', { fiveHourPct: 75, topPct: 75 })], settings });
  assert.equal(reserved[0]!.eligible, false);
  assert.match(reserved[0]!.reasons.join(), /reserve 30%/);

  const codex = (pct: number, reservePct = 30) =>
    rankPools({ classification: cls(2), routing: null, pools: [view('codex', { fiveHourPct: pct, topPct: pct })], settings: { ...settings, codexReservePct: reservePct } })[0]!;
  assert.equal(codex(60).eligible, true);
  assert.equal(codex(75).eligible, false);
  assert.match(codex(75).reasons.join(), /reserve 30%/);
  assert.equal(codex(75, 10).eligible, true);
});

test('rankPools: hard complexity caps, routing allow-lists and the previous pool', () => {
  const hard = rankPools({ classification: cls(3.4), routing: null, pools: [view('local')], settings: DEFAULT_SETTINGS });
  assert.equal(hard[0]!.eligible, false);
  assert.ok(priorSuccess(priorFor('local', 'local/m'), 'feature', 3) < priorSuccess(priorFor('claude', 'sonnet'), 'feature', 3));

  const only = rankPools({ classification: cls(1), routing: { pools: ['nim'] }, pools: [view('kimi'), view('nim')], settings: DEFAULT_SETTINGS });
  assert.deepEqual(only.filter((c) => c.eligible).map((c) => c.poolId), ['nim']);

  const pref = rankPools({ classification: cls(1), routing: null, preferredPool: 'agy', pools: [view('kimi'), view('agy')], settings: DEFAULT_SETTINGS });
  assert.equal(pref[0]!.poolId, 'agy');
  assert.match(pref[0]!.reasons.join(), /previous agent/);
});

test('KevClient.classify: one call, choice for untagged cards, noul confirmation for tagged ones', async () => {
  const calls: any[] = [];
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push(body);
    const workType =
      body.questions.work_type.type === 'choice'
        ? { type: 'choice', choice: 'bugfix', confidence: 0.5, probabilities: { feature: 0.1, bugfix: 0.7, refactor: 0.1, docs: 0.1 } }
        : { type: 'noul', noul: 0.9 };
    return new Response(
      JSON.stringify({
        answers: {
          work_type: workType,
          complexity: { type: 'score', score: 1.6, probabilities: { 0: 0.1, 1: 0.3, 2: 0.45, 3: 0.1, 4: 0.05 } },
          needs_review: { type: 'noul', noul: 0.38 },
        },
      }),
    );
  }) as typeof fetch;
  const kev = new KevClient({ url: 'http://kev/v1/systemone', apiKey: 'k', model: 'kev-9b', fetch: fakeFetch });

  const untagged = await kev.classify({ title: 'Fix pagination off-by-one', description: 'and add a test' });
  assert.equal(untagged.workType, 'bugfix');
  assert.equal(untagged.complexity, 1.6);
  assert.equal(untagged.needsReview, 0.38);
  assert.equal(untagged.source, 'kev');
  assert.equal(calls[0].model, 'kev-9b');
  assert.equal(Object.keys(calls[0].questions.work_type.criteria).length, 4);

  const tagged = await kev.classify({ title: 'Write the README', description: '', workType: 'docs' });
  assert.equal(tagged.workType, 'docs');
  assert.deepEqual(tagged.workTypeProbs, { docs: 0.9 });
  assert.equal(calls[1].questions.work_type.type, 'noul');
});

test('KevClient: errors surface; warm() reports reachability', async () => {
  const down = new KevClient({ url: 'http://kev', model: 'kev-9b', fetch: (async () => new Response('nope', { status: 502 })) as typeof fetch });
  await assert.rejects(down.classify({ title: 'x', description: '' }), /kev 502/);
  assert.equal(await down.warm(), false);
});

test('rankPools over agents: roles, rules naming an agent or its pool, and the agent model', () => {
  const agent = (id: string, poolId: string, role: 'lead' | 'worker' = 'worker', model = '') => ({ id, poolId, model, role, delegatesTo: [], enabled: true });
  const views: PoolView[] = [
    { ...view('claude'), agent: agent('sonnet-lead', 'claude', 'lead', 'sonnet') },
    { ...view('agy'), agent: agent('agy', 'agy') },
    { ...view('agy'), agent: agent('agy-argon', 'agy', 'worker', 'gemini-4-argon') },
  ];
  const eligible = (list: ReturnType<typeof rankPools>) => list.filter((c) => c.eligible).map((c) => c.agentId).sort();

  const lead = rankPools({ classification: cls(2), routing: null, role: 'lead', pools: views, settings: DEFAULT_SETTINGS });
  assert.deepEqual(eligible(lead), ['sonnet-lead']);
  assert.equal(lead[0]!.model, 'sonnet');
  assert.match(lead.find((c) => c.agentId === 'agy')!.reasons.join(), /takes worker cards/);

  const byPool = rankPools({ classification: cls(2), routing: { pools: ['agy'] }, pools: views, settings: DEFAULT_SETTINGS });
  assert.deepEqual(eligible(byPool), ['agy', 'agy-argon']);
  assert.equal(byPool.find((c) => c.agentId === 'agy')!.model, 'agy/m', 'no model set: the pool default');

  const byAgent = rankPools({ classification: cls(2), routing: { pools: ['agy-argon'] }, pools: views, settings: DEFAULT_SETTINGS });
  assert.deepEqual(eligible(byAgent), ['agy-argon']);
  assert.equal(byAgent[0]!.model, 'gemini-4-argon');
  assert.deepEqual(eligible(rankPools({ classification: cls(2), routing: { avoid: ['agy-argon'] }, pools: views, settings: DEFAULT_SETTINGS })), ['agy']);
});

const modelView = (poolId: string, model: string, id = `${poolId}-${model}`): PoolView => ({
  pool: { id: poolId, label: poolId, harness: 'opencode', model, kind: 'subscription' },
  agent: { id, poolId, model, role: 'worker', delegatesTo: [], enabled: true },
  state: 'open',
  topPct: 0,
  running: 0,
});
const typed = (workType: Classification['workType'], complexity = 1.5, frontend = 0): Classification => ({ ...cls(complexity), workType, frontend });
const flat = { ...DEFAULT_SETTINGS, scarcity: {} };

test('model priors: the operator\'s strengths pick the agent per work type, and research never goes to direct API models', () => {
  const team = [
    modelView('agy', 'gemini-4-argon', 'argon'),
    modelView('agy', 'gemini-3.8-flash', 'flash'),
    modelView('kimi', 'kimi-code/k3.1-pro', 'k31'),
    modelView('nim', 'nvidia/nemotron-3.5-super-vl-120b-a12b', 'nemotron'),
    modelView('local', 'local/qwen3.8-flash-next-iq3_s', 'qwen'),
  ];
  const top = (c: Classification, skill?: 'review') => rankPools({ classification: c, routing: null, pools: team, settings: flat, skill })[0]!.agentId;
  assert.equal(top(typed('research')), 'argon');
  assert.equal(top(typed('feature', 1.5, 0.9)), 'flash', 'web front-end work');
  assert.equal(top(typed('bugfix', 3)), 'k31');
  assert.equal(top(typed('docs')), 'flash');
  assert.equal(top(typed('feature'), 'review'), 'k31');

  const research = rankPools({ classification: typed('research'), routing: null, pools: team, settings: flat });
  for (const id of ['nemotron', 'qwen']) {
    const c = research.find((r) => r.agentId === id)!;
    assert.equal(c.eligible, false);
    assert.match(c.reasons.join(), /no web access/);
  }
  // Among the cheap models, Nemotron reviews best; other Kimi models rank below K3.1.
  const cheap = rankPools({ classification: typed('feature'), routing: null, pools: team.slice(3), settings: flat, skill: 'review' });
  assert.equal(cheap[0]!.agentId, 'nemotron');
  assert.ok(priorFor('kimi', 'kimi-code/k2.8-preview').skills.feature < priorFor('kimi', 'kimi-code/k3.1-pro').skills.feature);
  assert.equal(priorFor('claude', 'opus').family, 'opus');
  assert.equal(priorFor('newpool', 'x').family, 'pool');
});

test('priors: per-agent overrides from settings replace the built-in values', () => {
  const team = [modelView('agy', 'gemini-4-argon', 'argon'), modelView('kimi', 'kimi-code/k3.1-pro', 'k31')];
  const settings = { ...flat, priorOverrides: { argon: { skills: { bugfix: 0.99 } } } };
  const ranked = rankPools({ classification: typed('bugfix'), routing: null, pools: team, settings });
  assert.equal(ranked[0]!.agentId, 'argon');
  assert.equal(priorFor('agy', 'gemini-4-argon', { capability: 1 }).capability, 1);
});

test('outcomes: observed success moves an agent\'s score away from its prior, and the reasons say so', () => {
  const team = [modelView('kimi', 'kimi-code/k3.1-pro', 'k31'), modelView('agy', 'gemini-3.8-flash', 'flash')];
  const before = rankPools({ classification: typed('feature'), routing: null, pools: team, settings: flat });
  assert.equal(before[0]!.agentId, 'k31');
  assert.match(before[0]!.reasons.join(), /prior kimi-k3.1, feature/);

  const history = { [historyKey('kimi', 'kimi-code/k3.1-pro')]: { rate: 0.1, n: 4 }, [historyKey('agy', 'gemini-3.8-flash')]: { rate: 0.95, n: 3 } };
  const after = rankPools({ classification: typed('feature'), routing: null, pools: team, settings: flat, history });
  assert.equal(after[0]!.agentId, 'flash');
  const k31 = after.find((c) => c.agentId === 'k31')!;
  assert.ok(k31.score < before.find((c) => c.agentId === 'k31')!.score);
  assert.match(k31.reasons.join(), /observed 0.1 n=4/);
});

test('outcomeValue: landed work by Kev quality, scope and review rounds; failures low', () => {
  assert.equal(outcomeValue({ result: 'landed', quality: 1, inScope: 0.9, changesRequested: 0 }), 1);
  assert.equal(outcomeValue({ result: 'landed', quality: null, inScope: null, changesRequested: 0 }), 0.85);
  assert.equal(outcomeValue({ result: 'landed', quality: 1, inScope: 0.2, changesRequested: 1 }), 0.63);
  assert.equal(outcomeValue({ result: 'failed_landing', quality: null, inScope: null, changesRequested: 0, kind: 'conflict' }), 0.4);
  assert.equal(outcomeValue({ result: 'failed_run', quality: null, inScope: null, changesRequested: 0 }), 0);
});

test('KevClient.scoreOutcome: quality scaled to 0–1 and in-scope probability, in one call; frontend in classify', async () => {
  const calls: any[] = [];
  const kev = new KevClient({
    url: 'http://kev',
    model: 'kev-9b',
    fetch: (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push(body);
      const answers = body.questions.quality
        ? { quality: { type: 'score', score: 2.4 }, in_scope: { type: 'noul', noul: 0.85 } }
        : { work_type: { noul: 0.9 }, complexity: { score: 1 }, needs_review: { noul: 0.1 }, frontend: { noul: 0.8 } };
      return new Response(JSON.stringify({ answers }));
    }) as typeof fetch,
  });
  const r = await kev.scoreOutcome({ title: 'Add top_words', description: 'Acceptance: returns n most common', diff: 'diff --git a/x b/x' });
  assert.equal(r.quality, 0.8);
  assert.equal(r.inScope, 0.85);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].questions.quality.criteria.length, 4);
  const c = await kev.classify({ title: 'Landing page', description: 'hero section', workType: 'feature' });
  assert.equal(c.frontend, 0.8);
});

test('priors: Codex models rank by family (Astra ~ Opus, Sol ~ Sonnet, Luna light)', () => {
  const astra = priorFor('codex', 'gpt-6-astra');
  const sol = priorFor('codex', 'gpt-6.1-sol');
  const luna = priorFor('codex', 'gpt-6-luna');
  assert.ok(astra.capability >= sol.capability);
  assert.ok(luna.capability < sol.capability);
  assert.ok(priorSuccess(luna, 'feature', 3) < priorSuccess(sol, 'feature', 3));
});

test('rankPools: a card that needs the network skips Codex (its shell has none); budget-halted agents are out, warning ones rank lower', () => {
  const codex: PoolView = { pool: { id: 'codex', label: 'Codex', harness: 'codex', model: 'gpt-6.1-sol', kind: 'subscription' }, state: 'open', topPct: 0, running: 0 };
  const plain = rankPools({ classification: cls(2), routing: null, pools: [codex, view('kimi')], settings: DEFAULT_SETTINGS });
  assert.ok(plain.find((c) => c.poolId === 'codex')!.eligible);
  const net = rankPools({ classification: cls(2), routing: { needsNetwork: true }, pools: [codex, view('kimi')], settings: DEFAULT_SETTINGS });
  const c = net.find((x) => x.poolId === 'codex')!;
  assert.equal(c.eligible, false);
  assert.match(c.reasons.join(), /shell has no network/);
  assert.equal(net.find((x) => x.poolId === 'kimi')!.eligible, true);

  const budgets = rankPools({
    classification: cls(2),
    routing: null,
    pools: [view('kimi', { budget: { state: 'halted', pct: 97 } }), view('agy', { budget: { state: 'warn', pct: 85 } }), view('nim')],
    settings: DEFAULT_SETTINGS,
  });
  const by = Object.fromEntries(budgets.map((x) => [x.poolId, x]));
  assert.equal(by.kimi!.eligible, false);
  assert.match(by.kimi!.reasons.join(), /budget used up \(97%\)/);
  assert.match(by.agy!.reasons.join(), /budget warn/);
});

test('agent weights: the operator can tilt routing; a boost does not send hard cards to a light agent; 0 switches an agent off', () => {
  const team = [modelView('agy', 'gemini-4-argon', 'argon'), modelView('nim', 'nvidia/nemotron-3.5-super-vl-120b-a12b', 'nemotron')];
  const top = (c: Classification, agentWeights: Record<string, number>) => rankPools({ classification: c, routing: null, pools: team, settings: { ...flat, agentWeights } });
  assert.equal(top(typed('feature', 1), {})[0]!.agentId, 'argon', 'without a weight the stronger prior wins');
  const tilted = top(typed('feature', 1), { nemotron: 2 });
  assert.equal(tilted[0]!.agentId, 'nemotron');
  assert.match(tilted[0]!.reasons.join(), /weight ×2/);
  assert.equal(top(typed('feature', 1), { argon: 0.5 })[0]!.agentId, 'nemotron', 'a weight under 1 holds an agent back');
  // Nemotron handles up to complexity 2.5: a hard card ignores its boost.
  const hard = top(typed('feature', 4), { nemotron: 5 });
  assert.equal(hard[0]!.agentId, 'argon');
  assert.match(hard.find((c) => c.agentId === 'nemotron')!.reasons.join(), /not applied/);
  const off = top(typed('feature', 1), { argon: 0 });
  assert.equal(off.find((c) => c.agentId === 'argon')!.eligible, false);
  assert.match(off.find((c) => c.agentId === 'argon')!.reasons.join(), /weight 0/);
});

test('an offline pool is out of rotation with the reason shown, and the others are unaffected', () => {
  const team = [modelView('agy', 'gemini-4-argon', 'argon'), modelView('nim', 'nvidia/nemotron-3.5-super-vl-120b-a12b', 'nemotron')];
  const down = [team[0]!, { ...team[1]!, offline: 'fetch failed (ECONNREFUSED)' }];
  const ranked = rankPools({ classification: typed('feature', 1), routing: null, pools: down, settings: flat });
  const nemotron = ranked.find((c) => c.agentId === 'nemotron')!;
  assert.equal(nemotron.eligible, false);
  assert.match(nemotron.reasons.join(), /offline: fetch failed \(ECONNREFUSED\) \(turn it back on in Agents\)/);
  assert.equal(ranked[0]!.agentId, 'argon');
  assert.equal(rankPools({ classification: typed('feature', 1), routing: null, pools: team, settings: flat }).every((c) => c.eligible), true, 'back in rotation once the reason is gone');
});
