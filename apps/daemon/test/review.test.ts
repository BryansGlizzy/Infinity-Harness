// Phase 6.1 stage 2: the operator as reviewer, comments on the diff, land now, try it locally, the chat view, and the IDE bridge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentProfile, HarnessEvent } from '@ih/core';
import type { Store } from '@ih/db';
import { git } from '../src/git.ts';
import type { IdeSocket } from '../src/ide.ts';
import { setup, status, waitFor } from './harness.ts';

async function api(port: number, method: string, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
}

const agent = (id: string, poolId: string, model = ''): AgentProfile => ({ id, poolId, model, role: 'worker', delegatesTo: [], enabled: true });
const BASE = { agents: [agent('fa', 'fa', 'fake/one'), agent('fb', 'fb')], crossReview: false, testCommand: 'test -f notes.md', landMode: 'local' as const };
const steps = (store: Store, id: string) => store.eventsFor(id).filter((e) => e.type === 'card.refinery').map((e) => (e.payload as { step: string }).step);

async function until(store: Store, check: () => boolean, ms = 20_000) {
  if (check()) return;
  await waitFor(store, () => check(), ms);
}

const said = (store: Store, cardId: string) =>
  store
    .eventsFor(cardId)
    .map((e) => (e.type === 'session.event' ? (e.payload as { event: HarnessEvent }).event : null))
    .filter((e): e is Extract<HarnessEvent, { type: 'message' }> => e?.type === 'message' && e.role === 'agent')
    .map((e) => e.text)
    .join('');

test('hold for my review: the card waits in Review until the operator approves, then lands without an agent review', async () => {
  const { store, scheduler, refinery, board, cfg, repo, close } = await setup();
  try {
    store.updateSettings(board.id, { ...BASE, humanReview: true });
    const card = store.createCard({ boardId: board.id, title: 'Notes', routing: { pools: ['fa'] }, status: 'ready' });
    scheduler.start();
    refinery.start();
    await waitFor(store, status(store, card.id, 'review'));
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(store.getCard(card.id)!.status, 'review', 'held');
    assert.ok(steps(store, card.id).includes('waiting'));
    assert.ok(!steps(store, card.id).includes('queued'));

    assert.equal((await api(cfg.port, 'POST', `/cards/${card.id}/review`, { verdict: 'maybe' })).status, 400);
    const ok = await api(cfg.port, 'POST', `/cards/${card.id}/review`, { verdict: 'approve', notes: 'Looks right' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.pipeline.humanReview.verdict, 'approve');
    await waitFor(store, status(store, card.id, 'done'));
    assert.ok(store.getCard(card.id)!.pipeline.landedSha);
    const approved = store.eventsFor(card.id).find((e) => e.type === 'card.refinery' && (e.payload as any).step === 'approved')!.payload as any;
    assert.deepEqual([approved.human, approved.notes], [true, 'Looks right']);
    assert.equal(readFileSync(join(repo, 'notes.md'), 'utf8'), 'written by fake/one\n');
    assert.equal((await api(cfg.port, 'POST', `/cards/${card.id}/review`, { verdict: 'approve' })).status, 409, 'a landed card is no longer reviewable');
  } finally {
    await close();
  }
});

test('request changes: the notes and line comments go to the author, who reworks it; a new head is reviewed afresh', async () => {
  const { store, scheduler, refinery, board, cfg, close } = await setup();
  try {
    store.updateSettings(board.id, { ...BASE, humanReview: true });
    const card = store.createCard({ boardId: board.id, title: 'Notes', routing: { pools: ['fa'] }, status: 'ready' });
    scheduler.start();
    refinery.start();
    await waitFor(store, status(store, card.id, 'review'));

    assert.equal((await api(cfg.port, 'POST', `/cards/${card.id}/review`, { verdict: 'changes', notes: '  ' })).status, 409, 'say what should change');
    const res = await api(cfg.port, 'POST', `/cards/${card.id}/review`, {
      verdict: 'changes',
      notes: 'Mention the date.',
      comments: [{ path: 'notes.md', line: 1, endLine: 2, body: 'Too terse' }, { path: 'notes.md', body: '   ' }],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.pipeline.changesRequested, 1);
    assert.equal(res.body.pipeline.humanReview, undefined);
    const delivered = store.boardMessages(board.id).filter((m) => m.toCard === card.id).map((m) => m.body).join('\n');
    assert.match(delivered, /The operator reviewed your branch and asked for changes:\n\nMention the date\.\n\nComments on the code:\n- notes\.md:1-2: Too terse/);
    assert.ok(!/notes\.md: *$/m.test(delivered), 'blank comments are dropped');

    // The author's session wakes (or the card runs again) and the card comes back to Review, held again.
    await until(store, () => said(store, card.id).includes('The operator reviewed your branch'));
    await until(store, () => store.getCard(card.id)!.status === 'review' && !(refinery as any).deciding.has(card.id));
    assert.equal(store.getCard(card.id)!.pipeline.humanReview, undefined, 'the old verdict is gone');
    assert.ok(steps(store, card.id).includes('changes_requested'));
    await api(cfg.port, 'POST', `/cards/${card.id}/review`, { verdict: 'approve' });
    await waitFor(store, status(store, card.id, 'done'));
  } finally {
    await close();
  }
});

test('land now: skips the hold and the review and goes to the front of the queue', async () => {
  const { store, scheduler, refinery, board, cfg, close } = await setup();
  try {
    store.updateSettings(board.id, { ...BASE, humanReview: true });
    const waiting = store.createCard({ boardId: board.id, title: 'Held', routing: { pools: ['fa'] }, status: 'ready' });
    scheduler.start();
    refinery.start();
    await waitFor(store, status(store, waiting.id, 'review'));
    const early = await api(cfg.port, 'POST', `/cards/${store.createCard({ boardId: board.id, title: 'Not worked yet' }).id}/land`);
    assert.equal(early.status, 409);
    const res = await api(cfg.port, 'POST', `/cards/${waiting.id}/land`);
    assert.equal(res.status, 200);
    await waitFor(store, status(store, waiting.id, 'done'));
    assert.ok(steps(store, waiting.id).includes('land_now'));
  } finally {
    await close();
  }
});

test('a comment on a line of the diff goes to the card’s agent as a message, with no verdict', async () => {
  const { store, board, cfg, close } = await setup();
  try {
    const card = store.createCard({ boardId: board.id, title: 'Anything' });
    const res = await api(cfg.port, 'POST', `/cards/${card.id}/comments`, { path: 'src/a.ts', line: 12, body: 'Why not a Map here?' });
    assert.equal(res.status, 200);
    assert.equal(res.body.body, 'Comment on your changes:\n- src/a.ts:12: Why not a Map here?');
    assert.equal(res.body.fromActor, 'user:local');
    assert.equal((await api(cfg.port, 'POST', `/cards/${card.id}/comments`, { path: '../etc/passwd', body: 'x' })).status, 400);
    assert.equal((await api(cfg.port, 'POST', `/cards/${card.id}/comments`, { body: 'no path' })).status, 400);
  } finally {
    await close();
  }
});

test('try it locally: check out the branch head (detached) or apply the diff, and never over uncommitted work', async () => {
  const { store, runner, board, cfg, repo, close } = await setup();
  try {
    store.updateSettings(board.id, BASE);
    const card = store.createCard({ boardId: board.id, title: 'Notes' });
    const done = waitFor(store, status(store, card.id, 'review'));
    await runner.run(card.id, 'fa', { agentId: 'fa' });
    await done;
    const head = (await git(repo, ['rev-parse', card.id ? store.getCard(card.id)!.branch! : 'HEAD'])).trim();

    assert.equal((await api(cfg.port, 'POST', `/cards/${card.id}/try`, { mode: 'teleport' })).status, 400);

    // A dirty checkout is refused.
    writeFileSync(join(repo, 'README.md'), 'my edit\n');
    const refused = await api(cfg.port, 'POST', `/cards/${card.id}/try`, { mode: 'checkout' });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /uncommitted changes/);
    await git(repo, ['checkout', '--', 'README.md']);

    const applied = await api(cfg.port, 'POST', `/cards/${card.id}/try`, { mode: 'apply' });
    assert.equal(applied.status, 200);
    assert.equal(readFileSync(join(repo, 'notes.md'), 'utf8'), 'written by fake/two\n');
    assert.equal(await git(repo, ['rev-parse', 'HEAD']), await git(repo, ['rev-parse', 'main']), 'HEAD did not move');
    assert.match(await git(repo, ['status', '--porcelain']), /notes\.md/);
    await git(repo, ['clean', '-fq', 'notes.md']);

    const checked = await api(cfg.port, 'POST', `/cards/${card.id}/try`, { mode: 'checkout' });
    assert.equal(checked.status, 200);
    assert.match(checked.body.summary, /detached HEAD\)\. Return with: git checkout main/);
    assert.equal(await git(repo, ['rev-parse', 'HEAD']), head);
    assert.ok(existsSync(join(repo, 'notes.md')));
    await git(repo, ['checkout', '-q', 'main']);
  } finally {
    await close();
  }
});

test('chat: one conversation per goal across its cards: agents’ words, questions to the human, the human’s replies, status changes', async () => {
  const { store, scheduler, board, cfg, close } = await setup();
  try {
    scheduler.start();
    const goal = await scheduler.startGoal(
      board.id,
      'Tidy up',
      ['CALL create_subtask {"title":"Write the notes","description":"notes.md","acceptance_criteria":["file exists"]}'].join('\n'),
    );
    await waitFor(store, status(store, goal.id, 'review'));
    const child = store.children(goal.id)[0]!;
    await waitFor(store, status(store, child.id, 'review'));

    // The child asks the human something (a message to "human"); the goal's chat shows it as a question.
    store.postMessage({ boardId: board.id, fromActor: `card:${child.id}`, toCard: null, body: 'Which license header do you want?', urgent: false });
    let chat = (await api(cfg.port, 'GET', `/cards/${goal.id}/chat`)).body;
    const kinds = chat.items.map((i: any) => i.kind);
    assert.ok(kinds.includes('agent') && kinds.includes('status') && kinds.includes('ask'));
    const ask = chat.items.find((i: any) => i.kind === 'ask');
    assert.deepEqual([ask.cardId, ask.text, ask.answered], [child.id, 'Which license header do you want?', false]);
    assert.ok(chat.items.some((i: any) => i.kind === 'agent' && i.cardId === child.id && /Done with/.test(i.text)));
    assert.ok(!chat.items.some((i: any) => i.text.startsWith('You are working on a task card')), 'the daemon’s prompts are not part of the conversation');
    assert.ok(chat.items.every((i: any, n: number, all: any[]) => !n || all[n - 1].seq <= i.seq), 'in time order');

    // The reply is a message from the human; the question is then answered, and polling after the cursor returns only news.
    await api(cfg.port, 'POST', `/cards/${child.id}/messages`, { body: 'MIT, please.' });
    chat = (await api(cfg.port, 'GET', `/cards/${goal.id}/chat`)).body;
    assert.equal(chat.items.find((i: any) => i.kind === 'ask').answered, true);
    assert.equal(chat.items.find((i: any) => i.kind === 'you').text, 'MIT, please.');
    const later = (await api(cfg.port, 'GET', `/cards/${goal.id}/chat?after=${chat.last}`)).body;
    assert.ok(later.items.every((i: any) => i.seq > chat.last));
    assert.equal((await api(cfg.port, 'GET', '/cards/c_missing/chat')).status, 404);
  } finally {
    await close();
  }
});

/** A stand-in VS Code window: answers the bridge's requests like the extension would. */
function window(handle: (req: any) => unknown | undefined): IdeSocket & { requests: any[] } {
  const callbacks: { message?: (d?: Buffer) => void; close?: () => void } = {};
  const requests: any[] = [];
  return {
    requests,
    send(data: string) {
      const req = JSON.parse(data);
      requests.push(req);
      const answer = handle(req);
      if (answer === undefined) setTimeout(() => callbacks.close?.(), 5); // the window goes away without answering
      else setTimeout(() => callbacks.message?.(Buffer.from(JSON.stringify({ id: req.id, result: answer }))), 5);
    },
    on(event: 'message' | 'close', fn: (d?: Buffer) => void) {
      callbacks[event] = fn;
    },
  };
}

test('IDE bridge: ide_* tools appear while a window is attached; ask, diagnostics and show_diff reach it', async () => {
  const ctx = await setup();
  const { store, runner, board, bridge, close } = ctx;
  try {
    const run = async (title: string, calls: string[]) => {
      const card = store.createCard({ boardId: board.id, title, description: calls.join('\n') });
      const done = waitFor(store, status(store, card.id, 'review'));
      await runner.run(card.id, 'fa', { agentId: 'fa' });
      await done;
      return card;
    };

    const none = await run('No window', ['CALL ide_ask {"question":"Which one?"}']);
    assert.match(said(store, none.id), /ide_ask -> ERROR/, 'the tools are not offered without a window');

    const win = window((req) => {
      if (req.type === 'ask') return { answer: req.options?.[1] ?? 'free text' };
      if (req.type === 'diagnostics') return { files: [{ path: req.paths[0], problems: [{ severity: 'error', line: 3, message: 'Cannot find name x' }] }] };
      if (req.type === 'show_diff') return { shown: true };
    });
    bridge.attach(board.id, win, 'Test window');
    assert.equal(bridge.attached(board.id), true);
    assert.deepEqual(bridge.windows(board.id), ['Test window']);

    const card = await run('With window', [
      'CALL ide_ask {"question":"Use Postgres or SQLite?","options":["Postgres","SQLite"]}',
      'CALL ide_diagnostics {"paths":["notes.md"]}',
      'CALL ide_diagnostics {"paths":["../../etc/passwd"]}',
      'CALL ide_show_diff {"path":"notes.md","proposed":"new text\\n"}',
    ]);
    const text = said(store, card.id);
    assert.match(text, /ide_ask -> .*"answered": true.*"answer": "SQLite"/);
    assert.match(text, /Cannot find name x/);
    assert.match(text, /Paths must be inside your worktree/);
    assert.match(text, /ide_show_diff -> .*"shown": true/);
    const askReq = win.requests.find((r) => r.type === 'ask');
    assert.deepEqual(askReq.options, ['Postgres', 'SQLite']);
    assert.equal(askReq.title, 'With window');
    const diag = win.requests.find((r) => r.type === 'diagnostics');
    assert.equal(diag.paths[0], join(store.getCard(card.id)!.worktree!, 'notes.md'), 'paths are made absolute inside the card’s worktree');
    assert.equal(win.requests.filter((r) => r.type === 'diagnostics').length, 1, 'the outside path never reached the window');
  } finally {
    await close();
  }
});

test('IDE bridge: a window that goes away or can’t show a diff turns the request into a message to the humans', async () => {
  const ctx = await setup();
  const { store, runner, board, bridge, close } = ctx;
  try {
    const run = async (title: string, calls: string[]) => {
      const card = store.createCard({ boardId: board.id, title, description: calls.join('\n') });
      const done = waitFor(store, status(store, card.id, 'review'));
      await runner.run(card.id, 'fa', { agentId: 'fa' });
      await done;
      return card;
    };
    bridge.attach(board.id, window(() => undefined)); // closes without answering
    const asks = await run('Asks', ['CALL ide_ask {"question":"Ship it?","options":["yes","no"]}']);
    assert.match(said(store, asks.id), /ide_ask -> .*"answered": false/);
    assert.ok(store.boardMessages(board.id).some((m) => m.fromActor === `card:${asks.id}` && m.body === 'Question (yes / no): Ship it?'));
    assert.equal(bridge.attached(board.id), false, 'the closed window is gone');

    bridge.attach(board.id, window(() => ({ error: 'no file is open there' })));
    const shows = await run('Shows', ['CALL ide_show_diff {"path":"notes.md","proposed":"x"}']);
    assert.match(said(store, shows.id), /ide_show_diff -> .*"shown": false/);
    assert.ok(store.boardMessages(board.id).some((m) => m.fromActor === `card:${shows.id}` && /Proposed change to notes\.md/.test(m.body)));
  } finally {
    await close();
  }
});

test('IDE bridge over the real socket: /ws/ide registers a window for its board', async () => {
  const { board, cfg, bridge, close } = await setup();
  try {
    const bad = new WebSocket(`ws://127.0.0.1:${cfg.port}/ws/ide?board=b_missing`);
    await new Promise((r) => (bad.onclose = r));
    assert.equal(bridge.attached(board.id), false);

    const ws = new WebSocket(`ws://127.0.0.1:${cfg.port}/ws/ide?board=${board.id}&name=Test%20Code`);
    ws.onmessage = (m) => ws.send(JSON.stringify({ id: JSON.parse(String(m.data)).id, result: { answer: 'from the editor' } }));
    await new Promise((r) => (ws.onopen = r));
    for (let i = 0; i < 40 && !bridge.attached(board.id); i++) await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual((await api(cfg.port, 'GET', `/boards/${board.id}/ide`)).body, { attached: true, windows: ['Test Code'] });
    assert.deepEqual(await bridge.request(board.id, 'ask', { question: 'q' }, 5000), { answer: 'from the editor' });
    ws.close();
    for (let i = 0; i < 40 && bridge.attached(board.id); i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(bridge.attached(board.id), false);
    assert.equal(await bridge.request(board.id, 'ask', { question: 'q' }, 100), null);
  } finally {
    await close();
  }
});
