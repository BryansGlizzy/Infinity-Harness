// Worktrees (master plan 6.6, borrowed from herdr): setup once per worktree, folders in the way, safe removal, the
// configurable root, and git's "dubious ownership" explained instead of passed through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeSetup } from '../src/setup.ts';
import { ensureWorktree, explainGitError, git, removeWorktreeSafely } from '../src/git.ts';
import { loadConfig } from '../src/config.ts';
import { setup, status, tempRepo, waitFor } from './harness.ts';

const settings = (worktreeSetup: string, worktreeSetupTimeoutSec = 30) => ({ worktreeSetup, worktreeSetupTimeoutSec });

async function fresh(name = 'card') {
  const repo = await tempRepo();
  const dir = join(mkdtempSync(join(tmpdir(), 'mh-wt-')), name);
  assert.equal(await ensureWorktree(repo, dir, `mh/${name}`, 'main'), 'created');
  const board = { id: 'b_test', name: 'T', repoPath: repo, defaultBranch: 'main', mode: 'worktree' as const, createdAt: '' };
  return { repo, dir, board, branch: `mh/${name}` };
}

test('setup runs once per worktree and command, with the environment a script needs, and failures are reported not hidden', async () => {
  const { dir, board, branch, repo } = await fresh();
  const s = new WorktreeSetup({ env: process.env });
  const cmd = 'mkdir -p node_modules && echo "$MH_BRANCH $MH_BOARD $MH_WORKTREE" >> node_modules/ran.txt && test -f "$MH_REPO_PATH/README.md" && echo installed';

  const first = await s.ensure('c1', board, dir, branch, settings(cmd));
  assert.deepEqual([first.ran, first.ok, first.output.trim()], [true, true, 'installed']);
  assert.equal(readFileSync(join(dir, 'node_modules/ran.txt'), 'utf8').trim(), `${branch} b_test ${dir}`);
  assert.equal((await git(dir, ['status', '--porcelain'])).includes('mh-worktree-setup'), false, 'the marker is not in the work tree');

  assert.equal((await s.ensure('c1', board, dir, branch, settings(cmd))).ran, false, 'already done for this command');
  assert.equal((await s.ensure('c1', board, dir, branch, settings(''))).ran, false, 'no command, nothing to do');
  const changed = await s.ensure('c1', board, dir, branch, settings(cmd + ' # v2'));
  assert.equal(changed.ran, true, 'a changed command runs again');
  assert.equal(readFileSync(join(dir, 'node_modules/ran.txt'), 'utf8').trim().split('\n').length, 2);

  const bad = await s.ensure('c1', board, dir, branch, settings('echo about to fail >&2; exit 3'));
  assert.deepEqual([bad.ran, bad.ok, bad.timedOut], [true, false, false]);
  assert.match(bad.output, /about to fail/);
  assert.equal((await s.ensure('c1', board, dir, branch, settings('echo about to fail >&2; exit 3'))).ran, true, 'a failure is retried next time: nothing was marked done');

  const slow = await s.ensure('c1', board, dir, branch, settings('sleep 5', 1));
  assert.deepEqual([slow.ok, slow.timedOut], [false, true]);
  void repo;
});

test('installs do not all run at once', async () => {
  const a = await fresh('a');
  const b = await fresh('b');
  const c = await fresh('c');
  const log = join(mkdtempSync(join(tmpdir(), 'mh-log-')), 'order.txt');
  const s = new WorktreeSetup({ env: process.env, concurrency: 1 });
  const cmd = `echo start >> ${log}; sleep 0.15; echo end >> ${log}`;
  await Promise.all([a, b, c].map((w, i) => s.ensure(`c${i}`, w.board, w.dir, w.branch, settings(cmd))));
  assert.equal(readFileSync(log, 'utf8'), 'start\nend\n'.repeat(3), 'one at a time');
});

test('a folder in the way is moved aside, a registered worktree is reused, a stale registration is repaired', async () => {
  const repo = await tempRepo();
  const root = mkdtempSync(join(tmpdir(), 'mh-wt-'));
  const dir = join(root, 'card');

  // A leftover folder that is not a worktree (an interrupted run, a copied folder): it may hold someone's work.
  mkdirSync(dir);
  writeFileSync(join(dir, 'precious.txt'), 'do not lose me');
  assert.equal(await ensureWorktree(repo, dir, 'mh/one', 'main'), 'created');
  assert.ok(existsSync(join(dir, 'README.md')), 'now a real worktree');
  const aside = (await import('node:fs')).readdirSync(root).find((n) => n.startsWith('card.leftover-'));
  assert.ok(aside, 'the old folder was kept');
  assert.equal(readFileSync(join(root, aside!, 'precious.txt'), 'utf8'), 'do not lose me');

  assert.equal(await ensureWorktree(repo, dir, 'mh/one', 'main'), 'reused');

  // The folder vanished but git still lists it.
  (await import('node:fs')).rmSync(dir, { recursive: true });
  assert.equal(await ensureWorktree(repo, dir, 'mh/one', 'main'), 'created', 'pruned, then made again on the existing branch');
  assert.ok(existsSync(join(dir, 'README.md')));
});

test('removing a worktree refuses uncommitted work unless forced, and keeps the branch', async () => {
  const { repo, dir, branch } = await fresh();
  writeFileSync(join(dir, 'wip.txt'), 'half done');
  const refused = await removeWorktreeSafely(repo, dir, false);
  assert.deepEqual([refused.removed, refused.dirty], [false, ['wip.txt']]);
  assert.ok(existsSync(dir), 'untouched');
  const forced = await removeWorktreeSafely(repo, dir, true);
  assert.equal(forced.removed, true);
  assert.equal(existsSync(dir), false);
  assert.equal((await git(repo, ['rev-parse', '--verify', `refs/heads/${branch}`])).length > 0, true, 'the branch stays');
});

test('git refusing a repository owned by someone else is explained, not trusted automatically', () => {
  const raw = Object.assign(new Error('Command failed: git status'), { stderr: "fatal: detected dubious ownership in repository at '/srv/x'" });
  const nice = explainGitError(raw, '/srv/x');
  assert.match(nice.message, /owned by another user/);
  assert.match(nice.message, /git config --global --add safe\.directory \/srv\/x/);
  const other = new Error('boom');
  assert.equal(explainGitError(other, '/srv/x'), other, 'other errors pass through');
});

test('MH_WORKTREES_DIR moves where worktrees live', () => {
  const root = mkdtempSync(join(tmpdir(), 'mh-root-'));
  assert.equal(loadConfig(root, { PATH: process.env.PATH }).worktreesDir, join(root, '.meta-harness', 'worktrees'));
  assert.equal(loadConfig(root, { PATH: process.env.PATH, MH_WORKTREES_DIR: '/srv/checkouts' }).worktreesDir, '/srv/checkouts');
  assert.equal(loadConfig(root, { PATH: process.env.PATH, MH_WORKTREES_DIR: '~/checkouts' }).worktreesDir, join(homedir(), 'checkouts'));
});

test('a card run: setup happens before the agent starts, is logged on the card, and a failure is told to the agent and the humans', async () => {
  const t = await setup();
  try {
    t.store.updateSettings(t.board.id, { worktreeSetup: 'mkdir -p node_modules && echo ready > node_modules/ready.txt' });
    const good = t.store.createCard({ boardId: t.board.id, title: 'Good setup' });
    const done = waitFor(t.store, status(t.store, good.id, 'review'));
    await t.runner.run(good.id, 'fa');
    await done;
    const worked = t.store.getCard(good.id)!;
    assert.equal(readFileSync(join(worked.worktree!, 'node_modules/ready.txt'), 'utf8').trim(), 'ready');
    const logged = t.store.eventsFor(good.id).find((e) => e.type === 'card.setup');
    assert.ok(logged && (logged.payload as { ok: boolean }).ok, 'the setup is on the card log');
    assert.ok(logged.seq < t.store.eventsFor(good.id).find((e) => e.type === 'session.event')!.seq, 'before the agent did anything');
    assert.deepEqual((await git(worked.worktree!, ['show', '--name-only', '--format=', 'HEAD'])).split('\n').filter(Boolean), ['notes.md'], 'installed files are not committed');

    t.store.updateSettings(t.board.id, { worktreeSetup: 'echo no network >&2; exit 1' });
    const broken = t.store.createCard({ boardId: t.board.id, title: 'Broken setup' });
    const finished = waitFor(t.store, status(t.store, broken.id, 'review'));
    await t.runner.run(broken.id, 'fa');
    await finished;
    const prompt = t.store
      .eventsFor(broken.id)
      .filter((e) => e.type === 'session.event' && (e.payload as any).event.type === 'message' && (e.payload as any).event.role === 'user')
      .map((e) => (e.payload as any).event.text as string)
      .join('\n');
    assert.match(prompt, /setup command \(`echo no network >&2; exit 1`\) failed[\s\S]*no network/);
    assert.ok(t.store.boardMessages(t.board.id).some((m) => m.fromActor === 'daemon:setup' && m.body.includes('Broken setup')));
    assert.equal((t.store.eventsFor(broken.id).find((e) => e.type === 'card.setup')!.payload as { ok: boolean }).ok, false);
  } finally {
    await t.close();
  }
});

test('the worktree-removal endpoint: lists what would be lost, forces on request, and the next run starts clean', async () => {
  const t = await setup();
  try {
    const card = t.store.createCard({ boardId: t.board.id, title: 'Remove me' });
    const done = waitFor(t.store, status(t.store, card.id, 'review'));
    await t.runner.run(card.id, 'fa');
    await done;
    await t.runner.cancel(card.id);
    const dir = t.store.getCard(card.id)!.worktree!;
    writeFileSync(join(dir, 'wip.txt'), 'unsaved');
    const post = (force?: boolean) => fetch(`http://127.0.0.1:${t.cfg.port}/api/cards/${card.id}/worktree/remove`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force }) });

    const refused = await post();
    assert.equal(refused.status, 409);
    assert.match(((await refused.json()) as { error: string }).error, /1 file has uncommitted changes \(wip\.txt\)/);
    assert.ok(existsSync(dir));

    const ok = await post(true);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { removed: true, discarded: ['wip.txt'], branch: t.store.getCard(card.id)!.branch });
    assert.equal(existsSync(dir), false);
    assert.equal(t.store.getCard(card.id)!.worktree, null);
    assert.equal((await post()).status, 409, 'nothing left to remove');
    assert.equal((await fetch(`http://127.0.0.1:${t.cfg.port}/api/cards/c_nope/worktree/remove`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);

    // The committed work is on the branch; a new run gets a fresh worktree on it.
    const again = waitFor(t.store, status(t.store, card.id, 'review'));
    await t.runner.run(card.id, 'fa');
    await again;
    assert.ok(existsSync(join(t.store.getCard(card.id)!.worktree!, 'notes.md')));
  } finally {
    await t.close();
  }
});
