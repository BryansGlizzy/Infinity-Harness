// New-board helpers: browse folders, tell what a folder is (empty, files, git repo with or without commits), and
// turn it into a repository the board can drive (create the folder, git init, README/.gitignore, first commit,
// optionally a GitHub repo). The daemon only listens on localhost, and the browser lists directories only.
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { commitAll, git, originUrl } from './git.ts';
import { isGitHubRemote } from './github.ts';

const run = promisify(execFile);

/** The same folder, whatever symlinks lead to it (git reports real paths). */
export const samePath = (a: string, b: string) => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
};

/** `~` and `~/x` expanded, then made absolute. */
export function expandPath(p: string): string {
  const t = p.trim();
  if (t === '~') return homedir();
  if (t.startsWith('~/')) return join(homedir(), t.slice(2));
  return resolve(t);
}

export interface FolderEntry {
  name: string;
  /** A git repository root. */
  git: boolean;
}

export interface FolderInfo {
  path: string;
  parent: string | null;
  exists: boolean;
  /** Exists but is a file. */
  notDirectory?: boolean;
  /** Subdirectories (hidden ones only when asked). */
  dirs: FolderEntry[];
  /** Files and folders in it, hidden ones excluded. */
  itemCount: number;
  git: null | {
    /** The repository's top level; differs from `path` when the folder is inside a repo. */
    root: string;
    branch: string;
    commits: number;
    origin: string | null;
    github: boolean;
    /** Uncommitted changes in the checkout (landing waits for a clean checkout). */
    dirty: boolean;
    /** The folder is a subfolder of the repository, not its top level. */
    inside: boolean;
  };
}

async function gitInfo(path: string): Promise<FolderInfo['git']> {
  let root: string;
  try {
    root = await git(path, ['rev-parse', '--show-toplevel']);
  } catch {
    return null;
  }
  const commits = Number(await git(root, ['rev-list', '--count', 'HEAD']).catch(() => '0')) || 0;
  const branch = commits
    ? await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
    : (await git(root, ['symbolic-ref', '--short', 'HEAD']).catch(() => 'main'));
  const origin = await originUrl(root).catch(() => null);
  const dirty = !!(await git(root, ['status', '--porcelain']).catch(() => ''));
  return { root, branch, commits, origin, github: isGitHubRemote(origin), dirty, inside: !samePath(root, path) };
}

export async function inspectFolder(raw: string, opts: { hidden?: boolean } = {}): Promise<FolderInfo> {
  const path = expandPath(raw || '~');
  const parent = dirname(path) === path ? null : dirname(path);
  if (!existsSync(path)) return { path, parent, exists: false, dirs: [], itemCount: 0, git: null };
  if (!(await stat(path)).isDirectory()) return { path, parent, exists: true, notDirectory: true, dirs: [], itemCount: 0, git: null };
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    // unreadable: show it as empty rather than failing the browser
  }
  const visible = entries.filter((e) => !e.name.startsWith('.'));
  const dirs = entries
    .filter((e) => e.isDirectory() && (opts.hidden || !e.name.startsWith('.')))
    .map((e) => ({ name: e.name, git: existsSync(join(path, e.name, '.git')) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { path, parent, exists: true, dirs, itemCount: visible.length, git: await gitInfo(path) };
}

export const GITIGNORE_PRESETS: Record<string, string[]> = {
  none: [],
  general: ['.DS_Store', '*.log', '.env', '.env.*', '!.env.example'],
  python: ['__pycache__/', '*.pyc', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/', '.venv/', 'venv/', '*.egg-info/', 'dist/', 'build/', '.env'],
  node: ['node_modules/', 'dist/', 'build/', 'coverage/', '.env', '*.log', '.DS_Store'],
};

export interface RepoSetup {
  /** Create the folder if it doesn't exist. */
  create?: boolean;
  /** Branch for a new repository. */
  branch?: string;
  gitignore?: keyof typeof GITIGNORE_PRESETS;
  /** Create a GitHub repository from it and push (needs gh, signed in). */
  github?: 'none' | 'private' | 'public';
}

/**
 * Makes `path` a repository a board can use: creates the folder, runs git init, adds a README and .gitignore when
 * missing, and commits everything as the first commit. Existing commits are never touched. Returns what was done.
 */
export async function prepareRepo(raw: string, name: string, setup: RepoSetup, gh: string | null): Promise<{ path: string; did: string[] }> {
  const path = expandPath(raw);
  const did: string[] = [];
  if (!existsSync(path)) {
    if (!setup.create) throw new Error(`path does not exist: ${path}`);
    await mkdir(path, { recursive: true });
    did.push('created the folder');
  } else if (!(await stat(path)).isDirectory()) {
    throw new Error(`not a folder: ${path}`);
  }

  let info = await gitInfo(path);
  if (info && !samePath(info.root, path)) throw new Error(`this folder is inside the repository at ${info.root}; choose that folder instead`);
  if (!info) {
    const branch = (setup.branch ?? 'main').trim() || 'main';
    if (!/^[A-Za-z0-9._/-]+$/.test(branch)) throw new Error(`invalid branch name: ${branch}`);
    await git(path, ['init', '-q', '-b', branch]);
    did.push(`initialized git on ${branch}`);
    info = await gitInfo(path);
  }

  if (!info!.commits) {
    if (!existsSync(join(path, 'README.md'))) {
      await writeFile(join(path, 'README.md'), `# ${name.trim() || basename(path)}\n`);
      did.push('added README.md');
    }
    const ignore = GITIGNORE_PRESETS[setup.gitignore ?? 'general'] ?? [];
    if (ignore.length && !existsSync(join(path, '.gitignore'))) {
      await writeFile(join(path, '.gitignore'), `${ignore.join('\n')}\n`);
      did.push('added .gitignore');
    }
    const sha = await commitAll(path, 'Initial commit');
    if (!sha) throw new Error('nothing to commit for the first commit');
    did.push('made the first commit');
  }

  if (setup.github && setup.github !== 'none') {
    if (!gh) throw new Error('the GitHub CLI (gh) is not installed');
    if (await originUrl(path).catch(() => null)) throw new Error('the repository already has an origin remote');
    const repoName = (name.trim() || basename(path)).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || basename(path);
    await run(gh, ['repo', 'create', repoName, `--${setup.github}`, '--source', path, '--remote', 'origin', '--push'], { cwd: path });
    did.push(`created the ${setup.github} GitHub repository ${repoName} and pushed`);
  }
  return { path, did };
}
