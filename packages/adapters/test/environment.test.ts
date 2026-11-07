import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HarnessEvent } from '@mh/core';
import { AcpAgent, claudeSessionDirs, decidePermission, gitDirs, isolatedAgyHome, rootsFor, toolRoots, writableDirsFor } from '../src/index.ts';

const fakeAgent = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));

/** A fake home with a few toolchains, and a worktree outside it (like .meta-harness/worktrees). */
function machine() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mh-env-')));
  const home = join(base, 'home');
  for (const d of ['.platformio/penv/bin', '.local/bin', '.cargo/bin', '.cache/pip', '.ssh', 'Desktop/other-project', '.gemini/config']) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, '.gitconfig'), '[user]\n  name = t\n');
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'secret');
  const sdk = join(base, 'opt', 'sdk');
  mkdirSync(sdk, { recursive: true });
  const worktree = join(base, 'state', 'worktrees', 'b1', 'c1');
  mkdirSync(worktree, { recursive: true });
  return { base, home, sdk, worktree };
}

const shell = (command: string, cwd: string, roots: string[]) => decidePermission({ kind: 'execute', title: command, rawInput: { command, cwd } }, cwd, roots);

test('toolRoots: existing toolchain folders, PATH entries and extras; never the home itself', () => {
  const m = machine();
  const roots = toolRoots({ PATH: [join(m.home, '.cargo', 'bin'), '/usr/bin', m.home, join(m.base, 'missing')].join(':') }, ['~/.ssh/../Desktop/nothing', m.sdk], m.home);
  assert.ok(roots.includes(join(m.home, '.platformio')));
  assert.ok(roots.includes(join(m.home, '.local', 'bin')));
  assert.ok(roots.includes(join(m.home, '.cache')));
  assert.ok(roots.includes(join(m.home, '.cargo', 'bin')));
  assert.ok(roots.includes('/usr/bin'));
  assert.ok(roots.includes(m.sdk), 'an extra path from settings');
  assert.ok(roots.includes('/tmp'));
  assert.ok(!roots.includes(m.home), 'a PATH entry equal to HOME is not a root');
  assert.ok(!roots.some((r) => r.includes('.ssh')), '.ssh is not a toolchain');
  assert.ok(!roots.some((r) => r.includes('missing') || r.includes('nothing')), 'missing folders are left out');
});

test('the commands refused on 2026-11-04 are allowed with shared roots; private paths still are not', () => {
  const m = machine();
  const roots = toolRoots({ PATH: '/usr/bin' }, [], m.home);
  const cwd = m.worktree;
  // Kimi's PlatformIO build (the "couldn't test" incident), NIM's venv in /tmp, a scratch build dir.
  assert.equal(shell(`${m.home}/.platformio/penv/bin/pio run -d firmware/teensy41-dongle`, cwd, roots).allow, true);
  assert.equal(shell('python3 -m venv /tmp/opencode/pytest-venv && /tmp/opencode/pytest-venv/bin/pip install pytest', cwd, roots).allow, true);
  assert.equal(shell(`ls ${m.home}/.local/bin`, cwd, roots).allow, true);
  assert.equal(shell('PLATFORMIO_CORE_DIR=/tmp/amv-pio pio run > /tmp/amv-build.log 2>&1', cwd, roots).allow, true);
  // Still refused: other projects, private files, the home folder itself, sibling worktrees.
  assert.equal(shell(`ls ${m.home}/Desktop/other-project`, cwd, roots).allow, false);
  assert.equal(shell(`cat ${m.home}/.ssh/id_ed25519`, cwd, roots).allow, false);
  assert.equal(shell(`ls ${m.home}`, cwd, roots).allow, false);
  assert.equal(shell(`cat ${join(m.base, 'state', 'worktrees', 'b1', 'c2', 'a.ts')}`, cwd, roots).allow, false);
  // Without roots nothing changes: the worktree only (the strict default the older tests pin).
  assert.equal(shell(`${m.home}/.platformio/penv/bin/pio run`, cwd, []).allow, false);
  assert.match(shell(`${m.home}/.platformio/penv/bin/pio run`, cwd, roots).reason, /shared tool locations/);
});

test('under a shared root that contains the worktree, the folder holding it stays refused', () => {
  const cwd = '/tmp/mh-state/worktrees/b1/c1';
  assert.deepEqual(rootsFor(cwd, ['/tmp', '/opt/sdk']), [{ root: '/tmp', except: '/tmp/mh-state' }, { root: '/opt/sdk' }]);
  assert.equal(decidePermission({ locations: [{ path: '/tmp/mh-state/worktrees/b1/c2/a.ts' }] }, cwd, ['/tmp']).allow, false, 'a sibling worktree');
  assert.equal(decidePermission({ locations: [{ path: '/tmp/build/out.log' }] }, cwd, ['/tmp']).allow, true, 'other scratch space');
  assert.equal(decidePermission({ locations: [{ path: '/opt/sdk/include/x.h' }] }, cwd, ['/tmp', '/opt/sdk']).allow, true);
  assert.deepEqual(writableDirsFor(cwd, ['/tmp', '/opt/sdk', '/opt/sdk']), ['/opt/sdk'], 'Codex gets only roots outside the worktree');
});

test('gitDirs: a linked worktree names its own gitdir and the common dir; a plain checkout none', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mh-git-')));
  const repo = join(base, 'repo');
  mkdirSync(repo);
  const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const wt = join(base, 'wt');
  g(repo, 'worktree', 'add', '-q', '-b', 'mh/x', wt);
  assert.deepEqual(gitDirs(wt), [join(repo, '.git', 'worktrees', 'wt'), join(repo, '.git')]);
  assert.deepEqual(gitDirs(repo), []);
  // With the git dirs shared, a commit's writes are allowed but the main checkout is not.
  const roots = gitDirs(wt);
  assert.equal(decidePermission({ locations: [{ path: join(repo, '.git', 'objects', 'ab') }] }, wt, roots).allow, true);
  assert.equal(decidePermission({ locations: [{ path: join(repo, 'README.md') }] }, wt, roots).allow, false);
});

test('isolatedAgyHome links the login, toolchains and git config, but not the IDE config or private files', () => {
  const m = machine();
  const dir = join(m.base, 'agy-home');
  isolatedAgyHome(dir, m.home);
  isolatedAgyHome(dir, m.home); // idempotent
  assert.equal(readlinkSync(join(dir, '.gemini', 'antigravity-acp')), join(m.home, '.gemini', 'antigravity-acp'));
  assert.equal(readlinkSync(join(dir, '.platformio')), join(m.home, '.platformio'));
  assert.equal(readlinkSync(join(dir, '.local', 'bin')), join(m.home, '.local', 'bin'));
  assert.ok(lstatSync(join(dir, '.local')).isDirectory() && !lstatSync(join(dir, '.local')).isSymbolicLink(), 'parents are real folders');
  assert.equal(readlinkSync(join(dir, '.gitconfig')), join(m.home, '.gitconfig'));
  assert.ok(!existsSync(join(dir, '.gemini', 'config')), "the user's Antigravity MCP config stays out");
  assert.ok(!existsSync(join(dir, '.ssh')));
  assert.ok(!existsSync(join(dir, 'Desktop')));
});

test("claudeSessionDirs: Claude's saved tool output for the session may be read back", () => {
  const payload = { transcript_path: '/h/.claude/projects/-wt-c1/e05e.jsonl' };
  assert.deepEqual(claudeSessionDirs(payload), ['/h/.claude/projects/-wt-c1/e05e']);
  assert.deepEqual(claudeSessionDirs({}), []);
  const read = { locations: [{ path: '/h/.claude/projects/-wt-c1/e05e/tool-results/b.txt' }] };
  assert.equal(decidePermission(read, '/wt/c1', claudeSessionDirs(payload)).allow, true);
  assert.equal(decidePermission({ locations: [{ path: '/h/.claude/projects/-other/x.jsonl' }] }, '/wt/c1', claudeSessionDirs(payload)).allow, false);
});

test('ACP sessions apply shared roots to shell permissions; Codex-style adapters also get them as additionalDirectories', async () => {
  const m = machine();
  const roots = toolRoots({ PATH: '' }, [], m.home);
  const run = async (additionalDirectories: boolean) => {
    const a = new AcpAgent({ id: 'fake', command: process.execPath, args: [fakeAgent], cwd: tmpdir(), env: process.env, additionalDirectories });
    const events: HarnessEvent[] = [];
    try {
      const s = await a.startSession({ cwd: m.worktree, sharedRoots: roots, onEvent: (e) => events.push(e) });
      await s.prompt(`DIRS\nSHELL ${m.home}/.platformio/penv/bin/pio run\nSHELL cat ${m.home}/.ssh/id_ed25519`);
      s.close();
    } finally {
      a.shutdown();
    }
    return events.filter((e) => e.type === 'message').map((e) => (e.type === 'message' ? e.text : '')).join('');
  };
  const codex = await run(true);
  assert.match(codex, /shell=yes\nshell=no/);
  const dirs = JSON.parse(/dirs=(.*)\n/.exec(codex)![1]!) as string[];
  assert.ok(dirs.includes(join(m.home, '.platformio')));
  const other = await run(false);
  assert.match(other, /dirs=null/, 'other harnesses get no extra session/new field');
  assert.match(other, /shell=yes\nshell=no/);
});
