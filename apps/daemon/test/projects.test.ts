import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/git.ts';
import { expandPath, inspectFolder, prepareRepo } from '../src/projects.ts';
import { setup } from './harness.ts';

test('inspectFolder: missing, empty, files, a repo, a subfolder of a repo; directories only, hidden on request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ih-fs-'));
  assert.equal(expandPath('~'), homedir());
  assert.equal(expandPath('~/x'), join(homedir(), 'x'));

  const missing = await inspectFolder(join(root, 'nope'));
  assert.equal(missing.exists, false);

  mkdirSync(join(root, 'empty'));
  mkdirSync(join(root, 'files', '.hidden'), { recursive: true });
  writeFileSync(join(root, 'files', 'a.txt'), 'a');
  mkdirSync(join(root, 'repo', 'src'), { recursive: true });
  await git(join(root, 'repo'), ['init', '-q', '-b', 'trunk']);

  const top = await inspectFolder(root);
  assert.deepEqual(top.dirs, [{ name: 'empty', git: false }, { name: 'files', git: false }, { name: 'repo', git: true }]);
  assert.equal((await inspectFolder(join(root, 'empty'))).itemCount, 0);
  const files = await inspectFolder(join(root, 'files'));
  assert.equal(files.itemCount, 1, 'hidden entries are not counted');
  assert.deepEqual(files.dirs, []);
  assert.deepEqual((await inspectFolder(join(root, 'files'), { hidden: true })).dirs.map((d) => d.name), ['.hidden']);
  assert.equal((await inspectFolder(join(root, 'files', 'a.txt'))).notDirectory, true);

  const repo = await inspectFolder(join(root, 'repo'));
  assert.equal(repo.git!.commits, 0);
  assert.equal(repo.git!.branch, 'trunk');
  assert.equal(repo.git!.inside, false);
  assert.equal((await inspectFolder(join(root, 'repo', 'src'))).git!.inside, true);
});

test('prepareRepo: a new folder becomes a project; existing files are committed; subfolders of a repo and existing commits are left alone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ih-prep-'));

  const fresh = await prepareRepo(join(root, 'new', 'thing'), 'New Thing', { create: true, gitignore: 'python' }, null);
  assert.deepEqual(fresh.did, ['created the folder', 'initialized git on main', 'added README.md', 'added .gitignore', 'made the first commit']);
  assert.equal(readFileSync(join(fresh.path, 'README.md'), 'utf8'), '# New Thing\n');
  assert.match(readFileSync(join(fresh.path, '.gitignore'), 'utf8'), /__pycache__/);
  assert.equal(await git(fresh.path, ['log', '--format=%s']), 'Initial commit');

  await assert.rejects(prepareRepo(join(root, 'absent'), 'x', {}, null), /does not exist/);

  const existing = join(root, 'existing');
  mkdirSync(join(existing, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(existing, 'app.js'), 'console.log(1)\n');
  writeFileSync(join(existing, 'node_modules', 'dep', 'index.js'), '');
  const done = await prepareRepo(existing, 'App', { gitignore: 'none', branch: 'develop' }, null);
  assert.deepEqual(done.did, ['initialized git on develop', 'added README.md', 'made the first commit']);
  assert.deepEqual((await git(existing, ['ls-files'])).split('\n').sort(), ['README.md', 'app.js'], 'build output left out');

  const again = await prepareRepo(existing, 'App', {}, null);
  assert.deepEqual(again.did, [], 'a repository with commits is not touched');
  mkdirSync(join(existing, 'lib'));
  await assert.rejects(prepareRepo(join(existing, 'lib'), 'x', {}, null), /inside the repository/);
  await assert.rejects(prepareRepo(join(root, 'bad'), 'x', { create: true, branch: 'a b' }, null), /invalid branch/);
  await assert.rejects(prepareRepo(fresh.path, 'x', { github: 'private' }, null), /gh\) is not installed/);
});

test('POST /api/boards sets up a repository on request and refuses a subfolder; /api/fs browses', async () => {
  const { cfg, close } = await setup();
  try {
    const base = `http://127.0.0.1:${cfg.port}/api`;
    const post = async (body: unknown) => {
      const res = await fetch(`${base}/boards`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as any };
    };
    const root = mkdtempSync(join(tmpdir(), 'ih-api-'));
    const target = join(root, 'proj');

    const without = await post({ name: 'Proj', repoPath: target });
    assert.equal(without.status, 400);
    assert.match(without.body.error, /does not exist/);

    const made = await post({ name: 'Proj', repoPath: target, setup: { create: true } });
    assert.equal(made.status, 200);
    assert.equal(made.body.defaultBranch, 'main');
    assert.ok(made.body.setup.includes('made the first commit'));

    mkdirSync(join(target, 'sub'));
    const sub = await post({ name: 'Sub', repoPath: join(target, 'sub') });
    assert.equal(sub.status, 400);
    assert.match(sub.body.error, /inside the repository/);

    const fs = (await (await fetch(`${base}/fs?path=${encodeURIComponent(root)}`)).json()) as any;
    assert.deepEqual(fs.dirs, [{ name: 'proj', git: true }]);
    assert.equal(typeof fs.gh, 'boolean');
    assert.equal(fs.home, homedir());
  } finally {
    await close();
  }
});
