import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Board } from '@ih/core';

// Which board belongs to the open workspace. Kept free of the vscode API so it can be tested with node:test.

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** True when `folder` is the repo or inside it (a workspace may open a subfolder of the board's repository). */
export function folderInRepo(folder: string, repo: string): boolean {
  const rel = relative(real(repo), real(folder));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Boards whose repository holds one of the workspace folders, closest match first. */
export function boardsForFolders(boards: Board[], folders: string[]): Board[] {
  const depth = (b: Board) => Math.min(...folders.filter((f) => folderInRepo(f, b.repoPath)).map((f) => relative(real(b.repoPath), real(f)).length));
  return boards.filter((b) => folders.some((f) => folderInRepo(f, b.repoPath))).sort((a, b) => depth(a) - depth(b));
}
