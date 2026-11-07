import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Toolchains, package caches and SDKs that live in the user's home (relative to it). Agents may run, read and write
 * these outside their worktree: building or testing a change needs them (`~/.platformio/penv/bin/pio`, `~/.cargo`,
 * `~/.cache/pip`, …). Only the ones that exist are used.
 */
export const HOME_TOOL_DIRS = [
  '.local/bin', '.local/lib', '.local/share/pnpm', '.local/share/mise', '.local/share/uv', '.local/share/virtualenvs', '.local/pipx',
  '.cache', '.npm', '.npm-global', '.pnpm-store', '.yarn', '.bun', '.deno', '.nvm', '.volta', '.fnm', '.node-gyp',
  '.cargo', '.rustup', '.pyenv', '.conda', 'miniconda3', 'anaconda3', 'miniforge3', '.virtualenvs',
  '.platformio', '.arduino15', '.espressif', 'esp', '.zephyrproject', '.particle',
  'go', '.gradle', '.m2', '.sdkman', '.android', 'Android/Sdk', '.dotnet', '.nuget',
  '.julia', '.ghcup', '.cabal', '.stack', '.opam', '.gem', '.rbenv', '.asdf', '.elan', '.swiftpm', '.opencode/bin',
];

/** Scratch space shared by every session (tests and builds put temporary files there). */
export function scratchRoots(): string[] {
  return [...new Set(['/tmp', '/var/tmp', tmpdir()])];
}

/**
 * Directories outside a worktree that agents' tools may use: scratch space, the toolchains in the user's home, every
 * directory on PATH, and extra paths from settings (`~` expanded). Missing directories are left out.
 */
export function toolRoots(env: NodeJS.ProcessEnv = process.env, extra: string[] = [], home = homedir()): string[] {
  const roots = new Set<string>();
  const add = (p: string) => {
    if (!p || !isAbsolute(p)) return;
    const abs = resolve(p);
    // Never the home directory or the filesystem root themselves: that would allow everything.
    if (abs === '/' || abs === resolve(home)) return;
    if (existsSync(abs)) roots.add(abs);
  };
  for (const p of scratchRoots()) add(p);
  for (const rel of HOME_TOOL_DIRS) add(join(home, rel));
  for (const p of (env.PATH ?? '').split(delimiter)) add(p);
  for (const p of extra) add(p.trim().startsWith('~') ? join(home, p.trim().slice(1)) : p.trim());
  return [...roots];
}

/**
 * The git directories a worktree's commits write to: its own gitdir (`<repo>/.git/worktrees/<name>`) and the common
 * dir with objects and refs (`<repo>/.git`). For a plain checkout both are `<cwd>/.git`, which is inside it anyway.
 */
export function gitDirs(cwd: string): string[] {
  const dotGit = join(cwd, '.git');
  try {
    if (!statSync(dotGit).isFile()) return [];
    const gitdir = resolve(cwd, /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim() ?? '');
    const commonFile = join(gitdir, 'commondir');
    const common = existsSync(commonFile) ? resolve(gitdir, readFileSync(commonFile, 'utf8').trim()) : gitdir;
    return [...new Set([gitdir, common])];
  } catch {
    return [];
  }
}

/** True when `path` is `root` or inside it. */
export function isInside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** A shared root as it applies to one worktree: everything under `root` except the `except` subtree. */
export interface SharedRoot {
  root: string;
  except?: string;
}

/**
 * The shared roots that apply to one worktree. A root that contains the worktree (e.g. /tmp, when the state dir lives
 * there) stays usable except for its top-level folder that holds the worktree, so the shared roots can never open up
 * sibling worktrees or the main checkout.
 */
export function rootsFor(cwd: string, roots: string[]): SharedRoot[] {
  return roots.map((r) => {
    if (!isInside(cwd, r)) return { root: resolve(r) };
    const top = relative(resolve(r), resolve(cwd)).split(sep)[0];
    return { root: resolve(r), except: top ? join(resolve(r), top) : resolve(r) };
  });
}

/** True when `path` is under one of the shared roots and not in its excluded subtree. */
export function inShared(path: string, shared: SharedRoot[]): boolean {
  return shared.some((s) => isInside(path, s.root) && !(s.except && isInside(path, s.except)));
}

/** Shared roots a sandboxing harness (Codex) should make writable: those not containing the worktree. */
export function writableDirsFor(cwd: string, roots: string[]): string[] {
  return [...new Set(roots.map((r) => resolve(r)))].filter((r) => !isInside(cwd, r));
}

/** Entries of the real home that agy's isolated HOME links to, so `~/…` toolchains and git config resolve for its shell. */
const AGY_HOME_LINKS = [...HOME_TOOL_DIRS, '.gitconfig', '.config/git', '.npmrc', '.yarnrc', '.yarnrc.yml', '.condarc', '.pip', '.config/pip', '.pypirc'];

/** Links `rel` from `home` to the same path under `realHome`, creating parent directories as real ones. */
export function linkHomeEntry(home: string, realHome: string, rel: string): void {
  const target = join(realHome, rel);
  const link = join(home, rel);
  if (!existsSync(target)) return;
  try {
    lstatSync(link);
    return; // already there (link or a real entry the harness made)
  } catch {
    // missing: create it
  }
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link);
}

/**
 * A HOME for the agy ACP server that holds only its own login (`~/.gemini/antigravity-acp`, symlinked), so the
 * user's Antigravity IDE/CLI MCP servers and skills (`~/.gemini/config`) never load into board workers.
 * Toolchains and git config are linked in too: agy's shell inherits this HOME, and without them `~/.cargo/bin`,
 * `~/.platformio`, nvm or pip's user site would be missing from its commands.
 */
export function isolatedAgyHome(dir: string, realHome = homedir()): string {
  const gemini = join(dir, '.gemini');
  mkdirSync(gemini, { recursive: true });
  const link = join(gemini, 'antigravity-acp');
  const target = join(realHome, '.gemini', 'antigravity-acp');
  mkdirSync(target, { recursive: true, mode: 0o700 });
  if (!existsSync(link)) symlinkSync(target, link);
  for (const rel of AGY_HOME_LINKS) linkHomeEntry(dir, realHome, rel);
  return dir;
}
