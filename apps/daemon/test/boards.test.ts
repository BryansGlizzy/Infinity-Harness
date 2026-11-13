// Removing a board: forgetting it (the folder stays) or also deleting the folder (typed confirmation, refused for
// folders the daemon must never delete).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/git.ts';
import { setup, status, tempRepo, waitFor } from './harness.ts';

const api = (t: Awaited<ReturnType<typeof setup>>) => {
  const base = `http://127.0.0.1:${t.cfg.port}`;
  return {
    info: (id: string) => fetch(`${base}/api/boards/${id}/removal`),
    remove: (id: string, body: unknown) => fetch(`${base}/api/boards/${id}/remove`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  };
};

/** A board with a worker that has run (so it has a worktree and a branch), plus notes, a message and usage. */
async function busy(t: Awaited<ReturnType<typeof setup>>) {
  const card = t.store.createCard({ boardId: t.board.id, title: 'Write notes', description: 'Create NOTES.md' });
  const done = waitFor(t.store, status(t.store, card.id, 'review'));
  await t.runner.run(card.id, 'fa', { agentId: 'fa' });
  await done;
  t.store.postMessage({ boardId: t.board.id, fromActor: `card:${card.id}`, toCard: null, body: 'hello', urgent: false });
  t.store.recordUsage({ poolId: 'fa', source: 'otel', boardId: t.board.id, cardId: card.id, inputTokens: 10, outputTokens: 5 });
  return t.store.getCard(card.id)!;
}

test('forget: the board and its records go, the card worktrees go, the project folder and its branches stay', async () => {
  const t = await setup();
  try {
    const card = await busy(t);
    const other = t.store.createBoard({ name: 'Other', repoPath: await tempRepo(), defaultBranch: 'main' });
    const otherCard = t.store.createCard({ boardId: other.id, title: 'Untouched' });
    assert.ok(existsSync(card.worktree!));

    const info = await (await api(t).info(t.board.id)).json();
    assert.equal(info.cards, 1);
    assert.equal(info.worktrees, 1);
    assert.equal(info.dirtyWorktrees, 0);
    assert.equal(info.folder.git, true);
    assert.equal(info.folder.unlandedBranches, 1, 'the card\'s branch has not landed');
    assert.equal(info.deleteBlocked, null);

    const res = await api(t).remove(t.board.id, { mode: 'forget' });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.deepEqual([out.removed, out.mode, out.keptWorktrees, out.deletedFolder], [true, 'forget', [], null]);

    assert.equal(t.store.getBoard(t.board.id), undefined);
    assert.equal(t.store.getCard(card.id), undefined);
    assert.equal(t.store.listSessions(card.id).length, 0);
    assert.equal(t.store.eventsFor(card.id).length, 0);
    assert.equal(t.store.boardMessages(t.board.id).length, 0);
    assert.equal(t.store.listArtifacts(t.board.id, {}).length, 0, 'its notes (and their search index) are gone');
    assert.equal(t.store.usageTotals(t.board.id).requests, 0);
    assert.ok(!existsSync(card.worktree!), 'the card worktree folder is gone');
    assert.ok(existsSync(join(t.repo, 'README.md')), 'the project folder is untouched');
    assert.match(await git(t.repo, ['branch', '--list', 'ih/*']), /ih\//, 'and so is the card\'s branch, with its work');
    assert.equal((await git(t.repo, ['worktree', 'list'])).split('\n').length, 1, 'no worktree is registered any more');
    // Another board is not affected.
    assert.ok(t.store.getBoard(other.id));
    assert.ok(t.store.getCard(otherCard.id));
    assert.equal((await api(t).info(t.board.id)).status, 404);
    assert.equal((await api(t).remove(t.board.id, { mode: 'forget' })).status, 404);
  } finally {
    await t.close();
  }
});

test('a card worktree with uncommitted work is kept when only forgetting, and said so', async () => {
  const t = await setup();
  try {
    const card = await busy(t);
    writeFileSync(join(card.worktree!, 'unsaved.txt'), 'precious\n');
    const info = await (await api(t).info(t.board.id)).json();
    assert.equal(info.dirtyWorktrees, 1);
    const out = await (await api(t).remove(t.board.id, { mode: 'forget' })).json();
    assert.deepEqual(out.keptWorktrees, [card.worktree]);
    assert.ok(existsSync(join(card.worktree!, 'unsaved.txt')));
    assert.equal(t.store.getBoard(t.board.id), undefined, 'the board itself is gone');
  } finally {
    await t.close();
  }
});

test('delete: the name must be typed back; then the folder and everything is gone', async () => {
  const t = await setup();
  try {
    const card = await busy(t);
    writeFileSync(join(card.worktree!, 'unsaved.txt'), 'x');
    for (const body of [{ mode: 'delete' }, { mode: 'delete', confirmName: 'demo' }, { mode: 'delete', confirmName: 'Demo ' }]) {
      const res = await api(t).remove(t.board.id, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match((await res.json()).error, /type the board's name exactly: Demo/);
    }
    assert.ok(existsSync(t.repo), 'nothing was deleted by the refused attempts');
    assert.ok(t.store.getBoard(t.board.id));
    assert.equal((await api(t).remove(t.board.id, { mode: 'sideways' })).status, 400);

    const res = await api(t).remove(t.board.id, { mode: 'delete', confirmName: 'Demo' });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.mode, 'delete');
    assert.ok(out.deletedFolder.endsWith(t.repo.split('/').pop()));
    assert.ok(!existsSync(t.repo), 'the project folder is gone');
    assert.ok(!existsSync(card.worktree!), 'and the card worktrees, dirty or not');
    assert.equal(t.store.getBoard(t.board.id), undefined);
  } finally {
    await t.close();
  }
});

test('folders the daemon must never delete are refused, and so is a board that is landing a card', async () => {
  const t = await setup();
  try {
    const mk = (name: string, repoPath: string) => t.store.createBoard({ name, repoPath, defaultBranch: 'main', mode: 'direct' });
    const info = async (id: string) => (await (await api(t).info(id)).json()) as { deleteBlocked: string | null };
    const refuse = async (name: string, path: string, why: RegExp) => {
      const b = mk(name, path);
      assert.match((await info(b.id)).deleteBlocked ?? '', why, name);
      const res = await api(t).remove(b.id, { mode: 'delete', confirmName: name });
      assert.equal(res.status, 409, name);
      assert.ok(existsSync(path), `${name}: still there`);
      assert.ok(t.store.getBoard(b.id), `${name}: the board is still there`);
      await api(t).remove(b.id, { mode: 'forget' }); // so it does not count against the next case
    };
    await refuse('Home', homedir(), /home folder/);
    await refuse('Root', '/', /too close to the top/);
    await refuse('Harness', t.cfg.dataDir, /holds Infinity Harness/);
    const parentOfData = join(t.cfg.dataDir, '..');
    await refuse('Parent', parentOfData, /too close to the top|holds Infinity Harness/);
    // Another board's folder nested inside, and this one nested inside another's.
    const outer = await tempRepo();
    const inner = join(outer, 'packages', 'inner');
    mkdirSync(inner, { recursive: true });
    mk('Inner', inner);
    await refuse('Outer', outer, /uses a folder inside this one/);
    const nested = join(t.repo, 'sub');
    mkdirSync(nested);
    await refuse('Nested', nested, /inside the folder of the board "Demo"/);
    // A symbolic link.
    const link = join(await tempRepo(), 'link');
    symlinkSync(t.repo, link);
    await refuse('Link', link, /symbolic link/);

    // Forgetting is still fine for all of them, and leaves the folder alone.
    const forgot = mk('ForgetHome', homedir());
    assert.equal((await api(t).remove(forgot.id, { mode: 'forget' })).status, 200);
    assert.ok(existsSync(homedir()));

    // A card in the merge queue: wait.
    const card = t.store.createCard({ boardId: t.board.id, title: 'Landing' });
    t.store.updateCard(card.id, { status: 'merging' });
    const res = await api(t).remove(t.board.id, { mode: 'forget' });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /being landed/);
    assert.ok(t.store.getBoard(t.board.id));
  } finally {
    await t.close();
  }
});

test('open requests from other swarms end honestly, and what the board shared is withdrawn', async () => {
  const t = await setup({ federation: true });
  try {
    const fed = t.federation!;
    fed.saveDraft(t.board.id, { name: 'Demo', oneLine: 'd', provides: ['demo'], accepts: { requests: true, note: '' } }, 'manual');
    fed.publish(t.board.id, 'basic');
    const peer = t.store.fed.createPeer({ label: 'beta', trust: 'verified', swarmId: 'sw_b', name: 'Beta', publicKey: 'k', fingerprint: 'f' });
    const goal = t.store.createCard({ boardId: t.board.id, title: '[Beta] Fix it', role: 'orchestrator' });
    const mine = t.store.fed.createRequest({ direction: 'in', peerId: peer.id, remoteId: 'theirs1', title: 'Fix it', description: 'x', status: 'in_progress', origin: { swarmId: 'sw_b', cardId: null, hops: ['sw_b'] }, boardId: t.board.id, cardId: goal.id });
    const info = await (await api(t).info(t.board.id)).json();
    assert.deepEqual(info.federation, { sharing: true, openIn: 1, openOut: 0 });

    assert.equal((await api(t).remove(t.board.id, { mode: 'forget' })).status, 200);
    const after = t.store.fed.getRequest(mine.id)!;
    assert.equal(after.status, 'declined');
    assert.match(after.thread.at(-1)!.text, /project was removed/);
    assert.equal(after.boardId, null, 'kept as history, detached from the board');
    assert.equal(after.cardId, null);
    assert.equal(t.store.fed.listShared().length, 0);
    assert.deepEqual(fed.directoryFor({ trust: 'trusted', shares: 'full' }), [], 'nothing of it is offered to peers any more');
  } finally {
    await t.close();
  }
});

test('a client is told when a board is removed', async () => {
  const t = await setup();
  try {
    const seen: string[] = [];
    t.store.onEvent((e) => e.type === 'board.removed' && seen.push(e.subject));
    await api(t).remove(t.board.id, { mode: 'forget' });
    assert.deepEqual(seen, [t.board.id]);
  } finally {
    await t.close();
  }
});
