import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentProfile, DaemonEvent, Settings } from '@ih/core';
import type { Store } from '@ih/db';
import { advanceBranch, git } from '../src/git.ts';
import type { GitHub } from '../src/github.ts';
import { isGitHubRemote } from '../src/github.ts';
import { parseVerdict } from '../src/refinery.ts';
import { setup, waitFor } from './harness.ts';

const agent = (id: string, poolId: string, model = ''): AgentProfile => ({ id, poolId, model, role: 'worker', delegatesTo: [], enabled: true });
/** fa writes "written by fake/one", fb "written by fake/two": the same file with different content. */
const AGENTS = [agent('fa', 'fa', 'fake/one'), agent('fb', 'fb')];
const QUIET: Partial<Settings> = { agents: AGENTS, crossReview: false, testCommand: 'test -f notes.md', landMode: 'local' };

const steps = (store: Store, id: string) => store.eventsFor(id).filter((e) => e.type === 'card.refinery').map((e) => (e.payload as { step: string }).step);
const settled = (store: Store, ids: string[], statuses = ['done', 'blocked']) => (e: DaemonEvent) =>
  e.type === 'card.updated' && ids.every((id) => statuses.includes(store.getCard(id)!.status));

async function until(store: Store, check: () => boolean, ms = 30_000) {
  if (check()) return;
  await waitFor(store, () => check(), ms);
}

test('parseVerdict and GitHub remote detection', () => {
  assert.deepEqual(parseVerdict('Looks fine.\nVERDICT: APPROVE'), { verdict: 'approve', notes: 'Looks fine.' });
  assert.deepEqual(parseVerdict('VERDICT: APPROVE or VERDICT: CHANGES (instructions)\n...\n**VERDICT: CHANGES**\n- handle zero'), { verdict: 'changes', notes: '- handle zero' });
  assert.equal(parseVerdict('no idea').verdict, null);
  assert.ok(isGitHubRemote('git@github.com:me/repo.git'));
  assert.ok(isGitHubRemote('https://github.com/me/repo'));
  assert.ok(!isGitHubRemote('/srv/git/repo.git'));
  assert.ok(!isGitHubRemote(null));
});

test('advanceBranch fast-forwards a clean checkout and refuses a dirty one', async () => {
  const { repo, close } = await setup();
  try {
    await git(repo, ['checkout', '-q', '-b', 'side']);
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    await git(repo, ['add', 'a.txt']);
    await git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'a']);
    const sha = await git(repo, ['rev-parse', 'HEAD']);
    await git(repo, ['checkout', '-q', 'main']);
    writeFileSync(join(repo, 'README.md'), 'local edit\n');
    const refused = await advanceBranch(repo, 'main', sha);
    assert.equal(refused.ok, false);
    assert.match((refused as { reason: string }).reason, /uncommitted changes/);
    await git(repo, ['checkout', '--', 'README.md']);
    assert.deepEqual(await advanceBranch(repo, 'main', sha), { ok: true });
    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'a\n');
  } finally {
    await close();
  }
});

test('local landing: dependencies land in order as merge commits, tests gate them, and the lead is done after', async () => {
  const { store, scheduler, refinery, board, repo, close } = await setup();
  try {
    store.updateSettings(board.id, QUIET);
    const lead = store.createCard({ boardId: board.id, title: 'Chunk', role: 'lead', status: 'review' });
    const a = store.createCard({ boardId: board.id, parentId: lead.id, title: 'First part', routing: { pools: ['fa'] } });
    const b = store.createCard({ boardId: board.id, parentId: lead.id, title: 'Second part', routing: { pools: ['fb'] } });
    store.addDependency(b.id, a.id);
    store.updateCard(a.id, { status: 'ready' });
    store.updateCard(b.id, { status: 'ready' });
    scheduler.start();
    refinery.start();
    await until(store, () => store.getCard(lead.id)!.status === 'done');

    for (const id of [a.id, b.id]) {
      const card = store.getCard(id)!;
      assert.equal(card.status, 'done');
      assert.ok(card.pipeline.landedSha);
      assert.deepEqual(steps(store, id).filter((s) => s !== 'waiting'), ['queued', 'updating', 'testing', 'landed']);
    }
    // One landing commit per card on main, in dependency order; the clean checkout of main followed along.
    assert.deepEqual((await git(repo, ['log', '--first-parent', '--format=%s', 'main'])).split('\n'), ['Second part', 'First part', 'init']);
    assert.equal(readFileSync(join(repo, 'notes.md'), 'utf8'), 'written by fake/two\n');
    assert.match(await git(repo, ['log', '-1', '--format=%b', 'main']), new RegExp(`Card: ${b.id}\\nAgent: fb`));
    assert.equal(await git(repo, ['status', '--porcelain']), '');
  } finally {
    await close();
  }
});

test('a conflict goes back to the author first, then to another agent, which resolves it', async () => {
  const { store, runner, scheduler, refinery, board, close } = await setup();
  try {
    store.updateSettings(board.id, QUIET);
    // Both cards add notes.md with different content, from the same starting point: whichever lands second conflicts.
    const a = store.createCard({ boardId: board.id, title: 'Notes from one' });
    const b = store.createCard({ boardId: board.id, title: 'Notes from two' });
    const reviewed = waitFor(store, settled(store, [a.id, b.id], ['review']));
    await runner.run(a.id, 'fa', { agentId: 'fa', model: 'fake/one' });
    await runner.run(b.id, 'fb', { agentId: 'fb' });
    await reviewed;
    scheduler.start();
    refinery.start();
    await until(store, () => [a, b].every((c) => store.getCard(c.id)!.status === 'done'), 40_000);

    const loser = [a, b].find((c) => steps(store, c.id).includes('conflict'))!;
    const loserSteps = steps(store, loser.id);
    assert.equal(loserSteps.filter((s) => s === 'conflict').length, 2, loserSteps.join());
    assert.ok(loserSteps.indexOf('reassigned') > loserSteps.indexOf('conflict'));
    assert.equal(loserSteps[loserSteps.length - 1], 'landed');
    const mail = store.boardMessages(board.id).filter((m) => m.toCard === loser.id);
    assert.match(mail.find((m) => m.fromActor === 'daemon:refinery')!.body, /conflicts with main in: notes\.md/);
    assert.match(mail.find((m) => m.fromActor === 'daemon:handoff')!.body, /reassigned to you because its branch conflicts/);
    const final = store.getCard(loser.id)!;
    assert.equal(final.pipeline.avoid?.length, 1);
    assert.notEqual(final.agentId, final.pipeline.avoid![0], 'the merge agent is a different agent');
  } finally {
    await close();
  }
});

test('failing tests go back to the author, then escalate to a human', async () => {
  const { store, scheduler, refinery, board, close } = await setup();
  try {
    store.updateSettings(board.id, { ...QUIET, testCommand: 'echo "AssertionError: 1 != 2" >&2; exit 1', mergeAttempts: 2 });
    const card = store.createCard({ boardId: board.id, title: 'Broken change', status: 'ready' });
    scheduler.start();
    refinery.start();
    await until(store, () => store.getCard(card.id)!.status === 'blocked');
    const final = store.getCard(card.id)!;
    assert.equal(final.pipeline.escalated, true);
    assert.equal(final.pipeline.mergeAttempts, 2);
    assert.deepEqual(steps(store, card.id).filter((s) => ['tests_failed', 'escalated'].includes(s)), ['tests_failed', 'tests_failed', 'escalated']);
    const mail = store.boardMessages(board.id);
    assert.match(mail.find((m) => m.toCard === card.id)!.body, /tests failed[\s\S]*AssertionError: 1 != 2/);
    assert.match(mail.find((m) => m.toCard === null && m.fromActor !== 'daemon:policy')!.body, /needs a human: landing failed 2 times \(failing tests\)/);
  } finally {
    await close();
  }
});

test('PR landing: push, open and merge the PR, then follow origin locally', async () => {
  const calls: string[] = [];
  const remote = mkdtempSync(join(tmpdir(), 'ih-origin-'));
  // Stands in for GitHub: "merging" merges the pushed branch into the bare remote's main.
  const github: GitHub = {
    async openPr(_repo, pr) {
      calls.push(`open ${pr.branch} -> ${pr.base}: ${pr.title}`);
      return 'https://github.test/pr/1';
    },
    async mergePr(_repo, url, { subject }) {
      calls.push(`merge ${url}`);
      const clone = mkdtempSync(join(tmpdir(), 'ih-clone-'));
      await git(clone, ['clone', '-q', remote, '.']);
      const branch = calls[0]!.split(' ')[1]!;
      await git(clone, ['-c', 'user.name=gh', '-c', 'user.email=gh@test', 'merge', '--no-ff', '-q', '-m', subject, `origin/${branch}`]);
      await git(clone, ['push', '-q', 'origin', 'main']);
    },
  };
  const { store, scheduler, refinery, board, repo, close } = await setup({ github });
  try {
    await git(remote, ['init', '-q', '--bare', '-b', 'main']);
    await git(repo, ['remote', 'add', 'origin', remote]);
    await git(repo, ['push', '-q', 'origin', 'main']);
    store.updateSettings(board.id, { ...QUIET, landMode: 'pr' });
    const card = store.createCard({ boardId: board.id, title: 'Ship it', status: 'ready' });
    scheduler.start();
    refinery.start();
    await until(store, () => store.getCard(card.id)!.status === 'done');

    const final = store.getCard(card.id)!;
    assert.equal(final.pipeline.prUrl, 'https://github.test/pr/1');
    assert.deepEqual(calls, [`open ${final.branch} -> main: Ship it`, 'merge https://github.test/pr/1']);
    assert.equal(await git(remote, ['log', '-1', '--format=%s', 'main']), 'Ship it');
    assert.equal(await git(repo, ['rev-parse', 'main']), await git(remote, ['rev-parse', 'main']), 'local main follows origin');
    assert.equal(await git(remote, ['branch', '--list', final.branch!]), '', 'the PR branch is deleted');
  } finally {
    await close();
  }
});

test('cross-provider review: another pool reviews; requested changes go to the author, then the card lands', async () => {
  const { store, scheduler, refinery, board, close } = await setup();
  try {
    store.updateSettings(board.id, { ...QUIET, crossReview: true, reviewThreshold: 0 });
    // The fake agent echoes the start of its prompt, which holds the card title: so the title is the verdict.
    const picky = store.createCard({ boardId: board.id, title: 'VERDICT: CHANGES handle zero', routing: { pools: ['fa'] }, status: 'ready' });
    const fine = store.createCard({ boardId: board.id, title: 'Plain change', routing: { pools: ['fa'] }, status: 'ready' });
    scheduler.start();
    refinery.start();
    await until(store, () => [picky, fine].every((c) => store.getCard(c.id)!.status === 'done'), 40_000);

    for (const card of [picky, fine]) {
      const reviews = store.listSessions(card.id).filter((s) => s.poolId !== 'fa');
      assert.equal(reviews.length, 1, 'one review, on the other provider');
      assert.equal(reviews[0]!.poolId, 'fb');
    }
    assert.ok(steps(store, picky.id).includes('changes_requested'));
    assert.match(store.boardMessages(board.id).find((m) => m.toCard === picky.id)!.body, /asked for changes/);
    const approved = store.eventsFor(fine.id).find((e) => e.type === 'card.refinery' && (e.payload as any).step === 'approved')!;
    assert.equal((approved.payload as any).reason, 'the reviewer gave no verdict');
  } finally {
    await close();
  }
});

test('a failed run is reassigned to another agent with a handoff, then escalated', async () => {
  const { store, scheduler, refinery, board, close } = await setup();
  try {
    store.updateSettings(board.id, QUIET);
    const card = store.createCard({ boardId: board.id, title: 'Doomed', description: 'FAIL', status: 'ready' });
    scheduler.start();
    refinery.start();
    await until(store, () => !!store.getCard(card.id)!.pipeline.escalated);
    const pools = store.listSessions(card.id).map((s) => s.poolId);
    assert.equal(pools.length, 2);
    assert.notEqual(pools[0], pools[1], 'the retry ran on the other agent');
    const mail = store.boardMessages(board.id);
    assert.match(mail.find((m) => m.fromActor === 'daemon:handoff')!.body, /previous run failed[\s\S]*scripted failure/);
    assert.match(mail.find((m) => m.toCard === null && m.fromActor !== 'daemon:policy')!.body, /needs a human: the run failed 2 time/);
    assert.equal(store.getCard(card.id)!.status, 'blocked');
  } finally {
    await close();
  }
});


test('build output is never committed, and untracked leftovers in the way of a merge are cleared', async () => {
  const { repo, close } = await setup();
  try {
    const { commitAll, mergeBase, untrackedInTheWay } = await import('../src/git.ts');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(repo, '__pycache__'), { recursive: true });
    writeFileSync(join(repo, '__pycache__', 'calc.pyc'), 'bytes');
    writeFileSync(join(repo, 'calc.py'), 'x = 1\n');
    await commitAll(repo, 'calc');
    assert.equal(await git(repo, ['ls-files']), 'README.md\ncalc.py');

    // Another branch tracks a file this checkout has untracked: the merge clears it instead of failing.
    await git(repo, ['checkout', '-q', '-b', 'other']);
    writeFileSync(join(repo, 'cache.txt'), 'tracked on other\n');
    await commitAll(repo, 'cache');
    await git(repo, ['checkout', '-q', 'main']);
    writeFileSync(join(repo, 'cache.txt'), 'leftover\n');
    assert.deepEqual(await mergeBase(repo, 'other'), { ok: true });
    assert.equal(readFileSync(join(repo, 'cache.txt'), 'utf8'), 'tracked on other\n');
    assert.deepEqual(untrackedInTheWay('error: The following untracked working tree files would be overwritten by merge:\n\ta/b.pyc\n\tc.txt\nPlease move'), ['a/b.pyc', 'c.txt']);
  } finally {
    await close();
  }
});
