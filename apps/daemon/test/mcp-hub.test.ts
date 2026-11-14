import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS, mcpLevel, type HarnessEvent, type McpLibraryEntry, type Pool } from '@ih/core';
import { rankPools, type PoolView } from '@ih/router';
import type { Store } from '@ih/db';
import { buildOrchestratorPrompt, buildPrompt } from '../src/runner.ts';
import { setup, status, waitFor } from './harness.ts';

const fakeMcp = fileURLToPath(new URL('./fake-mcp-server.mjs', import.meta.url));

const entry = (over: Partial<McpLibraryEntry> = {}): McpLibraryEntry => ({
  id: 'fake',
  label: 'Fake Studio',
  description: 'A stand-in for Studio.',
  transport: 'stdio',
  command: process.execPath,
  args: [fakeMcp],
  hosting: 'shared',
  exclusive: true,
  toolKinds: {},
  autoStart: false,
  ...over,
});

const said = (store: Store, cardId: string) =>
  store
    .eventsFor(cardId)
    .map((e) => (e.type === 'session.event' ? (e.payload as { event: HarnessEvent }).event : null))
    .filter((e): e is Extract<HarnessEvent, { type: 'message' }> => e?.type === 'message' && e.role === 'agent')
    .map((e) => e.text)
    .join('');

async function api(port: number, method: string, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json()) as any };
}

async function runWorker(ctx: Awaited<ReturnType<typeof setup>>, title: string, lines: string[], agent = 'fa') {
  const card = ctx.store.createCard({ boardId: ctx.board.id, title, description: lines.join('\n') });
  const done = waitFor(ctx.store, status(ctx.store, card.id, 'review'));
  await ctx.runner.run(card.id, agent === 'fa' ? 'fa' : 'fb', { agentId: agent });
  await done;
  return card;
}

const enable = (ctx: Awaited<ReturnType<typeof setup>>, access: Record<string, { default: 'off' | 'read' | 'full'; agents: Record<string, 'off' | 'read' | 'full'> }> = {}) =>
  ctx.store.updateSettings(ctx.board.id, { mcp: { enabled: ['fake'], access, presets: [] } });

test('the library: built-in Studio entry, adding, validating and removing servers through the API', async () => {
  const ctx = await setup();
  try {
    const { port } = ctx.cfg;
    const list = await api(port, 'GET', '/mcp');
    const roblox = list.body.find((s: any) => s.entry.id === 'roblox-studio');
    assert.ok(roblox, 'the Roblox Studio server ships with the daemon');
    assert.equal(roblox.installed, false, 'not installed in this temp root, so the view says Install is needed');
    assert.equal(roblox.entry.exclusive, true);
    assert.match(roblox.entry.args.at(-1), /--auto-install-plugin/);
    assert.equal((await api(port, 'DELETE', '/mcp/roblox-studio')).status, 409, 'a built-in cannot be removed');

    assert.equal((await api(port, 'POST', '/mcp', { ...entry(), id: 'board' })).status, 400, '"board" is reserved');
    assert.equal((await api(port, 'POST', '/mcp', { ...entry(), id: 'bad id' })).status, 400);
    assert.equal((await api(port, 'POST', '/mcp', { ...entry(), transport: 'http', url: 'ftp://x' })).status, 400);
    assert.equal((await api(port, 'POST', '/mcp', { ...entry(), hosting: 'per-session', transport: 'http', url: 'http://x.test/mcp' })).status, 400, 'per-session servers are stdio');
    const added = await api(port, 'POST', '/mcp', entry());
    assert.equal(added.status, 200);
    assert.equal((await api(port, 'POST', '/mcp', entry())).status, 409, 'adding twice is refused');

    const started = await api(port, 'POST', '/mcp/fake/start');
    assert.equal(started.status, 200);
    assert.equal(started.body.state, 'running');
    assert.deepEqual(started.body.tools.map((t: any) => t.name).sort(), ['change', 'look', 'unmarked']);
    assert.ok(!('raw' in started.body.tools[0]), 'the API shows names and hints, not the full schemas');

    ctx.store.updateSettings(ctx.board.id, { mcp: { enabled: ['fake'], access: {}, presets: [] } });
    assert.equal((await api(port, 'DELETE', '/mcp/fake')).status, 200);
    assert.deepEqual(ctx.store.getSettings(ctx.board.id).mcp.enabled, [], 'removing a server switches it off on every board');
    assert.equal((await api(port, 'GET', '/mcp')).body.some((s: any) => s.entry.id === 'fake'), false);
    const board = await api(port, 'GET', `/boards/${ctx.board.id}/mcp`);
    assert.deepEqual(board.body.grants.map((g: any) => g.name).sort(), ['browser', 'computer'], 'tool grants are listed beside the servers');
  } finally {
    await ctx.close();
  }
});

test('a hosted server reaches an agent through the hub, only while the board has it switched on', async () => {
  const ctx = await setup();
  try {
    ctx.mcp.save(entry());
    const off = await runWorker(ctx, 'Off', ['LISTTOOLS fake']);
    assert.match(said(ctx.store, off.id), /tools=no board server/, 'a server that is not switched on is not in the session');

    enable(ctx);
    const on = await runWorker(ctx, 'On', ['LISTTOOLS fake', 'CALL fake:look {"what":"baseplate"}', 'CALL fake:change {"what":"part"}']);
    const text = said(ctx.store, on.id);
    assert.match(text, /tools=look,change,unmarked/);
    assert.match(text, /look -> saw baseplate after 0 change/);
    assert.match(text, /fake:change -> changed part|change -> changed part/);
    const calls = ctx.store.eventsFor(on.id).filter((e) => e.type === 'mcp.call').map((e) => e.payload as any);
    assert.deepEqual(calls.map((c) => [c.server, c.tool, c.ok, c.write]), [['fake', 'look', true, false], ['fake', 'change', true, true]]);
    assert.ok(!JSON.stringify(calls).includes('baseplate'), 'the log keeps who and what, not the arguments');
  } finally {
    await ctx.close();
  }
});

test('access levels: read only lists and allows only reading tools; off removes the server for that agent', async () => {
  const ctx = await setup();
  try {
    ctx.mcp.save(entry());
    enable(ctx, { fake: { default: 'read', agents: {} } });
    const reader = await runWorker(ctx, 'Reader', ['LISTTOOLS fake', 'CALL fake:look {}', 'CALL fake:change {}', 'CALL fake:unmarked {}']);
    const text = said(ctx.store, reader.id);
    assert.match(text, /tools=look(?!,)/, 'only the tool the server marks read-only is listed (an unmarked tool counts as a write)');
    assert.match(text, /ERROR .*"change" changes things, and your access to Fake Studio is read only/);
    assert.match(text, /ERROR .*"unmarked" changes things/);

    // The operator's call on a tool beats the server's own hint.
    ctx.mcp.save(entry({ toolKinds: { unmarked: 'read', look: 'write' } }));
    await ctx.mcp.restart('fake');
    const adjusted = await runWorker(ctx, 'Adjusted', ['LISTTOOLS fake']);
    assert.match(said(ctx.store, adjusted.id), /tools=unmarked(?!,)/);

    enable(ctx, { fake: { default: 'full', agents: { fa: 'off' } } });
    const nobody = await runWorker(ctx, 'Nobody', ['LISTTOOLS fake']);
    assert.match(said(ctx.store, nobody.id), /tools=no board server/, 'an agent set to off is not even given the server');
    const other = await runWorker(ctx, 'Other agent', ['LISTTOOLS fake'], 'fb');
    assert.match(said(ctx.store, other.id), /tools=look,change,unmarked/, 'another agent still has it');
  } finally {
    await ctx.close();
  }
});

test('the hub is closed to anyone without a session token, and an exclusive server serves writes one at a time', async () => {
  const ctx = await setup();
  try {
    ctx.mcp.save(entry());
    enable(ctx);
    const url = `http://127.0.0.1:${ctx.cfg.port}/hub/fake`;
    const rpc = (token: string | null, method: string, params: unknown, id = 1) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
    assert.equal((await rpc(null, 'tools/list', {})).status, 401);
    assert.equal((await rpc('made-up', 'tools/list', {})).status, 401);

    // A card that stays busy keeps its session (and token) alive while we call the hub as that session.
    const card = ctx.store.createCard({ boardId: ctx.board.id, title: 'Holds a session', description: 'SLOW' });
    void ctx.runner.run(card.id, 'fa', { agentId: 'fa' });
    let token = '';
    for (let i = 0; i < 100 && !token; i++) {
      await new Promise((r) => setTimeout(r, 50));
      token = [...((ctx.runner as any).tokens as Map<string, string>).entries()].find(([, id]) => id === card.id)?.[0] ?? '';
    }
    assert.ok(token, 'the session has a token');
    const call = async () => {
      const body = (await (await rpc(token, 'tools/call', { name: 'change', arguments: { what: 'x' } }, 2)).json()) as any;
      return body.result.content[0].text as string;
    };
    const started = Date.now();
    const outs = await Promise.all([call(), call(), call()]);
    assert.ok(Date.now() - started >= 3 * 140, 'three 150 ms writes took at least their sum: they ran one after another');
    for (const o of outs) assert.match(o, /peak concurrent writes 1$/, o);
    await ctx.runner.cancel(card.id);
  } finally {
    await ctx.close();
  }
});

test('cards that need a server only go to agents allowed to use it, and the planner is told when none is', async () => {
  const ctx = await setup();
  try {
    ctx.mcp.save(entry());
    enable(ctx, { fake: { default: 'full', agents: { fa: 'off' } } });
    const card = ctx.store.createCard({ boardId: ctx.board.id, title: 'Needs the fake', routing: { needsMcp: ['fake'] } });
    const ranked = (await api(ctx.cfg.port, 'GET', `/cards/${card.id}/route`)).body as { agentId: string; eligible: boolean; reasons: string[] }[];
    const fa = ranked.find((r) => r.agentId === 'fa')!;
    assert.equal(fa.eligible, false);
    assert.match(fa.reasons.join(' '), /not allowed to use the fake MCP server/);
    assert.equal(ranked.find((r) => r.agentId === 'fb')!.eligible, true);

    // create_subtask: refused for a server that is off or that no agent on the team may use; accepted otherwise, with the rule stored.
    const current = ctx.store.getSettings(ctx.board.id).permissions;
    ctx.store.updateSettings(ctx.board.id, { permissions: { ...current, worker: { ...current.worker, canCreateCards: true } } });
    ctx.store.updateSettings(ctx.board.id, { mcp: { enabled: [], access: {}, presets: [] } });
    const notOn = await runWorker(ctx, 'Planner 1', ['CALL create_subtask {"title":"Edit the place","description":"d","acceptance_criteria":["works"],"needs_mcp":["fake"]}']);
    assert.match(said(ctx.store, notOn.id), /"fake" is not switched on for this board/);

    enable(ctx, { fake: { default: 'off', agents: {} } });
    const nobody = await runWorker(ctx, 'Planner 2', ['CALL create_subtask {"title":"Edit the place","description":"d","acceptance_criteria":["works"],"needs_mcp":["fake"]}']);
    assert.match(said(ctx.store, nobody.id), /no agent on your team that takes worker cards may use "fake"/);

    enable(ctx, { fake: { default: 'off', agents: { fb: 'full' } } });
    const ok = await runWorker(ctx, 'Planner 3', ['CALL create_subtask {"title":"Edit the place","description":"d","acceptance_criteria":["works"],"needs_mcp":["fake"]}']);
    assert.match(said(ctx.store, ok.id), /"created"/);
    const made = ctx.store.listCards(ctx.board.id).find((c) => c.title === 'Edit the place')!;
    assert.deepEqual(ctx.store.effectiveRouting(made.id)?.needsMcp, ['fake']);
  } finally {
    await ctx.close();
  }
});

test('agent notes: prefers is checked against the team, stored on the card, and weighs the ranking', async () => {
  const ctx = await setup();
  try {
    const s = ctx.store.getSettings(ctx.board.id);
    ctx.store.updateSettings(ctx.board.id, {
      agents: [...s.agents, { id: 'ui', poolId: 'fb', model: '', role: 'worker', delegatesTo: [], enabled: true, notes: ['UI DEV', 'ui dev', ' Docs '] }],
      permissions: { ...s.permissions, worker: { ...s.permissions.worker, canCreateCards: true } },
    });
    assert.deepEqual(ctx.store.getSettings(ctx.board.id).agents.find((a) => a.id === 'ui')!.notes, ['UI DEV', 'ui dev', 'Docs'], 'notes are kept, trimmed');
    const unknown = await runWorker(ctx, 'Planner A', ['CALL create_subtask {"title":"Style it","description":"d","acceptance_criteria":["works"],"prefers":["SECURITY AUDITOR"]}']);
    assert.match(said(ctx.store, unknown.id), /no agent on your team carries "security auditor"\. Notes in use: ui dev, docs/);
    const known = await runWorker(ctx, 'Planner B', ['CALL create_subtask {"title":"Style it","description":"d","acceptance_criteria":["works"],"prefers":["ui dev"]}']);
    assert.match(said(ctx.store, known.id), /"created"/);
    assert.deepEqual(ctx.store.effectiveRouting(ctx.store.listCards(ctx.board.id).find((c) => c.title === 'Style it')!.id)?.prefers, ['ui dev']);

    // Too many or too long notes are refused when settings are saved.
    const bad = await api(ctx.cfg.port, 'PATCH', `/boards/${ctx.board.id}/settings`, { agents: [{ id: 'x', poolId: 'fa', model: '', role: 'worker', delegatesTo: [], enabled: true, notes: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }] });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /at most 6 notes/);
  } finally {
    await ctx.close();
  }
});

const pool = (id: string): Pool => ({ id, label: id, harness: 'opencode', model: 'm', kind: 'subscription' });
const view = (id: string, notes?: string[]): PoolView => ({
  pool: pool(id),
  agent: { id, poolId: id, model: '', role: 'worker', delegatesTo: [], enabled: true, ...(notes ? { notes } : {}) },
  state: 'open',
  topPct: 0,
  running: 0,
});
const cls = (noteProbs?: Record<string, number>) => ({ workType: 'feature' as const, workTypeProbs: {}, complexity: 1, complexityProbs: {}, needsReview: 0.2, source: 'kev' as const, at: '', ...(noteProbs ? { noteProbs } : {}) });

test('notes nudge the ranking: planner preference counts fully, Kev only above 50%, never past x2, and capability filters still win', () => {
  const settings = { ...DEFAULT_SETTINGS, poolSlots: { a: 1, b: 1 }, scarcity: { a: 1, b: 1 } };
  const pools = [view('a'), view('b', ['UI DEV'])];
  const score = (req: Partial<Parameters<typeof rankPools>[0]>, id: string) => rankPools({ classification: cls(), routing: null, pools, settings, ...req }).find((c) => c.agentId === id)!;

  const base = score({}, 'b').score;
  assert.equal(score({}, 'a').score, base, 'equal agents, equal score');
  assert.equal(score({ classification: cls({ 'ui dev': 0.4 }) }, 'b').score, base, 'a weak guess from Kev changes nothing');
  const guessed = score({ classification: cls({ 'ui dev': 1 }) }, 'b');
  assert.ok(Math.abs(guessed.score / base - 1.5) < 0.01, `a sure guess is x1.5 at the default weight (got ${guessed.score / base})`);
  assert.match(guessed.reasons.join(' '), /note "ui dev" ×1\.5/);
  const asked = score({ routing: { prefers: ['UI Dev'] } }, 'b');
  assert.ok(Math.abs(asked.score / base - 1.5) < 0.01, 'a planner preference counts as certain, ignoring case');
  assert.equal(rankPools({ classification: cls(), routing: { prefers: ['ui dev'] }, pools, settings })[0]!.agentId, 'b', 'the agent with the note ranks first');
  const huge = score({ routing: { prefers: ['ui dev'] }, settings: { ...settings, noteWeight: 2 } }, 'b');
  assert.ok(huge.score / base <= 2.001, 'the pull is capped at x2');
  const capped = rankPools({ classification: cls(), routing: { prefers: ['ui dev'], pools: ['a'] }, pools, settings });
  assert.equal(capped.find((c) => c.agentId === 'b')!.eligible, false, 'a routing rule is not overridden by a note');
});

test('prompts tell planners which servers exist and who may use them, and workers what they were given', () => {
  const card = { id: 'c1', title: 'Make a part', description: '', role: 'worker', branch: 'ih/c1' } as any;
  const board = { name: 'Game', mode: 'worktree' } as any;
  const planner = buildOrchestratorPrompt({ ...card, role: 'orchestrator' }, board, '/wt', { maxChildren: 12, maxDepth: 5 }, [{ agent: { id: 'ui', poolId: 'fa', model: '', role: 'worker', delegatesTo: [], enabled: true, notes: ['UI DEV'] }, pool: pool('fa') }], [], ['- roblox-studio (Roblox Studio): edits a place. Agents that may use it: ui.']);
  assert.match(planner, /\[UI DEV\]/);
  assert.match(planner, /prefers="<note>"/);
  assert.match(planner, /roblox-studio \(Roblox Studio\)/);
  assert.match(planner, /needs_mcp=\["<id>"\]/);
  const plain = buildOrchestratorPrompt({ ...card, role: 'orchestrator' }, board, '/wt', { maxChildren: 12, maxDepth: 5 }, [], [], []);
  assert.doesNotMatch(plain, /needs_mcp|prefers/, 'no servers and no notes: nothing extra in the prompt');
  const worker = buildPrompt(card, board, '/wt', [], { mcp: ['- roblox-studio (Roblox Studio): edits a place. You may use only its tools that read; the others are refused.'] });
  assert.match(worker, /MCP servers you may use/);
  assert.match(worker, /only its tools that read/);
});

test('per-session servers are started by the session itself, with {card} and {worktree} filled in; levels default sensibly', async () => {
  const ctx = await setup();
  try {
    ctx.mcp.save(entry({ id: 'solo', label: 'Solo', hosting: 'per-session', exclusive: false, command: 'tool', args: ['--card', '{card}', '--dir', '{worktree}'], env: { WORK: '{worktree}/x' } }));
    ctx.mcp.save(entry());
    const settings = { ...ctx.store.getSettings(ctx.board.id), mcp: { enabled: ['solo', 'fake'], access: {}, presets: [] } };
    const card = { id: 'c9', agentId: 'fa', role: 'worker' as const };
    const servers = ctx.mcp.sessionServers(settings, card, '/wt/c9', 'tok');
    const solo = servers.find((s) => s.name === 'solo') as any;
    assert.deepEqual(solo.args, ['--card', 'c9', '--dir', '/wt/c9']);
    assert.deepEqual(solo.env, [{ name: 'WORK', value: '/wt/c9/x' }]);
    const hub = servers.find((s) => s.name === 'fake') as any;
    assert.equal(hub.type, 'http');
    assert.match(hub.url, /\/hub\/fake$/);
    assert.deepEqual(hub.headers, [{ name: 'Authorization', value: 'Bearer tok' }], 'the hub entry carries only the session token, never the server\'s own secrets');

    assert.equal(mcpLevel(settings, 'fake', 'fa', 'worker'), 'full', 'workers get full access unless the board says otherwise');
    assert.equal(mcpLevel(settings, 'fake', 'orchestrator', 'orchestrator'), 'off', 'planners get nothing unless named');
    assert.equal(mcpLevel(settings, 'nope', 'fa', 'worker'), 'off', 'a server that is not switched on is off');
    assert.equal(ctx.mcp.sessionServers(settings, { ...card, role: 'orchestrator' }, '/wt', 'tok').length, 0);
    const readOnly = { ...settings, mcp: { ...settings.mcp, access: { solo: { default: 'read' as const, agents: {} } } } };
    assert.deepEqual(ctx.mcp.sessionServers(readOnly, card, '/wt/c9', 'tok').map((x) => x.name), ['fake'], 'a per-card server cannot be limited to reads, so read only means it is not given');
  } finally {
    await ctx.close();
  }
});
