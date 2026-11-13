// Removing a board. Two ways, chosen by the person:
//   forget: the board and everything Infinity Harness keeps about it go (cards, notes, settings, usage, the card
//           worktrees it made). The project folder, its branches and its history are not touched.
//   delete: the same, and the project folder is deleted from the disk. This is irreversible, so the daemon asks for the
//           board's name to be typed back, and refuses folders it must never delete (the disk's top, the home folder,
//           anything that holds the harness itself, a folder another board uses).
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { REQUEST_FINAL, type Board, type BoardRemovalInfo, type BoardRemovalMode, type BoardRemovalResult } from '@ih/core';
import type { Store } from '@ih/db';
import { dirtyFiles, git, removeWorktreeSafely } from './git.ts';
import type { DaemonConfig } from './config.ts';
import type { Federation } from './federation/service.ts';
import type { Runner } from './runner.ts';

export interface RemovalDeps {
  store: Store;
  runner: Runner;
  config: DaemonConfig;
  federation?: Federation | null;
}

export class RemovalError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** Why the folder must not be deleted by the harness, or null when it may be. */
export function deleteBlockedReason(deps: RemovalDeps, board: Board): string | null {
  const { store, config } = deps;
  const path = resolve(board.repoPath);
  if (!existsSync(path)) return 'The folder is already gone.';
  if (lstatSync(path).isSymbolicLink()) return 'The project folder is a symbolic link. Delete it yourself if you mean to.';
  const real = realpathSync(path);
  const home = homedir();
  const segments = real.split(sep).filter(Boolean);
  if (segments.length < 2) return 'That folder is too close to the top of the disk to delete from here.';
  if (inside(home, real)) return 'That folder is your home folder, or holds it.';
  const protectedPaths = [config.root, config.dataDir, dirname(config.dbFile)].filter(Boolean).map((p) => (existsSync(p) ? realpathSync(p) : resolve(p)));
  if (protectedPaths.some((p) => inside(p, real))) return 'That folder holds Infinity Harness itself (its program or its data).';
  for (const other of store.listBoards()) {
    if (other.id === board.id) continue;
    const o = existsSync(other.repoPath) ? realpathSync(other.repoPath) : resolve(other.repoPath);
    if (inside(o, real)) return `The board "${other.name}" uses a folder inside this one.`;
    if (inside(real, o)) return `This folder is inside the folder of the board "${other.name}".`;
  }
  return null;
}

async function isRepoTop(path: string): Promise<boolean> {
  try {
    return realpathSync(await git(path, ['rev-parse', '--show-toplevel'])) === realpathSync(path);
  } catch {
    return false;
  }
}

/** Which of this board's cards' branches (`ih/…`, or `mh/…` from before the rename) are not merged into the default branch yet. */
async function unlandedBranches(board: Board, branches: string[]): Promise<number | null> {
  if (!board.defaultBranch || !branches.length) return board.defaultBranch ? 0 : null;
  try {
    const out = await git(board.repoPath, ['branch', '--no-merged', board.defaultBranch, '--format=%(refname:short)']);
    const unmerged = new Set(out.split('\n').filter(Boolean));
    return branches.filter((b) => unmerged.has(b)).length;
  } catch {
    return null;
  }
}

export async function inspectRemoval(deps: RemovalDeps, boardId: string): Promise<BoardRemovalInfo> {
  const { store, runner } = deps;
  const board = store.getBoard(boardId);
  if (!board) throw new RemovalError(404, 'board not found');
  const cards = store.listCards(boardId);
  const exists = existsSync(board.repoPath);
  const git_ = exists && board.mode === 'worktree' && (await isRepoTop(board.repoPath));
  const trees = board.mode === 'worktree' ? cards.filter((c) => c.worktree && c.worktree !== board.repoPath && existsSync(c.worktree)) : [];
  const dirty = (await Promise.all(trees.map((c) => dirtyFiles(c.worktree!).then((f) => f.length > 0, () => false)))).filter(Boolean).length;
  const uncommitted = git_ ? await dirtyFiles(board.repoPath).then((f) => f.length, () => null) : null;
  const open = store.fed.listRequests({ limit: 1000 }).filter((r) => r.boardId === boardId && !REQUEST_FINAL.includes(r.status));
  const merging = cards.filter((c) => c.status === 'merging').length;
  return {
    board,
    cards: cards.length,
    running: runner.activeSessions().filter((s) => s.boardId === boardId).length,
    merging,
    worktrees: trees.length,
    dirtyWorktrees: dirty,
    folder: { exists, git: git_, uncommitted, unlandedBranches: git_ ? await unlandedBranches(board, cards.map((c) => c.branch).filter((b): b is string => !!b)) : null },
    federation: { sharing: !!store.fed.getShared(boardId)?.published, openIn: open.filter((r) => r.direction === 'in').length, openOut: open.filter((r) => r.direction === 'out').length },
    deleteBlocked: deleteBlockedReason(deps, board),
    blocked: merging ? 'A card is being landed right now. Wait for the merge to finish, then remove the board.' : null,
  };
}

export async function removeBoard(deps: RemovalDeps, boardId: string, req: { mode: BoardRemovalMode; confirmName?: string }): Promise<BoardRemovalResult> {
  const { store, runner, config, federation } = deps;
  const info = await inspectRemoval(deps, boardId);
  const board = info.board;
  if (req.mode !== 'forget' && req.mode !== 'delete') throw new RemovalError(400, 'mode is forget or delete');
  if (info.blocked) throw new RemovalError(409, info.blocked);
  if (req.mode === 'delete') {
    if (info.deleteBlocked) throw new RemovalError(409, info.deleteBlocked);
    // The person types the name back: the second, deliberate step before anything is deleted from the disk.
    if (req.confirmName !== board.name) throw new RemovalError(400, `to delete the folder, type the board's name exactly: ${board.name}`);
  }
  const cards = store.listCards(boardId);

  // Requests exchanged with other swarms about this project end honestly: the ones asked of us are declined, ours are withdrawn.
  if (federation) {
    for (const r of store.fed.listRequests({ limit: 1000 }).filter((x) => x.boardId === boardId && !REQUEST_FINAL.includes(x.status))) {
      try {
        if (r.direction === 'in') federation.declineRequest(r.id, 'This project was removed from the swarm.');
        else await federation.cancelRequest(r.id);
      } catch {
        // the peer cannot be told right now; the request is detached from the board below
      }
    }
  }

  runner.stopBoard(boardId);

  // The card worktrees are the harness's own. One with uncommitted work is kept unless the folder is being deleted anyway.
  const kept: string[] = [];
  if (board.mode === 'worktree') {
    for (const c of cards) {
      if (!c.worktree || c.worktree === board.repoPath || !existsSync(c.worktree)) continue;
      const r = await removeWorktreeSafely(board.repoPath, c.worktree, req.mode === 'delete').catch(() => ({ removed: false, dirty: [] as string[] }));
      if (!r.removed) kept.push(c.worktree);
    }
    if (!kept.length) await rm(join(config.worktreesDir, boardId), { recursive: true, force: true });
  }

  // The irreversible step comes before the records go, so a failure leaves the board in place to try again.
  let deletedFolder: string | null = null;
  if (req.mode === 'delete') {
    const real = realpathSync(board.repoPath);
    await rm(real, { recursive: true, force: true });
    deletedFolder = real;
  }

  store.deleteBoard(boardId);
  return { removed: true, mode: req.mode, keptWorktrees: kept, deletedFolder, unlandedBranches: info.folder.unlandedBranches };
}
