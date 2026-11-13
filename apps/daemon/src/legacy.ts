// Carrying an install across the rename from Meta-Harness (`MH_*` settings, `.meta-harness/` state, `meta-harness.db`)
// to Infinity Harness (`IH_*`, `.infinity-harness/`, `infinity-harness.db`). Nothing is deleted: the old names keep
// working for settings, and the old state folder is moved, not copied. Branches called `mh/…` on existing cards are
// left as they are (new cards get `ih/…`); nothing depends on the prefix.
import { existsSync, readdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Store } from '@ih/db';
import { git } from './git.ts';

/** `MH_FOO` still works as `IH_FOO` when the new name is not set. Returns the old names that were used. */
export function applyLegacyEnv(env: NodeJS.ProcessEnv): string[] {
  const used: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith('MH_') || value === undefined) continue;
    const next = `IH_${name.slice(3)}`;
    if (env[next] === undefined) {
      env[next] = value;
      used.push(name);
    }
  }
  return used;
}

export interface LegacyMove {
  /** The old state folder was moved to the new name. */
  moved: boolean;
  /** Where it was and where it is now (for rewriting the paths the database remembers). */
  from: string;
  to: string;
  notes: string[];
}

/**
 * Moves `<root>/.meta-harness` to `<root>/.infinity-harness` (when only the old one exists) and renames the database file
 * wherever the state lives (`IH_STATE_DIR` or the folder above). Must run before anything creates the new folder.
 */
export function migrateLegacyState(root: string, env: NodeJS.ProcessEnv): LegacyMove {
  const from = join(root, '.meta-harness');
  const to = join(root, '.infinity-harness');
  const notes: string[] = [];
  let moved = false;
  if (existsSync(from) && !existsSync(to)) {
    renameSync(from, to);
    moved = true;
    notes.push(`moved ${from} to ${to}`);
  } else if (existsSync(from) && existsSync(to)) {
    notes.push(`both ${from} and ${to} exist; using the new one and leaving the old one alone`);
  }
  const state = env.IH_STATE_DIR ? resolve(env.IH_STATE_DIR) : to;
  for (const suffix of ['', '-wal', '-shm']) {
    const old = join(state, `meta-harness.db${suffix}`);
    const next = join(state, `infinity-harness.db${suffix}`);
    if (existsSync(old) && !existsSync(next) && (suffix !== '' || !existsSync(join(state, 'infinity-harness.db')))) {
      renameSync(old, next);
      if (suffix === '') notes.push(`renamed the database to ${next}`);
    }
  }
  return { moved, from, to, notes };
}

/**
 * After the state folder moved: cards remember their worktree by path, and git remembers each worktree's place in the
 * repository's own metadata. Point both at the new location.
 */
export async function repairMovedWorktrees(store: Store, move: LegacyMove): Promise<{ cards: number; repos: number }> {
  if (!move.moved) return { cards: 0, repos: 0 };
  const rows = store.db.prepare('UPDATE nodes SET worktree = ? || substr(worktree, ?) WHERE worktree LIKE ?').run(move.to, move.from.length + 1, `${move.from}%`);
  let repos = 0;
  for (const board of store.listBoards()) {
    if (board.mode !== 'worktree' || !existsSync(board.repoPath)) continue;
    const dir = join(move.to, 'worktrees', board.id);
    if (!existsSync(dir)) continue;
    const paths = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(dir, d.name));
    if (!paths.length) continue;
    await git(board.repoPath, ['worktree', 'repair', ...paths]).catch(() => {});
    repos++;
  }
  return { cards: Number(rows.changes), repos };
}
