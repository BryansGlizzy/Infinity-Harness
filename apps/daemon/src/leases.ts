import { isAbsolute, matchesGlob, normalize, relative } from 'node:path';
import type { Lease } from '@mh/core';
import type { Store } from '@mh/db';

const GLOB_CHARS = /[*?[\]{}]/;
const DEFAULT_TTL_MS = 30 * 60_000;

export class LeaseConflict extends Error {
  readonly conflicts: { path: string; heldBy: string; glob: string }[];
  constructor(conflicts: { path: string; heldBy: string; glob: string }[]) {
    super(conflicts.map((c) => `${c.path} is leased by card ${c.heldBy} (${c.glob})`).join('; '));
    this.conflicts = conflicts;
  }
}

/** Normalizes a repo-relative path or glob: no leading `./`, no trailing slash; a bare directory covers its contents. */
export function normalizeGlob(p: string): string {
  let g = normalize(p.trim()).replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (g === '.' || g === '') g = '**';
  return g;
}

/** The literal directory prefix of a glob, e.g. `src/auth` for `src/auth/**\/*.ts`. */
function staticPrefix(g: string): string {
  const parts: string[] = [];
  for (const part of g.split('/')) {
    if (GLOB_CHARS.test(part)) break;
    parts.push(part);
  }
  return parts.join('/');
}

const within = (path: string, dir: string) => dir === '' || path === dir || path.startsWith(`${dir}/`);

/**
 * Whether two leases could cover the same file. Literal paths also cover everything under them;
 * two globs are compared by their literal prefixes, which errs toward reporting a conflict.
 */
export function overlaps(a: string, b: string): boolean {
  const ga = GLOB_CHARS.test(a);
  const gb = GLOB_CHARS.test(b);
  if (!ga && !gb) return within(a, b) || within(b, a);
  if (!ga) return matchesGlob(a, b) || within(staticPrefix(b), a);
  if (!gb) return matchesGlob(b, a) || within(staticPrefix(a), b);
  const pa = staticPrefix(a);
  const pb = staticPrefix(b);
  return within(pa, pb) || within(pb, pa);
}

/** Repo-relative form of a path the agent named, or null if it is outside the worktree. */
export function toRepoPath(path: string, worktree: string): string | null {
  const rel = relative(worktree, isAbsolute(path) ? path : `${worktree}/${path}`);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel === '' ? '.' : rel;
}

/** Leases held by other cards that cover any of `paths` (repo-relative). */
export function heldByOthers(store: Store, boardId: string, cardId: string, paths: string[]): { path: string; heldBy: string; glob: string }[] {
  const others = store.activeLeases(boardId).filter((l) => l.cardId !== cardId);
  const conflicts: { path: string; heldBy: string; glob: string }[] = [];
  for (const path of paths) {
    const lease = others.find((l) => overlaps(normalizeGlob(path), l.glob));
    if (lease) conflicts.push({ path, heldBy: lease.cardId, glob: lease.glob });
  }
  return conflicts;
}

/** Reserves paths for a card, all or nothing. Throws LeaseConflict naming the holders. */
export function reservePaths(store: Store, boardId: string, cardId: string, paths: string[], ttlMs = DEFAULT_TTL_MS): Lease[] {
  const globs = [...new Set(paths.map(normalizeGlob))];
  return store.acquireLeases({ boardId, cardId, globs, ttlMs }, (active) => {
    const others = active.filter((l) => l.cardId !== cardId);
    const conflicts = globs.flatMap((g) => {
      const lease = others.find((l) => overlaps(g, l.glob));
      return lease ? [{ path: g, heldBy: lease.cardId, glob: lease.glob }] : [];
    });
    if (conflicts.length) throw new LeaseConflict(conflicts);
  });
}
