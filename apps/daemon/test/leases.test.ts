import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '@ih/db';
import { LeaseConflict, heldByOthers, normalizeGlob, overlaps, reservePaths, toRepoPath } from '../src/leases.ts';

test('overlaps: literals, directories and globs', () => {
  assert.equal(overlaps('src/a.ts', 'src/a.ts'), true);
  assert.equal(overlaps('src', 'src/a.ts'), true); // a directory lease covers its files
  assert.equal(overlaps('src/a.ts', 'src/b.ts'), false);
  assert.equal(overlaps('src/a.ts', 'src/**'), true);
  assert.equal(overlaps('lib/a.ts', 'src/**'), false);
  assert.equal(overlaps('src/auth/**', 'src/**/*.ts'), true);
  assert.equal(overlaps('src/auth/**', 'test/**'), false);
  assert.equal(overlaps('**', 'anything.md'), true);
  assert.equal(normalizeGlob('./src/'), 'src');
  assert.equal(toRepoPath('/w/t/src/a.ts', '/w/t'), 'src/a.ts');
  assert.equal(toRepoPath('/elsewhere/a.ts', '/w/t'), null);
});

test('reservePaths is all-or-nothing and names the holder; release frees it', () => {
  const store = new Store(':memory:');
  const board = store.createBoard({ name: 'B', repoPath: '/r', defaultBranch: 'main' });
  const a = store.createCard({ boardId: board.id, title: 'A' });
  const b = store.createCard({ boardId: board.id, title: 'B' });

  reservePaths(store, board.id, a.id, ['src/auth/**']);
  assert.throws(
    () => reservePaths(store, board.id, b.id, ['README.md', 'src/auth/login.ts']),
    (err: unknown) => err instanceof LeaseConflict && err.conflicts[0]!.heldBy === a.id,
  );
  assert.equal(store.activeLeases(board.id).length, 1); // README.md was not granted either

  reservePaths(store, board.id, a.id, ['src/auth/session.ts']); // own leases never conflict
  assert.deepEqual(heldByOthers(store, board.id, b.id, ['src/auth/x.ts', 'docs/y.md']).map((c) => c.path), ['src/auth/x.ts']);

  store.releaseLeases(a.id);
  assert.equal(store.activeLeases(board.id).length, 0);
  assert.equal(reservePaths(store, board.id, b.id, ['src/auth/login.ts']).length, 1);
});

test('expired leases stop counting', () => {
  const store = new Store(':memory:');
  const board = store.createBoard({ name: 'B', repoPath: '/r', defaultBranch: 'main' });
  const a = store.createCard({ boardId: board.id, title: 'A' });
  const b = store.createCard({ boardId: board.id, title: 'B' });
  reservePaths(store, board.id, a.id, ['src/**'], -1);
  assert.equal(reservePaths(store, board.id, b.id, ['src/a.ts']).length, 1);
});
