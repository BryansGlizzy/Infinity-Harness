// The extension's daemon client and board matching, against a real in-process daemon with fake agents
// (the vscode API itself is only typechecked; these parts don't need it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Board, DaemonEvent, LiveMessage } from '@mh/core';
import { setup, status, waitFor } from '../../daemon/test/harness.ts';
import { DaemonClient, EventStream, HttpError } from '../src/client.ts';
import { boardsForFolders, folderInRepo } from '../src/match.ts';

const board = (id: string, repoPath: string): Board => ({ id, name: id, repoPath, defaultBranch: 'main', mode: 'worktree', createdAt: '' });

test('boardsForFolders: the board whose repository holds the workspace folder, closest first', () => {
  const base = mkdtempSync(join(tmpdir(), 'mh-vsc-'));
  for (const d of ['repo/app/src', 'repo/app/inner', 'other']) mkdirSync(join(base, d), { recursive: true });
  const outer = board('outer', join(base, 'repo'));
  const inner = board('inner', join(base, 'repo', 'app'));
  const other = board('other', join(base, 'other'));
  assert.ok(folderInRepo(join(base, 'repo'), outer.repoPath));
  assert.ok(folderInRepo(join(base, 'repo', 'app', 'src'), outer.repoPath));
  assert.ok(!folderInRepo(join(base, 'repo-two'), outer.repoPath), 'a sibling with a common prefix is not inside');
  assert.deepEqual(boardsForFolders([outer, other, inner], [join(base, 'repo', 'app', 'src')]).map((b) => b.id), ['inner', 'outer']);
  assert.deepEqual(boardsForFolders([outer, other], [join(base, 'elsewhere')]), []);
});

test('DaemonClient: health, boards, folder info, a card’s changes as before/after files, messages and the event stream', async () => {
  const { store, runner, board: b, repo, cfg, close } = await setup();
  const client = new DaemonClient(`http://127.0.0.1:${cfg.port}`);
  const events: (DaemonEvent | LiveMessage)[] = [];
  let connected = false;
  const stream = new EventStream(() => client.wsUrl('/ws'), (e) => events.push(e), (c) => (connected = c));
  try {
    assert.equal(await client.healthy(), true);
    assert.equal(await new DaemonClient('http://127.0.0.1:9').healthy(), false);
    assert.deepEqual((await client.boards()).map((x) => x.id), [b.id]);
    const info = await client.folder(repo);
    assert.ok(info.git && folderInRepo(info.git.root, repo) && info.git.commits >= 1);

    for (let i = 0; i < 50 && !connected; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(connected, 'the event stream connects');

    // A card the fake agent works: it writes notes.md, the daemon commits it on the card's branch.
    const card = store.createCard({ boardId: b.id, title: 'Write notes' });
    const done = waitFor(store, status(store, card.id, 'review'));
    await runner.run(card.id, 'fa');
    await done;
    const changes = await client.changes(card.id);
    assert.equal(changes.landed, false);
    assert.deepEqual(changes.files.map((f) => [f.path, f.status.charAt(0)]), [['notes.md', 'A']]);
    assert.equal((await client.file(card.id, 'notes.md', 'to')).content, 'written by fake/two\n');
    await assert.rejects(client.file(card.id, 'notes.md', 'from'), (e: unknown) => e instanceof HttpError && e.status === 404, 'added: no before version');
    assert.equal((await client.file(card.id, 'README.md', 'from')).content, '# demo\n');

    // The policy notice for the fake agent's /etc/hosts write reaches the humans' inbox.
    const inbox = (await client.messages(b.id)).filter((m) => m.toCard === null);
    assert.ok(inbox.some((m) => m.fromActor === 'daemon:policy' && m.body.includes('/etc/hosts')));
    await client.sendMessage(card.id, 'please also add a title', false);
    assert.ok((await client.messages(b.id)).some((m) => m.toCard === card.id && m.body === 'please also add a title'));

    assert.ok(events.some((e) => !('live' in e) && e.type === 'card.created' && e.subject === card.id), 'card.created arrived on the stream');
    assert.ok(events.some((e) => !('live' in e) && e.type === 'message.posted'), 'message.posted arrived on the stream');
    assert.equal(client.wsUrl('/ws/terminal/c_1'), `ws://127.0.0.1:${cfg.port}/ws/terminal/c_1`);
  } finally {
    stream.dispose();
    await close();
  }
});

test('status summaries: pools with their fullest window, recent usage, budgets that warn, goals and their subtrees', async () => {
  const { compact, poolLines, usageLines, boardTooltip, goalsOf, subtreeOf } = await import('../src/summary.ts');
  assert.deepEqual([compact(950), compact(1500), compact(15_000), compact(2_400_000)], ['950', '1.5k', '15k', '2.4M']);
  const pools = [
    { id: 'claude', label: 'Claude Pro', running: 1, status: { state: 'warn' as const, windows: [{ window: '5h', pct: 82 }, { window: '7d', pct: 40 }] } },
    { id: 'nim', label: 'NVIDIA NIM', running: 0, status: { state: 'open' as const, windows: [] } },
  ];
  assert.deepEqual(poolLines(pools), ['$(warning) **Claude Pro** warn · 5-hour 82% · 1 working', '$(circle-filled) **NVIDIA NIM** open']);
  const usage = { hours: 24, totals: { tokens: 15_000, costUsd: 0.42, requests: 9 }, budgets: [{ scope: 'board', pct: 85, state: 'warn' as const }, { scope: 'kimi', pct: 10, state: 'open' as const }] };
  assert.deepEqual(usageLines(usage), ['Last 24h: 15k tokens · $0.42', '$(warning) Budget for the board at 85%']);
  assert.deepEqual(usageLines(null), []);
  const card = (id: string, over: object) => ({ id, boardId: 'b', parentId: null, title: id, role: 'worker', status: 'ready', createdAt: id, ...over }) as any;
  const cards = [card('g1', { role: 'orchestrator', createdAt: '1' }), card('g2', { role: 'orchestrator', createdAt: '2' }), card('w1', { parentId: 'g1', status: 'in_progress' }), card('w2', { parentId: 'w1', status: 'review' })];
  assert.deepEqual(goalsOf(cards).map((c) => c.id), ['g2', 'g1']);
  assert.deepEqual(subtreeOf(cards, 'g1').map((c) => c.id).sort(), ['g1', 'w1', 'w2']);
  const tip = boardTooltip({ id: 'b', name: 'Demo', repoPath: '/x', defaultBranch: 'main', mode: 'worktree', createdAt: '' }, cards, 2, pools, usage);
  assert.match(tip, /\*\*Demo\*\*: 1 working, 1 in review, 2 need you\./);
  assert.match(tip, /Claude Pro/);
  assert.match(tip, /Last 24h/);
});

test('DaemonClient and EventStream: the API token travels on requests and the socket, and a reconnect resumes without repeats or gaps', async () => {
  const token = 'tok-123';
  const { store, board: b, cfg, close } = await setup({ auth: { token, requireToken: true, loopbackBound: true, allowedHosts: [] } });
  const url = `http://127.0.0.1:${cfg.port}`;
  const anonymous = new DaemonClient(url);
  const client = new DaemonClient(url, token);
  const seqs: number[] = [];
  let connected = false;
  const stream = new EventStream(() => client.wsUrl('/ws'), (e) => !('live' in e) && seqs.push(e.seq), (c) => (connected = c));
  try {
    assert.equal(await anonymous.healthy(), true, 'health needs no token');
    await assert.rejects(anonymous.boards(), (e: unknown) => e instanceof HttpError && e.status === 401);
    assert.deepEqual((await client.boards()).map((x) => x.id), [b.id]);
    for (let i = 0; i < 50 && !connected; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(connected, 'the socket connects with the token in its address');

    store.createCard({ boardId: b.id, title: 'before' });
    await waitUntil(() => seqs.length >= 2);
    // The connection drops; events happen while it is down; the new connection replays exactly those.
    const seen = Math.max(...seqs);
    stream.reconnect();
    store.createCard({ boardId: b.id, title: 'while away' });
    await waitUntil(() => seqs.length > 2 && Math.max(...seqs) === store.lastEventSeq());
    assert.equal(new Set(seqs).size, seqs.length, 'no event twice');
    assert.deepEqual(seqs.filter((s) => s > seen), Array.from({ length: store.lastEventSeq() - seen }, (_, i) => seen + 1 + i), 'no event missing');
  } finally {
    stream.dispose();
    await close();
  }
});

async function waitUntil(cond: () => boolean, ms = 5000) {
  for (let t = 0; !cond(); t += 20) {
    if (t > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
