import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    throw explainGitError(err as Error, cwd);
  }
}

/**
 * Git refuses a repository owned by another user ("dubious ownership"). The fix is the person's call (it trusts that
 * folder for every git command they run), so the daemon says what to do instead of doing it.
 */
export function explainGitError(err: Error, cwd: string): Error {
  const text = `${err.message}\n${(err as Error & { stderr?: string }).stderr ?? ''}`;
  if (!/dubious ownership/i.test(text)) return err;
  const wrapped = new Error(`git will not use ${cwd}: it is owned by another user. If you trust it, run \`git config --global --add safe.directory ${cwd}\` and try again.`);
  (wrapped as Error & { cause?: unknown }).cause = err;
  return wrapped;
}

/** Returns the repo's current branch, or throws if the path is not a git repo with at least one commit. */
export async function inspectRepo(path: string): Promise<{ defaultBranch: string }> {
  if (!existsSync(path)) throw new Error(`path does not exist: ${path}`);
  try {
    await git(path, ['rev-parse', '--verify', 'HEAD']);
  } catch {
    throw new Error(`not a git repository with at least one commit: ${path}`);
  }
  const branch = await git(path, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return { defaultBranch: branch === 'HEAD' ? 'main' : branch };
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await git(repo, ['rev-parse', '--verify', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Folders `git worktree list` knows for this repository (resolved, so a symlinked temp dir still matches). */
async function registeredWorktrees(repo: string): Promise<Set<string>> {
  const out = await git(repo, ['worktree', 'list', '--porcelain']);
  const paths = out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
  return new Set(await Promise.all(paths.map((p) => realpath(p).catch(() => p))));
}

/**
 * Makes `dir` a worktree of `repo` on `branch`, branching from `base` when the branch is new. Returns `created` when it
 * had to make one, `reused` when `dir` already was one. A folder that is in the way but not a worktree of this
 * repository (left by an interrupted run, a pruned worktree, a moved repo) is moved aside, never deleted: it may hold
 * someone's work.
 */
export async function ensureWorktree(repo: string, dir: string, branch: string, base: string): Promise<'created' | 'reused'> {
  if (existsSync(dir)) {
    if ((await registeredWorktrees(repo)).has(await realpath(dir))) return 'reused';
    await git(repo, ['worktree', 'prune']).catch(() => {});
    if (existsSync(dir)) await rename(dir, `${dir}.leftover-${Date.now()}`);
  }
  await mkdir(dirname(dir), { recursive: true });
  // A worktree whose folder was deleted by hand is still registered and holds its branch; forget it first.
  await git(repo, ['worktree', 'prune']).catch(() => {});
  if (await branchExists(repo, branch)) await git(repo, ['worktree', 'add', dir, branch]);
  else await git(repo, ['worktree', 'add', '-b', branch, dir, base]);
  return 'created';
}

/** Files with uncommitted changes in a worktree, untracked ones included (build output the repo ignores is not counted). */
export async function dirtyFiles(dir: string): Promise<string[]> {
  const out = await git(dir, ['status', '--porcelain']);
  return out ? out.split('\n').map((l) => l.slice(3)) : [];
}

/**
 * Deletes a card's worktree folder (the branch stays). A worktree with uncommitted changes is refused unless `force`,
 * because deleting it would lose them.
 */
export async function removeWorktreeSafely(repo: string, dir: string, force: boolean): Promise<{ removed: boolean; dirty: string[] }> {
  const dirty = existsSync(dir) ? await dirtyFiles(dir).catch(() => []) : [];
  if (dirty.length && !force) return { removed: false, dirty };
  await git(repo, ['worktree', 'remove', '--force', dir]).catch(() => {});
  await git(repo, ['worktree', 'prune']).catch(() => {});
  return { removed: true, dirty };
}

/**
 * Build output and caches that agents (and test runs) leave behind; never committed, even in a repo whose
 * .gitignore doesn't cover them. Files already tracked under these paths are still updated.
 */
export const BUILD_OUTPUT = ['**/__pycache__/**', '**/*.pyc', '**/.pytest_cache/**', '**/node_modules/**', '**/.DS_Store', '**/.mypy_cache/**', '**/.ruff_cache/**', '**/.playwright-mcp/**', '**/.agent-browser/**', '**/.rbxsync-trash/**'];

/** Commits everything in the worktree except build output. Returns the new commit sha, or null when there was nothing to commit. */
export async function commitAll(dir: string, message: string): Promise<string | null> {
  await git(dir, ['add', '-A', '--', '.', ...BUILD_OUTPUT.map((g) => `:(exclude,glob)${g}`)]);
  await git(dir, ['add', '-u']); // tracked files under excluded paths still follow their changes
  const staged = await git(dir, ['diff', '--cached', '--name-only']);
  if (!staged) return null;
  const hasIdentity = await git(dir, ['config', 'user.email']).then(Boolean, () => false);
  const identity = hasIdentity ? [] : ['-c', 'user.name=infinity-harness', '-c', 'user.email=infinity-harness@localhost'];
  await git(dir, [...identity, 'commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

/**
 * Merges each branch into the worktree's branch, so a card starts with the work of the cards it waited for
 * (until the Phase 4 refinery lands them on the default branch). A conflicting merge is aborted and reported.
 */
export async function mergeBranches(dir: string, branches: string[]): Promise<{ merged: string[]; conflicted: string[] }> {
  const hasIdentity = await git(dir, ['config', 'user.email']).then(Boolean, () => false);
  const identity = hasIdentity ? [] : ['-c', 'user.name=infinity-harness', '-c', 'user.email=infinity-harness@localhost'];
  const merged: string[] = [];
  const conflicted: string[] = [];
  for (const branch of branches) {
    try {
      await git(dir, [...identity, 'merge', '--no-edit', '-q', branch]);
      merged.push(branch);
    } catch {
      await git(dir, ['merge', '--abort']).catch(() => {});
      conflicted.push(branch);
    }
  }
  return { merged, conflicted };
}

/** Deletes untracked files under the given repo-relative paths; tracked files there are left alone. */
export async function removeUntracked(dir: string, paths: string[]): Promise<string[]> {
  const out = await git(dir, ['ls-files', '--others', '--', ...paths]);
  const files = out ? out.split('\n') : [];
  await Promise.all(files.map((f) => rm(join(dir, f), { force: true })));
  return files;
}

/** Commits on `branch` that are not on `base`. */
export async function commitsAhead(repo: string, base: string, branch: string): Promise<number> {
  return Number(await git(repo, ['rev-list', '--count', `${base}..${branch}`]));
}

const identityArgs = async (dir: string) =>
  (await git(dir, ['config', 'user.email']).then(Boolean, () => false)) ? [] : ['-c', 'user.name=infinity-harness', '-c', 'user.email=infinity-harness@localhost'];

/** The `origin` remote's URL, or null when there is none. */
export async function originUrl(repo: string): Promise<string | null> {
  return git(repo, ['remote', 'get-url', 'origin']).then((u) => u || null, () => null);
}

export async function revParse(repo: string, ref: string): Promise<string | null> {
  return git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).then((s) => s || null, () => null);
}

/**
 * Brings the worktree's branch up to date by merging `base` into it (not rebasing: a card may already contain the
 * commits of the cards it waited for, and rebasing would replay them). On conflict the merge is aborted and the
 * conflicting files are returned.
 */
export async function mergeBase(dir: string, base: string): Promise<{ ok: true } | { ok: false; conflicts: string[] }> {
  await git(dir, ['merge', '--abort']).catch(() => {}); // a landing interrupted by a restart
  const merge = async () => git(dir, [...(await identityArgs(dir)), 'merge', '--no-edit', '-q', base]);
  try {
    await merge().catch(async (err: Error & { stderr?: string }) => {
      // Untracked leftovers (test-run caches; agents' work is committed at the end of every turn) that the base now
      // tracks block the merge: remove exactly those and try once more.
      const blocking = untrackedInTheWay(`${err.stderr ?? ''}\n${err.message}`);
      if (!blocking.length) throw err;
      await Promise.all(blocking.map((f) => rm(join(dir, f), { force: true })));
      await merge();
    });
    return { ok: true };
  } catch (err) {
    const conflicts = (await git(dir, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).split('\n').filter(Boolean);
    await git(dir, ['merge', '--abort']).catch(() => {});
    if (!conflicts.length) throw err;
    return { ok: false, conflicts };
  }
}

/** Files git names in "untracked working tree files would be overwritten by merge". */
export function untrackedInTheWay(output: string): string[] {
  const m = /untracked working tree files would be overwritten by merge:\n((?:\t.+\n?)+)/.exec(output);
  return m ? m[1]!.split('\n').map((l) => l.trim()).filter(Boolean) : [];
}

/** Files the branch changes relative to where it forked from `base`. */
export async function changedFiles(repo: string, base: string, branch: string): Promise<string[]> {
  return (await git(repo, ['diff', '--name-only', `${base}...${branch}`])).split('\n').filter(Boolean);
}

/** Diff stat plus the patch, for commit-message and review prompts (callers trim it). */
export async function branchDiff(repo: string, base: string, branch: string): Promise<string> {
  const stat = await git(repo, ['diff', '--stat', `${base}...${branch}`]);
  const patch = await git(repo, ['diff', '--no-color', `${base}...${branch}`]);
  return `${stat}\n\n${patch}`;
}

/**
 * Lands `branch` on `base` as a merge commit (`--no-ff`) in a scratch worktree, created detached on first use, and
 * returns it. Not a squash: cards that waited for this one already contain its commits, and a squash would make
 * them conflict with it. The base's first-parent history still reads as one commit per card.
 */
export async function landingCommit(repo: string, scratch: string, base: string, branch: string, message: string): Promise<string> {
  if (!existsSync(scratch)) {
    await mkdir(dirname(scratch), { recursive: true });
    await git(repo, ['worktree', 'add', '--detach', scratch, base]);
  }
  await git(scratch, ['merge', '--abort']).catch(() => {});
  await git(scratch, ['checkout', '-q', '--force', '--detach', base]);
  await git(scratch, ['clean', '-fdq']);
  await git(scratch, [...(await identityArgs(scratch)), 'merge', '--no-ff', '-q', '-m', message, branch]);
  return git(scratch, ['rev-parse', 'HEAD']);
}

/** The worktree that has `branch` checked out, if any. */
async function checkoutOf(repo: string, branch: string): Promise<string | null> {
  const list = await git(repo, ['worktree', 'list', '--porcelain']);
  for (const block of list.split('\n\n')) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (path && block.includes(`branch refs/heads/${branch}`)) return path;
  }
  return null;
}

/**
 * Fast-forwards `branch` to `sha` without touching anyone's uncommitted work. A checkout of the branch must be
 * clean (untracked files aside); otherwise nothing moves and the reason is returned.
 */
export async function advanceBranch(repo: string, branch: string, sha: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const old = await revParse(repo, `refs/heads/${branch}`);
  if (old === sha) return { ok: true };
  if (old && !(await git(repo, ['merge-base', '--is-ancestor', old, sha]).then(() => true, () => false))) {
    return { ok: false, reason: `${branch} has moved on (${old.slice(0, 8)} is not behind ${sha.slice(0, 8)})` };
  }
  const checkout = await checkoutOf(repo, branch);
  if (!checkout) {
    await git(repo, ['update-ref', `refs/heads/${branch}`, sha, ...(old ? [old] : [])]);
    return { ok: true };
  }
  const dirty = await git(checkout, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty) return { ok: false, reason: `${checkout} has uncommitted changes on ${branch}` };
  try {
    await git(checkout, ['merge', '--ff-only', '-q', sha]);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `could not fast-forward ${checkout}: ${(err as Error).message.split('\n')[0]}` };
  }
}

export async function pushBranch(dir: string, branch: string): Promise<void> {
  await git(dir, ['push', '-q', '--force-with-lease', '-u', 'origin', `${branch}:${branch}`]);
}

/** Runs the board's test command in a worktree. The output is kept to its last 20k characters. */
export function runTests(dir: string, command: string, timeoutSec: number): Promise<{ ok: boolean; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    execFile('sh', ['-c', command], { cwd: dir, timeout: timeoutSec * 1000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`.slice(-20_000);
      const timedOut = !!err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
      resolve({ ok: !err, output, timedOut });
    });
  });
}

export interface FileChange {
  path: string;
  /** git's status letter: A added, M modified, D deleted, R renamed, … */
  status: string;
  /** Null for binary files. */
  additions: number | null;
  deletions: number | null;
  /** The old path of a rename. */
  from?: string;
}

/** Files changed between two commits, with line counts (renames detected). */
export async function changesBetween(repo: string, from: string, to: string): Promise<FileChange[]> {
  if (from === to) return [];
  const status = await git(repo, ['diff', '--name-status', '-M', from, to]);
  const counts = await git(repo, ['diff', '--numstat', '-M', from, to]);
  const lines = new Map<string, [number | null, number | null]>();
  for (const line of counts.split('\n').filter(Boolean)) {
    const [add, del, ...rest] = line.split('\t');
    // A rename shows as "old => new" or "dir/{old => new}"; keep the new path.
    const path = rest.join('\t').replace(/\{[^}]* => ([^}]*)\}/, '$1').replace(/^.* => /, '');
    lines.set(path, [add === '-' ? null : Number(add), del === '-' ? null : Number(del)]);
  }
  return status
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [code, a, b] = line.split('\t');
      const path = b ?? a!;
      const [additions, deletions] = lines.get(path) ?? [null, null];
      return { path, status: code![0]!, additions, deletions, ...(b ? { from: a } : {}) };
    });
}

/** Commits reachable from `to` but not `from`, oldest first. */
export async function commitsBetween(repo: string, from: string, to: string): Promise<{ sha: string; subject: string; date: string }[]> {
  if (from === to) return [];
  const out = await git(repo, ['log', '--reverse', '--format=%H%x09%cI%x09%s', `${from}..${to}`]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, date, ...s] = l.split('\t');
      return { sha: sha!, date: date!, subject: s.join('\t') };
    });
}

/** Unified diff between two commits, optionally for one file. */
export async function diffBetween(repo: string, from: string, to: string, path?: string): Promise<string> {
  return git(repo, ['diff', '-M', from, to, ...(path ? ['--', path] : [])]);
}

/** A file's content at a commit; null when it doesn't exist there. */
export async function fileAt(repo: string, ref: string, path: string): Promise<string | null> {
  try {
    // Exact contents: git() trims, which would drop a file's leading indentation and final newline.
    const { stdout } = await run('git', ['show', `${ref}:${path}`], { cwd: repo, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch {
    return null;
  }
}

/** Removes a card's worktree and branch (a best-of-N candidate that lost). Failures are ignored: it may already be gone. */
export async function removeWorktree(repo: string, dir: string | null, branch: string | null): Promise<void> {
  if (dir) await git(repo, ['worktree', 'remove', '--force', dir]).catch(() => {});
  await git(repo, ['worktree', 'prune']).catch(() => {});
  if (branch) await git(repo, ['branch', '-D', branch]).catch(() => {});
}

/** True when the checkout has no uncommitted changes to tracked files (untracked files aside). */
export async function isClean(dir: string): Promise<boolean> {
  return (await git(dir, ['status', '--porcelain', '--untracked-files=no'])) === '';
}

/** What the main checkout has checked out: a branch name, or null when it is detached. */
export async function currentBranch(repo: string): Promise<string | null> {
  const b = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return b === 'HEAD' ? null : b;
}

/**
 * "Try it locally": puts the checkout at a card's work. `checkout` detaches HEAD at the branch head (the branch itself
 * is checked out in the card's worktree, so it can't be checked out twice); `apply` leaves HEAD alone and applies the
 * card's diff to the working tree. Both refuse a checkout with uncommitted changes, so nothing of yours is lost.
 */
export async function tryLocally(repo: string, mode: 'checkout' | 'apply', ref: string, base: string): Promise<{ summary: string }> {
  if (!(await isClean(repo))) throw new Error('your checkout has uncommitted changes; commit or stash them first');
  if (mode === 'checkout') {
    const was = (await currentBranch(repo)) ?? base;
    await git(repo, ['checkout', '--detach', '-q', ref]);
    return { summary: `Checked out ${ref.slice(0, 8)} (detached HEAD). Return with: git checkout ${was}` };
  }
  const patch = await git(repo, ['diff', '--binary', '--no-color', `${base}...${ref}`]);
  if (!patch) return { summary: 'The card changed nothing against the base branch.' };
  const file = join(await mkdtemp(join(tmpdir(), 'ih-patch-')), 'card.patch');
  await writeFile(file, `${patch}\n`);
  try {
    await git(repo, ['apply', '--whitespace=nowarn', file]);
  } catch (err) {
    throw new Error(`the diff does not apply to your working tree: ${(err as Error).message.split('\n')[0]}`);
  } finally {
    await rm(dirname(file), { recursive: true, force: true });
  }
  return { summary: 'Applied the card’s diff to your working tree (unstaged). Revert with: git checkout -- .' };
}
