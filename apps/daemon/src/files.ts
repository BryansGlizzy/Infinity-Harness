// A read-only view of a board's project folder (or of one card's worktree) for the file tree in the clients: list a
// directory, read a file. Paths are relative to the root and are resolved with symlinks followed, so nothing outside
// the folder can be listed or read through a `..` or a link. Not for writing: the agents and the person's editor do that.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { DirListing, FileContent, FileEntry } from '@ih/core';
import type { Store } from '@ih/db';
import { promisify } from 'node:util';

const run = promisify(execFile);

export class FilesError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

const MAX_ENTRIES = 3000;
const MAX_BYTES = 1_000_000;
const HIDDEN = new Set(['.git']);

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** The folder to browse: the board's project folder, or one of its cards' worktrees. */
export function rootFor(store: Store, boardId: string, cardId?: string): string {
  const board = store.getBoard(boardId);
  if (!board) throw new FilesError(404, 'board not found');
  if (cardId) {
    const card = store.getCard(cardId);
    if (!card || card.boardId !== boardId) throw new FilesError(404, 'card not found on this board');
    if (!card.worktree || !existsSync(card.worktree)) throw new FilesError(404, 'that card has no worktree on disk');
    return card.worktree;
  }
  if (!existsSync(board.repoPath)) throw new FilesError(404, 'the project folder does not exist any more');
  return board.repoPath;
}

/** Resolves a path under the root, refusing anything that leaves it (a `..`, an absolute path, a link pointing out). */
function resolveUnder(root: string, rel: string): { base: string; real: string } {
  const base = realpathSync(root);
  const clean = rel.replace(/^\/+/, '');
  if (clean.split('/').some((p) => p === '..')) throw new FilesError(400, 'a path cannot leave the project folder');
  const target = resolve(base, clean);
  if (!inside(target, base)) throw new FilesError(400, 'a path cannot leave the project folder');
  if (!existsSync(target)) throw new FilesError(404, 'no such file or folder');
  const real = realpathSync(target);
  if (!inside(real, base)) throw new FilesError(403, 'that link points outside the project folder');
  return { base, real };
}

/** Changed files by git, relative to the root. Empty when the folder is not a repository. */
async function changes(root: string): Promise<Map<string, FileEntry['status']>> {
  const out = new Map<string, FileEntry['status']>();
  try {
    // Not the git helper: it trims its output, and the first record of a status begins with a significant space.
    const { stdout: text } = await run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
    const parts = text.split('\0').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const code = parts[i]!.slice(0, 2);
      const path = parts[i]!.slice(3);
      if (code.startsWith('R') || code.startsWith('C')) i++; // the old name follows
      const x = code[0]!;
      const y = code[1]!;
      out.set(path, code === '??' ? 'U' : x === 'D' || y === 'D' ? 'D' : x === 'A' ? 'A' : 'M');
    }
  } catch {
    // not a repository, or git is unhappy: no markers
  }
  return out;
}

export async function listDir(root: string, rel = ''): Promise<DirListing> {
  const { base, real } = resolveUnder(root, rel);
  if (!statSync(real).isDirectory()) throw new FilesError(400, 'that is a file, not a folder');
  const dirents = readdirSync(real, { withFileTypes: true }).filter((d) => !HIDDEN.has(d.name));
  const marks = await changes(base);
  const here = relative(base, real).split(sep).filter(Boolean).join('/');
  const entries: FileEntry[] = [];
  for (const d of dirents.slice(0, MAX_ENTRIES * 2)) {
    const path = here ? `${here}/${d.name}` : d.name;
    let type: FileEntry['type'] = d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'link';
    let size: number | null = null;
    if (d.isSymbolicLink()) {
      // A link that stays inside the project behaves like what it points at; one that leaves it is shown but cannot be opened.
      try {
        const target = realpathSync(join(real, d.name));
        if (inside(target, base)) {
          const st = statSync(target);
          type = st.isDirectory() ? 'dir' : 'file';
          size = st.isFile() ? st.size : null;
        }
      } catch {
        type = 'link';
      }
    } else if (d.isFile()) {
      try {
        size = statSync(join(real, d.name)).size;
      } catch {
        size = null;
      }
    }
    let status: FileEntry['status'] = marks.get(path) ?? null;
    if (type === 'dir' && !status) for (const p of marks.keys()) if (p.startsWith(`${path}/`)) (status = 'M');
    entries.push({ name: d.name, path, type, size, status });
  }
  entries.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return { root: base, path: here, entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES };
}

export async function readFileAt(root: string, rel: string): Promise<FileContent> {
  const { base, real } = resolveUnder(root, rel);
  const st = statSync(real);
  if (!st.isFile()) throw new FilesError(400, 'that is a folder, not a file');
  const handle = await open(real, 'r');
  try {
    const length = Math.min(st.size, MAX_BYTES);
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, 0);
    const data = buf.subarray(0, bytesRead);
    const binary = data.subarray(0, 8000).includes(0);
    return {
      path: relative(base, real).split(sep).join('/'),
      size: st.size,
      binary,
      truncated: st.size > MAX_BYTES,
      content: binary ? '' : data.toString('utf8'),
    };
  } finally {
    await handle.close();
  }
}
