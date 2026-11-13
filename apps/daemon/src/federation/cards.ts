// Drafting the project card a swarm may publish (master plan Phase 7, "the project directory"). The facts come from
// the repository's own files, so nothing here is invented; the fast lane (or the orchestrator) only words them. The
// operator reviews and edits the draft before anything is published. Local paths and credentials are scrubbed.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Board, ProjectCard } from '@ih/core';
import type { Store } from '@ih/db';
import { projectCardJob, readProjectCard, type FastLane } from '@ih/fast-lane';
import { git } from '../git.ts';
import { cleanLine, cleanList, cleanText } from './protocol.ts';

export interface ProjectFacts {
  name: string;
  description: string;
  readme: string;
  provides: string[];
  uses: string[];
  stack: string[];
  version: string | null;
  lastCommit: string | null;
  recent: string[];
  manifests: string[];
}

function read(path: string, max = 20000): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8').slice(0, max) : null;
  } catch {
    return null;
  }
}

/** A repository URL without a login, in the https form people share. */
export function publicRepoUrl(url: string): string | null {
  let u = url.trim();
  const scp = /^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?$/.exec(u);
  if (scp) u = `https://${scp[1]}/${scp[2]}`;
  u = u.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/[\w.-]+@/, 'https://');
  try {
    const parsed = new URL(u);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString().replace(/\.git$/, '').replace(/\/$/, '');
  } catch {
    return null;
  }
}

/** Removes the machine's own paths from text that is about to leave it. */
export function scrubPaths(text: string, repoPath: string): string {
  let out = text;
  for (const p of [repoPath, homedir()]) if (p && p.length > 3) out = out.split(p).join(p === repoPath ? '.' : '~');
  return out;
}

const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];

function tomlString(text: string, key: string): string | null {
  return new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm').exec(text)?.[1] ?? null;
}

/** The names a TOML table's keys carry (`[dependencies]` in Cargo.toml). */
function tomlTableKeys(text: string, table: string): string[] {
  const m = new RegExp(`^\\[${table.replace('.', '\\.')}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm').exec(text);
  if (!m) return [];
  return [...m[1]!.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=/gm)].map((x) => x[1]!);
}

export async function gatherFacts(store: Store, board: Board): Promise<ProjectFacts> {
  const dir = board.repoPath;
  const provides: string[] = [];
  const uses: string[] = [];
  const stack: string[] = [];
  const manifests: string[] = [];
  let name = board.name;
  let description = '';
  let version: string | null = null;

  const pkgText = read(join(dir, 'package.json'));
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText) as Record<string, any>;
      manifests.push('package.json');
      stack.push('node');
      if (typeof pkg.name === 'string') (provides.push(pkg.name), (name = pkg.name.replace(/^@[^/]+\//, '')));
      if (typeof pkg.description === 'string') description = pkg.description;
      if (typeof pkg.version === 'string') version = pkg.version;
      const bins = typeof pkg.bin === 'string' ? [pkg.name] : pkg.bin && typeof pkg.bin === 'object' ? Object.keys(pkg.bin) : [];
      provides.push(...bins.map((b) => `command ${b}`));
      const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
      const url = typeof repo === 'string' ? publicRepoUrl(repo) : null;
      if (url) provides.push(url);
      const deps = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies });
      uses.push(...deps);
      if ({ ...pkg.dependencies, ...pkg.devDependencies }.typescript) stack.push('typescript');
      for (const [dep, label] of [['react', 'react'], ['vue', 'vue'], ['fastify', 'fastify'], ['express', 'express'], ['next', 'next.js']] as const) if (deps.includes(dep)) stack.push(label);
    } catch {
      // an unreadable manifest is just not used
    }
  }
  const py = read(join(dir, 'pyproject.toml'));
  if (py) {
    manifests.push('pyproject.toml');
    stack.push('python');
    const n = tomlString(py, 'name');
    if (n) (provides.push(n), name === board.name && (name = n));
    description ||= tomlString(py, 'description') ?? '';
    version ||= tomlString(py, 'version');
    const block = /^dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(py)?.[1] ?? '';
    uses.push(...[...block.matchAll(/["']([A-Za-z0-9_.-]+)/g)].map((x) => x[1]!));
  }
  const cargo = read(join(dir, 'Cargo.toml'));
  if (cargo) {
    manifests.push('Cargo.toml');
    stack.push('rust');
    const n = tomlString(cargo, 'name');
    if (n) (provides.push(n), name === board.name && (name = n));
    description ||= tomlString(cargo, 'description') ?? '';
    version ||= tomlString(cargo, 'version');
    uses.push(...tomlTableKeys(cargo, 'dependencies'));
  }
  const gomod = read(join(dir, 'go.mod'));
  if (gomod) {
    manifests.push('go.mod');
    stack.push('go');
    const mod = /^module\s+(\S+)/m.exec(gomod)?.[1];
    if (mod) provides.push(mod);
    uses.push(...[...gomod.matchAll(/^\s*(?:require\s+)?([\w.-]+\.[\w.-]+\/[^\s]+)\s+v/gm)].map((x) => x[1]!));
  }

  let lastCommit: string | null = null;
  if (board.mode === 'worktree' || existsSync(join(dir, '.git'))) {
    lastCommit = await git(dir, ['rev-parse', '--short=12', 'HEAD']).then((s) => s || null, () => null);
    const remote = await git(dir, ['remote', 'get-url', 'origin']).then((s) => s, () => '');
    const url = remote ? publicRepoUrl(remote) : null;
    if (url) provides.push(url);
  }
  const readme = scrubPaths(read(join(dir, 'README.md')) ?? read(join(dir, 'readme.md')) ?? '', dir);
  const recent = store
    .listCards(board.id)
    .filter((c) => c.status === 'done' && c.role === 'worker' && c.pipeline.landedSha)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 8)
    .map((c) => scrubPaths(c.title, dir));
  return { name, description: scrubPaths(description, dir), readme, provides: uniq(provides), uses: uniq(uses).slice(0, 60), stack: uniq(stack), version, lastCommit, recent, manifests };
}

/** The README's first paragraphs, without headings, badges and links' markup. */
export function readmeIntro(readme: string, max = 1200): string {
  const paras = readme
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith('#') && !/^(\[!\[|!\[|<)/.test(p) && !p.startsWith('```'));
  return paras
    .join('\n\n')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .slice(0, max);
}

const factsText = (f: ProjectFacts) =>
  [
    `Project name: ${f.name}`,
    f.description ? `Manifest description: ${f.description}` : '',
    f.version ? `Version: ${f.version}` : '',
    f.stack.length ? `Stack: ${f.stack.join(', ')}` : '',
    f.provides.length ? `Provides: ${f.provides.join('; ')}` : '',
    f.uses.length ? `Depends on: ${f.uses.slice(0, 40).join(', ')}` : '',
    f.recent.length ? `Recently landed: ${f.recent.join('; ')}` : '',
    f.readme ? `README:\n${f.readme.slice(0, 7000)}` : 'No README.',
  ]
    .filter(Boolean)
    .join('\n');

/** The card without a model: manifests give what it provides and uses, the README its first words. */
export function deterministicDraft(boardId: string, f: ProjectFacts, previous: ProjectCard | null): ProjectCard {
  const intro = readmeIntro(f.readme);
  const first = f.description || intro.split(/(?<=[.!?])\s/)[0] || f.name;
  return {
    id: boardId,
    name: cleanLine(f.name, 120),
    oneLine: cleanLine(first, 200),
    about: cleanText(intro || f.description, 1500),
    provides: cleanList(f.provides),
    uses: cleanList(f.uses),
    stack: cleanList(f.stack, 20, 60),
    // Taking requests from other swarms is a decision, never a default.
    accepts: previous?.accepts ?? { requests: false, note: '' },
    version: f.version,
    lastCommit: f.lastCommit,
    recent: cleanList(f.recent, 20, 140),
    updatedAt: new Date().toISOString(),
  };
}

/** A draft from the repository's files, worded by the fast lane when it is available. */
export async function draftProjectCard(store: Store, board: Board, lane: FastLane | null, previous: ProjectCard | null): Promise<ProjectCard> {
  const facts = await gatherFacts(store, board);
  const base = deterministicDraft(board.id, facts, previous);
  if (!lane?.available) return base;
  const result = await lane.run(projectCardJob(factsText(facts)));
  const worded = result ? readProjectCard(result.text) : null;
  return worded ? { ...base, oneLine: cleanLine(worded.oneLine, 200), about: cleanText(worded.about, 1500) } : base;
}

/** The prompt for an orchestrator agent asked to write the card itself. */
export async function orchestratorDraftPrompt(store: Store, board: Board): Promise<string> {
  const facts = await gatherFacts(store, board);
  const specs = store
    .listCards(board.id)
    .filter((c) => c.role !== 'worker' || c.status === 'done')
    .slice(0, 15)
    .map((c) => `- ${scrubPaths(c.title, board.repoPath)}`);
  return [
    `You are the orchestrator of the "${board.name}" board. Other teams' agents (in other swarms) will read a short card about this project to decide whether it owns software they depend on, and may send requests to it. Write that card. Do not create cards and do not edit files.`,
    '',
    'Read the repository (README, manifests, the main modules) so what you write is true. Use the facts below as a start:',
    '',
    factsText(facts),
    ...(specs.length ? ['', 'Goals and landed work on this board:', ...specs] : []),
    '',
    'When you are ready, call propose_project_card once with:',
    '- name and one_line (what it is, one sentence);',
    '- about (a plain paragraph: what it does, who uses it, how it is built);',
    '- provides: the identities other projects depend on (package names, repository URLs, command names, module paths, APIs);',
    '- uses: the main things it depends on; stack: languages and frameworks.',
    'Leave out local paths, secrets, internal hostnames and anything private. The operator reviews and edits your card before anyone else sees it, and decides whether the project takes requests.',
  ].join('\n');
}
