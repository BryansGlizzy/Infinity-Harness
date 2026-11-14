import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { HarnessEvent, McpLibraryEntry } from '@ih/core';
import type { Store } from '@ih/db';
import { builtinMcp } from '../src/mcp-hub.ts';
import { buildEfficiency } from '../src/report.ts';
import { buildPrompt } from '../src/runner.ts';
import { setup, status, waitFor } from './harness.ts';

const fakeMcp = fileURLToPath(new URL('./fake-mcp-server.mjs', import.meta.url));
const entry = (over: Partial<McpLibraryEntry> = {}): McpLibraryEntry => ({
  id: 'fake', label: 'Fake Studio', description: 'd', transport: 'stdio', command: process.execPath, args: [fakeMcp], env: { FAKE_DOWN: '1' }, hosting: 'shared', exclusive: true, toolKinds: {}, autoStart: false, ...over,
});
const said = (store: Store, cardId: string) =>
  store.eventsFor(cardId).map((e) => (e.type === 'session.event' ? (e.payload as { event: HarnessEvent }).event : null)).filter((e): e is Extract<HarnessEvent, { type: 'message' }> => e?.type === 'message' && e.role === 'agent').map((e) => e.text).join('');
async function api(port: number, method: string, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json()) as any };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
async function runWorker(ctx: Ctx, title: string, lines: string[], extra: Partial<Parameters<Store['createCard']>[0]> = {}) {
  const card = ctx.store.createCard({ boardId: ctx.board.id, title, description: lines.join('\n'), ...extra });
  const done = waitFor(ctx.store, status(ctx.store, card.id, 'review'));
  await ctx.runner.run(card.id, 'fa', { agentId: 'fa' });
  await done;
  return card;
}
const enable = (ctx: Ctx) => ctx.store.updateSettings(ctx.board.id, { mcp: { enabled: ['fake'], access: {}, presets: [] } });

test('a tool allowlist keeps the long tail out of agents\' lists and calls, and an empty one offers everything again', async () => {
  const ctx = await setup();
  try {
    ctx.mcp.save(entry({ toolAllow: ['look'] }));
    enable(ctx);
    const view = (await api(ctx.cfg.port, 'POST', '/mcp/fake/start')).body;
    assert.deepEqual(view.tools.map((t: any) => [t.name, t.offered]).sort(), [['change', false], ['down', false], ['look', true], ['unmarked', false]]);
    const card = await runWorker(ctx, 'Allowlist', ['LISTTOOLS fake', 'CALL fake:change {}', 'CALL fake:look {}']);
    const text = said(ctx.store, card.id);
    assert.match(text, /tools=look(?!,)/, 'only the allowed tool is listed');
    assert.match(text, /ERROR .*"change" is not offered on this board/);
    assert.match(text, /saw nothing/, 'the allowed one still works');
    ctx.mcp.save(entry({ toolAllow: [] }));
    await ctx.mcp.restart('fake');
    const all = await runWorker(ctx, 'All again', ['LISTTOOLS fake']);
    assert.match(said(ctx.store, all.id), /tools=look,change,down,unmarked|tools=.*change/, 'an explicit empty list means every tool');
  } finally {
    await ctx.close();
  }
});

test('the Roblox servers ship with short tool lists, the Studio server first, and RbxSync reduced to the two things only it does', () => {
  const [studio, rbx] = ['roblox-studio', 'rbxsync'].map((id) => builtinMcp('/x').find((e) => e.id === id)!) as [McpLibraryEntry, McpLibraryEntry];
  assert.ok(studio.toolAllow!.length >= 20 && studio.toolAllow!.length <= 30, `about two dozen, got ${studio.toolAllow!.length}`);
  for (const t of ['execute_luau', 'get_runtime_logs', 'solo_playtest', 'set_script_source', 'get_connected_instances']) assert.ok(studio.toolAllow!.includes(t), t);
  for (const t of ['manage_experience', 'manage_monetization', 'upload_asset', 'capture_micro_profiler', 'manage_instance', 'generate_model']) assert.ok(!studio.toolAllow!.includes(t), `${t} stays out`);
  assert.deepEqual(rbx.toolAllow, ['sync_to_studio', 'extract_game'], 'sync_to_studio is needed because autoSync is off; extract_game pulls an existing place into files');
  for (const e of [studio, rbx]) assert.match(e.unavailableHint!, /addon_status.*ask_parent.*report_blocked/s);
});

test('a server that cannot reach what it drives: the failure carries the hint, and after two the hub answers at once without calling it', async () => {
  const ctx = await setup();
  try {
    ctx.mcp.save(entry({ unavailableHint: 'Do not investigate. Call ask_parent.' }));
    enable(ctx);
    const card = await runWorker(ctx, 'Down', ['CALL fake:down {}', 'CALL fake:down {}', 'CALL fake:down {}', 'CALL fake:look {}']);
    const text = said(ctx.store, card.id);
    assert.match(text, /upstream call #1\)\s*Do not investigate\. Call ask_parent\./, 'the first failure already carries the hint');
    assert.match(text, /upstream call #2\)/);
    assert.match(text, /is not reachable right now \(Studio is not connected.*Do not investigate/, 'the third is refused by the hub');
    assert.doesNotMatch(text, /upstream call #3/, 'and never reached the server');
    assert.match(text, /fake:look -> ERROR Fake Studio is not reachable right now/, 'every tool is held while the breaker is open: the server is what is down');
  } finally {
    await ctx.close();
  }
});

test('a person\'s stop keeps the card stopped (it used to restart at once); Run picks the conversation up where it stopped', async () => {
  const ctx = await setup();
  try {
    ctx.scheduler.start();
    const card = ctx.store.createCard({ boardId: ctx.board.id, title: 'Long one', description: 'SLOW' });
    void ctx.runner.run(card.id, 'fa', { agentId: 'fa' });
    for (let i = 0; i < 60 && ctx.runner.sessionState(card.id) !== 'busy'; i++) await new Promise((r) => setTimeout(r, 50));
    const stopped = waitFor(ctx.store, status(ctx.store, card.id, 'blocked'));
    assert.equal((await api(ctx.cfg.port, 'POST', `/cards/${card.id}/cancel`)).status, 200);
    await stopped;
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(ctx.store.getCard(card.id)!.status, 'blocked', 'still stopped after the scheduler had several ticks');
    assert.equal(ctx.store.listSessions(card.id).length, 1, 'no second session was started');
    const events = ctx.store.eventsFor(card.id);
    const c = events.find((e) => e.type === 'card.cancelled')!.payload as any;
    assert.equal(c.by, 'user:local');
    assert.equal(c.requeue, false);
    assert.equal((events.find((e) => e.type === 'session.interrupted')!.payload as any).reason, 'cancelled', 'noted so Run resumes it');
    assert.match(ctx.store.boardMessages(ctx.board.id).map((m) => m.body).join('\n'), /was stopped by you and stays stopped/);
    const report = buildEfficiency(ctx.store, ctx.board.id).cards.find((x) => x.id === card.id)!;
    assert.deepEqual(report.cancels, [{ by: 'user:local', n: 1 }], 'the report says who stopped it');

    // The daemon's own cancels still send a card back to Ready.
    const other = ctx.store.createCard({ boardId: ctx.board.id, title: 'Daemon cancel', description: 'SLOW' });
    void ctx.runner.run(other.id, 'fa', { agentId: 'fa' });
    for (let i = 0; i < 60 && ctx.runner.sessionState(other.id) !== 'busy'; i++) await new Promise((r) => setTimeout(r, 50));
    ctx.scheduler.stop();
    await ctx.runner.cancel(other.id);
    for (let i = 0; i < 60 && ctx.store.getCard(other.id)!.status !== 'ready'; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(ctx.store.getCard(other.id)!.status, 'ready');
  } finally {
    await ctx.close();
  }
});

test('ask_parent: with no live planner the human is told and the question waits in its inbox', async () => {
  const ctx = await setup();
  try {
    const parent = ctx.store.createCard({ boardId: ctx.board.id, title: 'The planner', role: 'lead' });
    const child = await runWorker(ctx, 'Stuck child', ['CALL ask_parent {"question":"Studio is down, what now?","tried":"checked twice"}'], { parentId: parent.id });
    const text = said(ctx.store, child.id);
    assert.match(text, /answered.*false/);
    assert.match(text, /human was told/);
    const msgs = ctx.store.boardMessages(ctx.board.id);
    assert.ok(msgs.some((m) => m.toCard === parent.id && /Studio is down, what now\?/.test(m.body) && /checked twice/.test(m.body)), 'the planner gets it with what was tried');
    assert.ok(msgs.some((m) => m.toCard === null && /is stuck and its planner is not available/.test(m.body)), 'and so does the human');
    const orphan = await runWorker(ctx, 'Top card', ['CALL ask_parent {"question":"Anyone there?"}'], { role: 'worker' });
    assert.match(said(ctx.store, orphan.id), /no planner above it/);
  } finally {
    await ctx.close();
  }
});

const noopDef = (ready: () => boolean | null) => ({
  id: 'fakeworld', label: 'Fake World', description: 'd', servers: ['fake'], boardModes: ['direct' as const, 'worktree' as const],
  guide: ['Use fake tools first.', 'If it fails call addon_status.'],
  status: async () => ({ ready: ready(), parts: [{ id: 'plug', label: 'Fake plugin', connected: ready(), detail: 'press connect' }], advice: ready() ? 'All connected.' : 'Fake plugin is not connected: press connect.' }),
});

test('cards that need an add-on wait while its outside half is down, are told once, and start when it is back; addon_status and the guide tell agents the same', async () => {
  const ctx = await setup();
  try {
    let up = false;
    ctx.addons.register(noopDef(() => up));
    ctx.mcp.save(entry());
    ctx.store.updateSettings(ctx.board.id, { addons: ['fakeworld'], mcp: { enabled: ['fake'], access: {}, presets: [] } });
    await ctx.addons.status(ctx.board.id, 'fakeworld');
    const view = (await api(ctx.cfg.port, 'GET', `/boards/${ctx.board.id}/addons`)).body[0];
    assert.equal(view.ready, false);
    assert.match(view.advice, /not connected/);
    assert.deepEqual(view.components.find((c: any) => c.kind === 'plugin'), { id: 'fakeworld:plug', label: 'Fake plugin', kind: 'plugin', state: 'stopped', detail: 'press connect' });

    ctx.scheduler.start();
    const card = ctx.store.createCard({ boardId: ctx.board.id, title: 'Needs the fake', routing: { needsMcp: ['fake'] }, status: 'ready' });
    const plain = ctx.store.createCard({ boardId: ctx.board.id, title: 'Needs nothing', status: 'ready' });
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(ctx.store.getCard(card.id)!.status, 'ready', 'held');
    assert.notEqual(ctx.store.getCard(plain.id)!.status, 'ready', 'a card that does not need the add-on is not held');
    const waiting = ctx.store.boardMessages(ctx.board.id).filter((m) => /is waiting, not started: Waiting for Fake World/.test(m.body));
    assert.equal(waiting.length, 1, 'said once, not on every tick');

    ctx.store.updateSettings(ctx.board.id, { addonGate: false });
    assert.equal(ctx.addons.holdReason(ctx.store.getCard(card.id)!), null, 'the setting turns the gate off');
    ctx.store.updateSettings(ctx.board.id, { addonGate: true });

    // addon_status as an agent sees it.
    const asker = await runWorker(ctx, 'Asks', ['CALL addon_status {}']);
    assert.match(said(ctx.store, asker.id), /addon_status -> .*"ready": false.*Fake plugin is not connected/);

    up = true;
    await ctx.addons.status(ctx.board.id, 'fakeworld');
    for (let i = 0; i < 80 && ctx.store.getCard(card.id)!.status === 'ready'; i++) await new Promise((r) => setTimeout(r, 100));
    assert.notEqual(ctx.store.getCard(card.id)!.status, 'ready', 'it starts by itself once connected');
    assert.deepEqual(ctx.addons.guideLines(ctx.board.id), ['Use fake tools first.', 'If it fails call addon_status.']);
  } finally {
    ctx.scheduler.stop();
    await ctx.close();
  }
});

test('worker prompts carry the stuck rule and the add-on guide; planner prompts say they may be asked', () => {
  const card = { id: 'c1', title: 'Make a part', description: '', role: 'worker', branch: 'ih/c1' } as any;
  const board = { name: 'Game', mode: 'worktree' } as any;
  const p = buildPrompt(card, board, '/wt', [], { mcp: ['- roblox-studio (Roblox Studio): edits a place.'], guide: ['GUIDE-LINE-ONE'] });
  assert.match(p, /When you are stuck: .*ask_parent once/s);
  assert.match(p, /GUIDE-LINE-ONE/);
  assert.doesNotMatch(buildPrompt(card, board, '/wt', [], { mcp: [], guide: ['GUIDE-LINE-ONE'] }), /GUIDE-LINE-ONE/, 'no access to the servers, no guide');
});

test('the efficiency report counts steps, failures, probing, diagnosing and refusals per card, and flags what looks wasteful', async () => {
  const ctx = await setup();
  try {
    const card = ctx.store.createCard({ boardId: ctx.board.id, title: 'Burner' });
    const s = ctx.store.createSession({ cardId: card.id, poolId: 'fa', harness: 'opencode', model: 'm' });
    ctx.store.updateSession(s.id, { state: 'ended' });
    ctx.store.createSession({ cardId: card.id, poolId: 'fa', harness: 'opencode', model: 'm' });
    ctx.store.createSession({ cardId: card.id, poolId: 'fa', harness: 'opencode', model: 'm' });
    const ev = (event: object) => ctx.store.append('session.event', card.id, { sessionId: s.id, event }, 'x');
    for (let i = 0; i < 9; i++) ev({ type: 'tool_call', id: `t${i}`, title: i % 2 ? 'ps aux | grep roblox' : 'tail -n 30 /home/u/.var/app/org.vinegarhq.Vinegar/log.txt' });
    ev({ type: 'tool_call', id: 'w', title: 'Write notes.md' });
    for (let i = 0; i < 3; i++) ev({ type: 'permission', decision: 'rejected', title: 'find /home', reason: 'outside' });
    for (let i = 0; i < 8; i++) ctx.store.append('mcp.call', card.id, { server: 'rbxsync', tool: 'connection_status', ms: 1, ok: i > 4, bytes: 10, agentId: 'fa', write: false }, 'x');
    ctx.store.append('mcp.call', card.id, { server: 'rbxsync', tool: 'diff', ms: 30002, ok: false, bytes: 0, agentId: 'fa', write: false }, 'x');
    const r = buildEfficiency(ctx.store, ctx.board.id).cards.find((c) => c.id === card.id)!;
    assert.equal(r.steps, 10);
    assert.equal(r.diagnosticShell, 9);
    assert.equal(r.refused, 3);
    assert.deepEqual({ calls: r.mcp.calls, failed: r.mcp.failed, probes: r.mcp.probes }, { calls: 9, failed: 6, probes: 8 });
    assert.ok(r.mcp.failedSeconds >= 30);
    assert.equal(r.restarts, 2);
    for (const flag of [/started over 2 times/, /6 MCP calls failed/, /8 calls only asked whether the other side was there/, /9 shell commands that look like diagnosing/, /3 calls refused/]) assert.ok(r.flags.some((f) => flag.test(f)), String(flag));
    const api1 = (await api(ctx.cfg.port, 'GET', `/boards/${ctx.board.id}/efficiency`)).body;
    assert.equal(api1.cards.find((c: any) => c.id === card.id).steps, 10);
    assert.ok(api1.totals.steps >= 10);
  } finally {
    await ctx.close();
  }
});

test('ask_parent: a live planner is woken, answers, and the worker gets the answer in the same call', async () => {
  const ctx = await setup();
  try {
    // The planner's session is kept open (idle) after its turn, as a real planner's is.
    const parent = ctx.store.createCard({ boardId: ctx.board.id, title: 'The lead', role: 'lead' });
    const parked = waitFor(ctx.store, status(ctx.store, parent.id, 'review'));
    await ctx.runner.run(parent.id, 'fa', { agentId: 'fa' });
    await parked;
    for (let i = 0; i < 40 && ctx.runner.sessionState(parent.id) !== 'idle'; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(ctx.runner.sessionState(parent.id), 'idle');

    // The question carries a scripted line, so the fake planner replies the way a real one would: with post_message.
    const child = ctx.store.createCard({ boardId: ctx.board.id, title: 'Blocked child', parentId: parent.id });
    const tried = `waited\nCALL post_message {"to":"${child.id}","body":"Skip Studio: write the files, I will tell the human."}`;
    ctx.store.updateCard(child.id, { description: `CALL ask_parent ${JSON.stringify({ question: 'Studio is down, what now?', tried, timeout_seconds: 20 })}` });
    const done = waitFor(ctx.store, status(ctx.store, child.id, 'review'));
    await ctx.runner.run(child.id, 'fb', { agentId: 'fb' });
    await done;
    const text = said(ctx.store, child.id);
    assert.match(text, /ask_parent -> .*"answered": true/);
    assert.match(text, /Skip Studio: write the files, I will tell the human\./);
    assert.ok(!ctx.store.boardMessages(ctx.board.id).some((m) => m.toCard === null && /is stuck and/.test(m.body)), 'the human was not bothered when the planner answered');
  } finally {
    await ctx.close();
  }
});

test('an add-on\'s link state is pushed to clients live: once per real change, nothing for a repeat, and a last one when it is switched off', async () => {
  const ctx = await setup();
  try {
    let up = false;
    ctx.addons.register(noopDef(() => up));
    ctx.mcp.save(entry());
    const pushed: { subject: string; payload: any }[] = [];
    ctx.live.subscribe((m) => m.type === 'addon.status' && pushed.push({ subject: m.subject, payload: m.payload }));
    ctx.store.updateSettings(ctx.board.id, { addons: ['fakeworld'], mcp: { enabled: ['fake'], access: {}, presets: [] } });

    await ctx.addons.status(ctx.board.id, 'fakeworld');
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0]!.subject, ctx.board.id, 'addressed to the board, so other boards\' pages ignore it');
    assert.equal(pushed[0]!.payload.ready, false);
    assert.deepEqual(pushed[0]!.payload.components.find((c: any) => c.kind === 'plugin')?.state, 'stopped');

    await ctx.addons.status(ctx.board.id, 'fakeworld');
    assert.equal(pushed.length, 1, 'read again, nothing changed, nothing sent');

    up = true;
    await ctx.addons.status(ctx.board.id, 'fakeworld');
    assert.equal(pushed.length, 2);
    assert.equal(pushed[1]!.payload.ready, true);
    assert.equal(pushed[1]!.payload.components.find((c: any) => c.kind === 'plugin')?.state, 'running');

    up = false;
    await ctx.addons.status(ctx.board.id, 'fakeworld');
    assert.equal(pushed.length, 3, 'a plugin dropping out is pushed too');
    assert.equal(pushed[2]!.payload.advice.includes('not connected'), true);

    await ctx.addons.disable(ctx.board.id, 'fakeworld');
    assert.equal(pushed.at(-1)!.payload.enabled, false, 'switching it off tells the page to drop the chip');
    assert.equal(pushed.at(-1)!.payload.components.some((c: any) => c.kind === 'plugin'), false);
  } finally {
    await ctx.close();
  }
});
