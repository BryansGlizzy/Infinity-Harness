// Phase 6.4 governance and 6.5 tool grants: the approval queue, agents asking for agents / MCP servers / skills / grants,
// the agent docs, and the notification text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, type HarnessEvent } from '@mh/core';
import { FastLane, notificationJob, readNotification } from '@mh/fast-lane';
import type { Store } from '@mh/db';
import { activeGrants, expandGrant, extraMcpServers, grantsSection, skillsSection, splitInstalled } from '../src/tools.ts';
import { buildPrompt } from '../src/runner.ts';
import { fakeInstaller, setup, status, waitFor } from './harness.ts';

async function until(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function api(port: number, method: string, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** What the fake agent said (its tool results are echoed as `tool -> result`). */
const said = (store: Store, cardId: string) =>
  store
    .eventsFor(cardId)
    .map((e) => (e.type === 'session.event' ? (e.payload as { event: HarnessEvent; sessionId: string }).event : null))
    .filter((e): e is Extract<HarnessEvent, { type: 'message' }> => e?.type === 'message' && e.role === 'agent')
    .map((e) => e.text)
    .join('');

/** Messages sent to a card, delivered or not (an idle session wakes up and takes them at once). */
const inbox = (store: Store, boardId: string, cardId: string) => store.boardMessages(boardId).filter((m) => m.toCard === cardId).map((m) => m.body).join('\n');

/** Waits until the card's session is idle again (a message wakes it for another turn). */
async function quiet(ctx: Awaited<ReturnType<typeof setup>>, cardId: string) {
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 50));
    if (ctx.runner.sessionState(cardId) !== 'busy' && ctx.runner.sessionState(cardId) !== 'starting') return;
  }
}

const permit = (store: Store, boardId: string, role: 'worker' | 'orchestrator' | 'lead', patch: object) => {
  const current = store.getSettings(boardId).permissions;
  store.updateSettings(boardId, { permissions: { ...current, [role]: { ...current[role], ...patch } } });
};

async function runWorker(ctx: Awaited<ReturnType<typeof setup>>, title: string, calls: string[], until: 'review' | 'blocked' = 'review') {
  const { store, runner, board } = ctx;
  const card = store.createCard({ boardId: board.id, title, description: calls.join('\n') });
  const done = waitFor(store, status(store, card.id, until));
  await runner.run(card.id, 'fa', { agentId: 'fa' });
  await done;
  return card;
}

test('spawn_agent: refused without permission; with it, a human approves and the agent joins the team', async () => {
  const ctx = await setup();
  const { store, board, cfg, close } = ctx;
  try {
    const call = 'CALL spawn_agent {"id":"fb-helper","pool":"fb","model":"fake/two","role":"worker","reason":"needs a second opinion"}';
    const denied = await runWorker(ctx, 'No permission', [call]);
    assert.match(said(store, denied.id), /spawn_agent -> ERROR Your role \(worker\) may not spawn agents/);

    permit(store, board.id, 'worker', { canSpawnAgents: true });
    const asked = await runWorker(ctx, 'Asks', [call]);
    assert.match(said(store, asked.id), /"pending": ?"ap_/);
    const [pending] = store.listApprovals(board.id, { status: 'pending' });
    assert.equal(pending!.kind, 'spawn_agent');
    assert.equal(pending!.cardId, asked.id);
    assert.match(pending!.summary, /fb-helper/);
    assert.ok(store.getSettings(board.id).agents.every((a) => a.id !== 'fb-helper'), 'nothing changes while it is pending');
    assert.ok(store.boardMessages(board.id).some((m) => m.fromActor === 'daemon:approvals' && /Approval needed/.test(m.body)), 'the humans are told');

    const decided = await api(cfg.port, 'POST', `/approvals/${pending!.id}/decide`, { decision: 'approve', note: 'ok' });
    assert.equal(decided.body.status, 'approved');
    assert.equal(decided.body.decidedBy, 'user:local');
    const joined = store.getSettings(board.id).agents.find((a) => a.id === 'fb-helper');
    assert.deepEqual([joined?.poolId, joined?.model, joined?.role], ['fb', 'fake/two', 'worker']);
    assert.match(inbox(store, board.id, asked.id), /Approved: agent "fb-helper" now exists/);
    await quiet(ctx, asked.id);

    // A decision is final.
    assert.equal((await api(cfg.port, 'POST', `/approvals/${pending!.id}/decide`, { decision: 'deny' })).status, 409);
    // An unknown pool never reaches the queue.
    const bad = await runWorker(ctx, 'Bad pool', ['CALL spawn_agent {"id":"x","pool":"nope","reason":"why not"}']);
    assert.match(said(store, bad.id), /No pool "nope"/);
  } finally {
    await close();
  }
});

test('spawn_agent with autoApproveSpawn is applied at once, and still leaves a record', async () => {
  const ctx = await setup();
  const { store, board, close } = ctx;
  try {
    permit(store, board.id, 'worker', { canSpawnAgents: true });
    store.updateSettings(board.id, { autoApproveSpawn: true });
    const card = await runWorker(ctx, 'Spawns', ['CALL spawn_agent {"id":"auto-one","pool":"fb","reason":"more hands"}']);
    assert.match(said(store, card.id), /"approved": ?true/);
    assert.ok(store.getSettings(board.id).agents.some((a) => a.id === 'auto-one'));
    const [a] = store.listApprovals(board.id);
    assert.deepEqual([a!.status, a!.decidedBy], ['approved', 'auto']);
  } finally {
    await close();
  }
});

test('denying a request tells the agent and changes nothing', async () => {
  const ctx = await setup();
  const { store, board, approvals, close } = ctx;
  try {
    permit(store, board.id, 'worker', { canSpawnAgents: true });
    const card = await runWorker(ctx, 'Asks', ['CALL spawn_agent {"id":"nope-agent","pool":"fb","reason":"just because"}']);
    const [pending] = store.listApprovals(board.id, { status: 'pending' });
    approvals.decide(pending!.id, 'denied', 'user:local', 'we have enough agents');
    assert.ok(store.getSettings(board.id).agents.every((a) => a.id !== 'nope-agent'));
    assert.match(inbox(store, board.id, card.id), /Denied: we have enough agents/);
    await quiet(ctx, card.id);
  } finally {
    await close();
  }
});

test('propose_mcp and propose_skill wait for a human; approved servers and skills reach new sessions', async () => {
  const ctx = await setup();
  const { store, board, approvals, close } = ctx;
  try {
    const mcp = 'CALL propose_mcp {"name":"docs-search","command":"npx","args":["-y","docs-mcp"],"reason":"read vendor docs"}';
    const skill = 'CALL propose_skill {"name":"python-tests","description":"How to run Python tests here","body":"Run pytest -q from the repo root, never from a subfolder."}';
    const off = await runWorker(ctx, 'Not allowed', [mcp, skill]);
    assert.match(said(store, off.id), /may not propose MCP servers or skills/);

    permit(store, board.id, 'worker', { canInstallMcp: true });
    const card = await runWorker(ctx, 'Proposes', [mcp, skill, 'CALL propose_mcp {"name":"board","command":"x","reason":"hijack"}', 'CALL propose_mcp {"name":"both","command":"x","url":"http://x.test/mcp","reason":"confused"}']);
    const text = said(store, card.id);
    assert.match(text, /propose_mcp -> .*"pending"/);
    assert.match(text, /propose_skill -> .*"pending"/);
    assert.match(text, /"board" is reserved/);
    assert.match(text, /either command .* or url/);
    const pending = store.listApprovals(board.id, { status: 'pending' });
    assert.deepEqual(pending.map((p) => p.kind).sort(), ['install_mcp', 'install_skill']);
    assert.equal(store.getSettings(board.id).mcpServers.length, 0);

    for (const p of pending) approvals.decide(p.id, 'approved', 'user:local');
    const s = store.getSettings(board.id);
    assert.deepEqual(s.mcpServers, [{ name: 'docs-search', command: 'npx', args: ['-y', 'docs-mcp'], env: {} }]);
    assert.equal(s.skills[0]!.name, 'python-tests');

    // The next worker prompt carries the skill; its session gets the server.
    const next = store.createCard({ boardId: board.id, title: 'Later work' });
    assert.deepEqual(extraMcpServers(s, next, '/wt').map((x) => x.name), ['docs-search']);
    const prompt = buildPrompt(next, board, '/wt', [], { settings: s });
    assert.match(prompt, /Skills this board approved/);
    assert.match(prompt, /### python-tests: How to run Python tests here/);
    assert.match(prompt, /never from a subfolder/);
    assert.match(prompt, /get_docs explains/);
    const ran = await runWorker(ctx, 'Real run', []);
    const first = store.eventsFor(ran.id).map((e) => (e.payload as any)?.event).find((e) => e?.role === 'user')?.text as string;
    assert.match(first, /python-tests/, 'a real session is told about the approved skill');
  } finally {
    await close();
  }
});

test('tool grants: auto ones are given, approval ones hold the card until a human decides, off ones are refused', async () => {
  const ctx = await setup();
  const { store, board, runner, approvals, scheduler, close } = ctx;
  try {
    store.updateSettings(board.id, {
      grants: {
        browser: { label: 'Browser', description: 'A headless browser', command: 'npx', args: ['pw', '--out', '/tmp/mh-browser/{card}'], env: { OUT: '{worktree}/x' }, mode: 'approval' },
        shell2: { label: 'Extra shell', description: 'Another shell', command: 'sh2', args: [], env: {}, mode: 'auto' },
        computer: { label: 'Computer', description: 'Desktop', command: '', args: [], env: {}, mode: 'off' },
      },
    });
    // An orchestrator plans cards with grants.
    scheduler.start();
    const goal = await scheduler.startGoal(
      board.id,
      'Check the UI',
      [
        'CALL create_subtask {"title":"Check the UI in a browser","description":"Open the page and look","acceptance_criteria":["screenshot taken"],"grants":["browser","shell2"],"needs_network":true}',
        'CALL create_subtask {"title":"Impossible tool","description":"x","acceptance_criteria":["y"],"grants":["computer"]}',
        'CALL create_subtask {"title":"Unknown tool","description":"x","acceptance_criteria":["y"],"grants":["teleporter"]}',
      ].join('\n'),
    );
    await waitFor(store, status(store, goal.id, 'review'));
    const text = said(store, goal.id);
    assert.match(text, /No tool grant "computer" is available/);
    assert.match(text, /No tool grant "teleporter" is available/);

    const card = store.children(goal.id).find((c) => c.title === 'Check the UI in a browser')!;
    assert.deepEqual(card.grants, ['shell2'], 'the auto grant is given; the browser waits');
    assert.equal(card.routing?.needsNetwork, true);
    const [pending] = store.listApprovals(board.id, { status: 'pending' });
    assert.deepEqual([pending!.kind, pending!.cardId, pending!.payload], ['grant', card.id, { grant: 'browser' }]);

    await new Promise((r) => setTimeout(r, 700)); // several scheduler ticks
    assert.equal(store.getCard(card.id)!.status, 'ready', 'the card does not start while its grant is undecided');
    assert.equal(runner.isActive(card.id), false);

    approvals.decide(pending!.id, 'approved', 'user:local');
    assert.deepEqual(store.getCard(card.id)!.grants, ['shell2', 'browser']);
    await waitFor(store, status(store, card.id, 'review'));

    // What the session gets: the board's server plus one MCP server per grant, with {card} and {worktree} filled in.
    const s = store.getSettings(board.id);
    const done = store.getCard(card.id)!;
    const servers = extraMcpServers(s, done, done.worktree!);
    assert.deepEqual(servers.map((x) => x.name), ['grant-shell2', 'grant-browser']);
    const browser = servers[1] as { command: string; args: string[]; env: { name: string; value: string }[] };
    assert.deepEqual(browser.args, ['pw', '--out', `/tmp/mh-browser/${card.id}`]);
    assert.deepEqual(browser.env, [{ name: 'OUT', value: `${done.worktree}/x` }]);
    assert.match(grantsSection(s, done).join('\n'), /grant-browser \(Browser\): A headless browser/);
  } finally {
    await close();
  }
});

test('request_grant: a worker asks for a grant for its own card; asking twice returns the pending request', async () => {
  const ctx = await setup();
  const { store, board, close } = ctx;
  try {
    store.updateSettings(board.id, { grants: { browser: { label: 'Browser', description: 'd', command: 'npx', args: [], env: {}, mode: 'approval' }, quick: { label: 'Quick', description: 'd', command: 'q', args: [], env: {}, mode: 'auto' } } });
    const card = await runWorker(ctx, 'Wants tools', [
      'CALL request_grant {"grant":"browser","reason":"to check the page"}',
      'CALL request_grant {"grant":"browser","reason":"to check the page"}',
      'CALL request_grant {"grant":"quick","reason":"fast"}',
      'CALL request_grant {"grant":"computer","reason":"nope"}',
    ]);
    assert.equal(store.listApprovals(board.id, { status: 'pending' }).length, 1, 'the same request is not queued twice');
    assert.deepEqual(store.getCard(card.id)!.grants, ['quick']);
    assert.match(said(store, card.id), /"granted": ?"quick"/);
    assert.match(said(store, card.id), /No tool grant "computer"/);
    permit(store, board.id, 'worker', { canRequestGrants: false });
    const refused = await runWorker(ctx, 'Not allowed', ['CALL request_grant {"grant":"browser","reason":"please"}']);
    assert.match(said(store, refused.id), /may not request tool grants/);
  } finally {
    await close();
  }
});

test('escalations wait in the queue; answering one resumes the card with the human’s note', async () => {
  const ctx = await setup();
  const { store, board, cfg, close } = ctx;
  try {
    const card = await runWorker(ctx, 'Needs a decision', ['CALL escalate_to_human {"reason":"Which database should this use?"}'], 'blocked');
    const [pending] = store.listApprovals(board.id, { status: 'pending' });
    assert.equal(pending!.kind, 'escalation');
    assert.equal(pending!.cardId, card.id);
    assert.match(pending!.summary, /Which database/);
    assert.equal(store.getCard(card.id)!.pipeline.escalated, true);
    assert.ok(store.boardMessages(board.id).some((m) => /Needs a human: Which database/.test(m.body)), 'the usual message is still sent');
    assert.equal(store.boardMessages(board.id).filter((m) => m.fromActor === 'daemon:approvals').length, 0, 'and not announced twice');

    const list = (await api(cfg.port, 'GET', `/boards/${board.id}/approvals?status=pending`)).body;
    assert.equal(list.length, 1);

    await api(cfg.port, 'POST', `/approvals/${pending!.id}/decide`, { decision: 'approve', note: 'Use SQLite.' });
    const after = store.getCard(card.id)!;
    assert.equal(after.pipeline.escalated, false);
    assert.equal(['ready', 'in_progress', 'review'].includes(after.status), true, 'the card is back in play');
    assert.match(inbox(store, board.id, card.id), /A human answered your escalation: Use SQLite\./);
    await quiet(ctx, card.id);
    assert.equal((await api(cfg.port, 'POST', '/approvals/ap_missing/decide', { decision: 'approve' })).status, 404);
    assert.equal((await api(cfg.port, 'POST', `/approvals/${pending!.id}/decide`, { decision: 'maybe' })).status, 400);
  } finally {
    await close();
  }
});

test('get_docs serves the agent docs: a topic list, then a topic', async () => {
  const ctx = await setup();
  const { store, cfg, close } = ctx;
  try {
    const docs = join(cfg.root, 'docs', 'agents');
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, 'conventions.md'), '# Conventions\nReserve paths before editing.\n');
    writeFileSync(join(docs, 'board-tools.md'), '# Board tools\n');
    const card = await runWorker(ctx, 'Reads docs', ['CALL get_docs {}', 'CALL get_docs {"topic":"conventions"}', 'CALL get_docs {"topic":"missing"}']);
    const text = said(store, card.id);
    assert.match(text, /"topics": \[ "board-tools", "conventions" \]/);
    assert.match(text, /Reserve paths before editing/);
    assert.match(text, /No doc "missing"/);
  } finally {
    await close();
  }
});

test('the fast lane words approval notifications (job #8) and the plain summary is the fallback', async () => {
  const lane = new FastLane({
    gatewayUrl: 'http://gw',
    token: 't',
    chain: [{ poolId: 'groq', model: 'g' }],
    poolState: () => 'open',
    fetch: (async (_u: string, init: RequestInit) => {
      const system = JSON.parse(String(init.body)).messages[0].content as string;
      const content = system.startsWith('You write a short notification') ? 'Worker "Proposes" wants a docs-search server; approving gives it to new sessions.' : 'x';
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
    }) as typeof fetch,
  });
  const ctx = await setup({ lane });
  const { store, board, approvals, close } = ctx;
  try {
    const card = store.createCard({ boardId: board.id, title: 'Proposes' });
    const a = await approvals.request({ boardId: board.id, cardId: card.id, kind: 'install_mcp', payload: { mcp: { name: 'docs-search', command: 'npx' } }, requestedBy: `card:${card.id}`, summary: 'plain summary' });
    assert.match(a.summary, /wants a docs-search server/);
    store.updateSettings(board.id, { notificationText: false });
    const b = await approvals.request({ boardId: board.id, cardId: card.id, kind: 'install_mcp', payload: { mcp: { name: 'other', command: 'npx' } }, requestedBy: `card:${card.id}`, summary: 'plain summary' });
    assert.equal(b.summary, 'plain summary');
    assert.equal(readNotification('```\n"Hi."\n```'), null, 'too short to be a notification');
    assert.equal(notificationJob('grant', ['Grant: browser']).priority, 3);
  } finally {
    await close();
  }
});

test('tool helpers: switched-off and command-less grants are not active; skills are capped', () => {
  const settings = { ...DEFAULT_SETTINGS, grants: { ...DEFAULT_SETTINGS.grants, custom: { label: 'C', description: 'd', command: 'c', args: ['{card}'], env: {}, mode: 'auto' as const } } };
  assert.deepEqual(activeGrants(settings, { grants: ['browser', 'computer', 'custom', 'nope'] }).map(([n]) => n), ['browser', 'custom'], 'computer has no command yet');
  assert.deepEqual(expandGrant(settings.grants.custom!, { id: 'c_9' }, '/w').args, ['c_9']);
  assert.deepEqual(skillsSection([]), []);
  assert.ok(skillsSection([{ name: 'big', description: 'd', body: 'x'.repeat(9000) }]).join('').length < 4300);
  assert.equal(DEFAULT_SETTINGS.grants.browser!.mode, 'approval', 'a browser needs a human by default');
});

test('the shipped grants are Vercel’s agent-browser and agent-desktop, as stdio MCP servers; a board that saved the old Playwright grant gets agent-browser', async () => {
  const { browser, computer } = DEFAULT_SETTINGS.grants;
  assert.deepEqual([browser!.command, browser!.args, browser!.mode], ['agent-browser', ['mcp'], 'approval']);
  assert.deepEqual([computer!.command, computer!.args, computer!.mode], ['agent-desktop', ['mcp'], 'off'], 'the real desktop is opt-in');
  // One isolated session and one output folder per card.
  const s = expandGrant(browser!, { id: 'c_42' }, '/wt');
  assert.equal(s.env.AGENT_BROWSER_SESSION, 'mh-c_42');
  assert.equal(s.env.AGENT_BROWSER_SCREENSHOT_DIR, '/tmp/mh-browser/c_42');
  assert.match(grantsSection({ grants: DEFAULT_SETTINGS.grants }, { grants: ['browser'] }).join('\n'), /agent-browser skills get core/);

  const { store, board, close } = await setup();
  try {
    // Settings saved before the swap held the Playwright command; the operator's mode survives.
    store.db.prepare('INSERT OR REPLACE INTO settings (board_id, settings_json) VALUES (?, ?)').run(
      board.id,
      JSON.stringify({ grants: { browser: { label: 'Browser', description: 'd', command: 'npx', args: ['-y', '@playwright/mcp@latest'], env: {}, mode: 'auto' } } }),
    );
    const g = store.getSettings(board.id).grants.browser!;
    assert.deepEqual([g.command, g.args, g.mode], ['agent-browser', ['mcp'], 'auto']);
  } finally {
    await close();
  }
});

test('a granted tool that isn’t installed is left out of the session and the humans are told how to install it', async () => {
  const ctx = await setup();
  const { store, runner, board, close } = ctx;
  try {
    assert.deepEqual(splitInstalled(DEFAULT_SETTINGS, { grants: ['browser', 'computer'] }, (c) => c === 'agent-browser'), { usable: ['browser'], missing: [] }, 'computer is off, so it is neither');
    store.updateSettings(board.id, { grants: { ...DEFAULT_SETTINGS.grants, computer: { ...DEFAULT_SETTINGS.grants.computer!, mode: 'auto', install: 'npm install -g agent-desktop' } } });
    const card = store.createCard({ boardId: board.id, title: 'Look at the app', grants: ['computer'] });
    const done = waitFor(store, status(store, card.id, 'review'));
    await runner.run(card.id, 'fa', { agentId: 'fa' });
    await done;
    const note = store.boardMessages(board.id).find((m) => m.fromActor === 'daemon:grants')!;
    assert.match(note.body, /isn't installed on this machine/);
    assert.match(note.body, /npm install -g agent-desktop/);
    const prompt = store.eventsFor(card.id).map((e) => (e.payload as any)?.event).find((e) => e?.role === 'user')?.text as string;
    assert.ok(!/grant-computer/.test(prompt), 'the prompt doesn’t promise a tool the session lacks');
  } finally {
    await close();
  }
});

const withTool = (store: Store, boardId: string, install = 'install agent-browser') =>
  store.updateSettings(boardId, { grants: { browser: { label: 'Browser', description: 'A browser', command: 'agent-browser', args: ['mcp'], env: {}, install, mode: 'auto' } } });

test('a card granted a tool that isn’t installed waits while the humans are asked once; approving installs it and the card then starts with it', async () => {
  const installer = fakeInstaller();
  const ctx = await setup({ installer });
  const { store, board, scheduler, approvals, cfg, close } = ctx;
  try {
    withTool(store, board.id);
    const card = store.createCard({ boardId: board.id, title: 'Check the UI', grants: ['browser'], status: 'ready' });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 700)); // many scheduler ticks
    assert.equal(store.getCard(card.id)!.status, 'ready', 'held');
    const asked = store.listApprovals(board.id);
    assert.equal(asked.length, 1, 'asked once, however many ticks');
    assert.deepEqual([asked[0]!.kind, asked[0]!.payload, asked[0]!.cardId], ['install_tool', { grant: 'browser' }, card.id]);
    assert.match(asked[0]!.summary, /agent-browser/);
    assert.deepEqual(installer.installs, [], 'nothing runs before approval');

    const res = await api(cfg.port, 'POST', `/approvals/${asked[0]!.id}/decide`, { decision: 'approve' });
    assert.equal(res.body.status, 'approved');
    await waitFor(store, status(store, card.id, 'review'));
    assert.deepEqual(installer.installs, ['install agent-browser'], 'ran the grant’s own install command');
    assert.ok(store.boardMessages(board.id).some((m) => /Installed Browser/.test(m.body)));
    const prompt = store.eventsFor(card.id).map((e) => (e.payload as any)?.event).find((e) => e?.role === 'user')?.text as string;
    assert.match(prompt, /grant-browser/, 'the session got the tool');
    assert.equal(store.listApprovals(board.id).length, 1, 'and nobody was asked again');
    void approvals;
  } finally {
    await close();
  }
});

test('a denied install lets the card start without the tool, and tells the humans; a failed install says why and the card still goes on', async () => {
  const installer = fakeInstaller();
  const ctx = await setup({ installer });
  const { store, board, scheduler, approvals, close } = ctx;
  try {
    withTool(store, board.id);
    const a = store.createCard({ boardId: board.id, title: 'Denied one', grants: ['browser'], status: 'ready' });
    scheduler.start();
    await until(() => store.listApprovals(board.id, { status: 'pending' }).length === 1);
    approvals.decide(store.listApprovals(board.id)[0]!.id, 'denied', 'user:local');
    await waitFor(store, status(store, a.id, 'review'));
    assert.deepEqual(installer.installs, []);
    assert.ok(store.boardMessages(board.id).some((m) => m.fromActor === 'daemon:grants' && /isn't installed/.test(m.body)));
    const prompt = store.eventsFor(a.id).map((e) => (e.payload as any)?.event).find((e) => e?.role === 'user')?.text as string;
    assert.ok(!/grant-browser/.test(prompt));

    // Another board with an install command that fails.
    const b2 = store.createBoard({ name: 'Two', repoPath: ctx.repo, defaultBranch: 'main' });
    store.updateSettings(b2.id, { poolSlots: { fa: 3, fb: 3 }, grants: { browser: { label: 'Browser', description: 'd', command: 'agent-browser', args: [], env: {}, install: 'explode', mode: 'auto' } } });
    const c = store.createCard({ boardId: b2.id, title: 'Fails to install', grants: ['browser'], status: 'ready' });
    await until(() => store.listApprovals(b2.id, { status: 'pending' }).length === 1);
    approvals.decide(store.listApprovals(b2.id)[0]!.id, 'approved', 'user:local');
    await waitFor(store, status(store, c.id, 'review'));
    assert.ok(store.boardMessages(b2.id).some((m) => /Installing Browser failed.*boom: no such package/s.test(m.body)));
  } finally {
    await close();
  }
});

test('the tools API reports what is installed and installs on the operator’s click; a grant with no install command can’t be installed', async () => {
  const installer = fakeInstaller(new Set(['other']));
  const ctx = await setup({ installer });
  const { store, board, cfg, close } = ctx;
  try {
    withTool(store, board.id);
    const before = (await api(cfg.port, 'GET', `/boards/${board.id}/tools`)).body;
    assert.deepEqual(before, [{ name: 'browser', command: 'agent-browser', installed: false, installable: true }]);
    const done = (await api(cfg.port, 'POST', `/boards/${board.id}/tools/browser/install`)).body;
    assert.deepEqual([done.ok, done.installed], [true, true]);
    assert.equal((await api(cfg.port, 'GET', `/boards/${board.id}/tools`)).body[0].installed, true);
    assert.equal((await api(cfg.port, 'POST', `/boards/${board.id}/tools/nope/install`)).status, 409);
    store.updateSettings(board.id, { grants: { custom: { label: 'C', description: 'd', command: 'c', args: [], env: {}, mode: 'auto' } } });
    assert.equal((await api(cfg.port, 'POST', `/boards/${board.id}/tools/custom/install`)).status, 409, 'no install command');
  } finally {
    await close();
  }
});

test('create_subtask tells the orchestrator when a granted tool still has to be installed', async () => {
  const ctx = await setup({ installer: fakeInstaller() });
  const { store, board, scheduler, close } = ctx;
  try {
    withTool(store, board.id);
    const goal = await scheduler.startGoal(board.id, 'UI check', 'CALL create_subtask {"title":"Look at the page","description":"open it","acceptance_criteria":["seen"],"grants":["browser"]}');
    await waitFor(store, status(store, goal.id, 'review'));
    assert.match(said(store, goal.id), /Not installed on this machine: browser\. The human will be asked to install it before the card starts/);
  } finally {
    await close();
  }
});

test('the real installer runs a shell command with the daemon’s environment, reports failure with its output, and finds commands on PATH', async () => {
  const { shellInstaller } = await import('../src/installer.ts');
  const inst = shellInstaller({ ...process.env, MH_TEST_WORD: 'installed' });
  assert.equal(inst.isInstalled('node'), true);
  assert.equal(inst.isInstalled('definitely-not-a-real-command-xyz'), false);
  const ok = await inst.run('echo $MH_TEST_WORD && true');
  assert.deepEqual([ok.ok, ok.output.trim()], [true, 'installed']);
  const bad = await inst.run('echo nope >&2; exit 3');
  assert.deepEqual([bad.ok, bad.output.trim()], [false, 'nope']);
});
