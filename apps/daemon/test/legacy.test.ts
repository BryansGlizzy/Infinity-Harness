// An install from before the rename (MH_* settings, .meta-harness/, meta-harness.db, mh/ branches) carries over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@ih/db';
import { ensureWorktree, git } from '../src/git.ts';
import { applyLegacyEnv, migrateLegacyState, repairMovedWorktrees } from '../src/legacy.ts';
import { loadConfig } from '../src/config.ts';
import { tempRepo } from './harness.ts';

test('old MH_* settings still work as IH_*, and an IH_* setting wins', () => {
  const env: NodeJS.ProcessEnv = { MH_PORT: '7430', MH_FED_PORT: '7432', IH_FED_PORT: '9999', OTHER: 'x' };
  assert.deepEqual(applyLegacyEnv(env).sort(), ['MH_PORT']);
  assert.equal(env.IH_PORT, '7430');
  assert.equal(env.IH_FED_PORT, '9999', 'the new name is not overwritten');
  assert.equal(env.OTHER, 'x');
  // The config reads the new names.
  const cfg = loadConfig(mkdtempSync(join(tmpdir(), 'ih-legacy-cfg-')), { ...env });
  assert.equal(cfg.port, 7430);
  assert.equal(cfg.fedPort, 9999);
});

test('the old state folder moves over: database renamed, cards and git worktrees pointed at the new place, nothing lost', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ih-legacy-'));
  const old = join(root, '.meta-harness');
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, 'api-token'), 'secret-token\n');
  const repo = await tempRepo();

  // What an install from before the rename looked like: a database with a card whose worktree lives under the old folder.
  const before = new Store(join(old, 'meta-harness.db'));
  const board = before.createBoard({ name: 'Old', repoPath: repo, defaultBranch: 'main' });
  const card = before.createCard({ boardId: board.id, title: 'Existing work' });
  const worktree = join(old, 'worktrees', board.id, card.id);
  await ensureWorktree(repo, worktree, 'mh/existing-work-abcd', 'main');
  writeFileSync(join(worktree, 'notes.txt'), 'unfinished\n');
  before.updateCard(card.id, { branch: 'mh/existing-work-abcd', worktree });
  before.close();

  const move = migrateLegacyState(root, {});
  assert.equal(move.moved, true);
  assert.ok(!existsSync(old) && existsSync(join(root, '.infinity-harness', 'api-token')), 'the folder is moved, with the token in it');
  assert.ok(existsSync(join(root, '.infinity-harness', 'infinity-harness.db')) && !existsSync(join(root, '.infinity-harness', 'meta-harness.db')));

  const after = new Store(join(root, '.infinity-harness', 'infinity-harness.db'));
  const fixed = await repairMovedWorktrees(after, move);
  assert.equal(fixed.cards, 1);
  const moved = after.getCard(card.id)!;
  assert.equal(moved.worktree, join(root, '.infinity-harness', 'worktrees', board.id, card.id));
  assert.equal(moved.branch, 'mh/existing-work-abcd', 'an old branch name is left as it was');
  assert.ok(existsSync(join(moved.worktree!, 'notes.txt')), 'uncommitted work is where it was');
  // Git knows the worktree at its new place and can work in it.
  const listed = await git(repo, ['worktree', 'list', '--porcelain']);
  assert.ok(listed.includes(moved.worktree!), listed);
  assert.ok(!/prunable/.test(listed));
  assert.match(await git(moved.worktree!, ['status', '--short']), /notes\.txt/);
  after.close();

  // Starting again does nothing more.
  const again = migrateLegacyState(root, {});
  assert.deepEqual([again.moved, again.notes], [false, []]);
});

test('with both folders present the new one is used and the old one is left alone; a custom state folder gets its database renamed', () => {
  const root = mkdtempSync(join(tmpdir(), 'ih-legacy-'));
  mkdirSync(join(root, '.meta-harness'));
  mkdirSync(join(root, '.infinity-harness'));
  const both = migrateLegacyState(root, {});
  assert.equal(both.moved, false);
  assert.match(both.notes[0]!, /both .* exist/);
  assert.ok(existsSync(join(root, '.meta-harness')));

  const custom = mkdtempSync(join(tmpdir(), 'ih-legacy-state-'));
  writeFileSync(join(custom, 'meta-harness.db'), 'x');
  writeFileSync(join(custom, 'meta-harness.db-wal'), 'y');
  migrateLegacyState(mkdtempSync(join(tmpdir(), 'ih-legacy-')), { IH_STATE_DIR: custom });
  assert.ok(existsSync(join(custom, 'infinity-harness.db')) && existsSync(join(custom, 'infinity-harness.db-wal')));
  assert.ok(!existsSync(join(custom, 'meta-harness.db')));
});
