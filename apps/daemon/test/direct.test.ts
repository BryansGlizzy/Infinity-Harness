// Direct mode (master plan Phase 6.1): agents work in the folder itself, without git, branches or landing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexEnv } from '@ih/adapters';
import { buildPrompt } from '../src/runner.ts';
import { setup, status, waitFor } from './harness.ts';

async function api(port: number, method: string, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
}

test('boards default by folder: a git repo gets worktrees, any other folder direct mode; either can be chosen', async () => {
  const { repo, cfg, close } = await setup();
  try {
    const plain = mkdtempSync(join(tmpdir(), 'ih-plain-'));
    writeFileSync(join(plain, 'notes.txt'), 'hi\n');
    const git = await api(cfg.port, 'POST', '/boards', { name: 'Repo', repoPath: repo });
    assert.equal(git.body.mode, 'worktree');
    const direct = await api(cfg.port, 'POST', '/boards', { name: 'Plain', repoPath: plain });
    assert.equal(direct.body.mode, 'direct');
    assert.equal(direct.body.defaultBranch, '');
    assert.ok(!existsSync(join(plain, '.git')), 'no git set up');
    const forced = await api(cfg.port, 'POST', '/boards', { name: 'Repo, direct', repoPath: repo, mode: 'direct' });
    assert.equal(forced.body.mode, 'direct');
    assert.equal(forced.body.defaultBranch, 'main');
    const fresh = join(plain, 'new-project');
    assert.equal((await api(cfg.port, 'POST', '/boards', { name: 'New', repoPath: fresh })).status, 400, 'missing folder without create');
    assert.equal((await api(cfg.port, 'POST', '/boards', { name: 'New', repoPath: fresh, setup: { create: true }, mode: 'direct' })).body.mode, 'direct');
    assert.ok(existsSync(fresh) && !existsSync(join(fresh, '.git')));
  } finally {
    await close();
  }
});

test('a direct card edits the folder itself, finishes Done without git, and its changes are the files it touched', async () => {
  const { store, runner, cfg, close } = await setup();
  try {
    const folder = mkdtempSync(join(tmpdir(), 'ih-direct-'));
    const board = store.createBoard({ name: 'Direct', repoPath: folder, defaultBranch: '', mode: 'direct' });
    const card = store.createCard({ boardId: board.id, title: 'Write notes' });
    const done = waitFor(store, status(store, card.id, 'done'));
    await runner.run(card.id, 'fa');
    await done;

    const after = store.getCard(card.id)!;
    assert.equal(after.worktree, folder);
    assert.equal(after.branch, null);
    assert.equal(readFileSync(join(folder, 'notes.md'), 'utf8'), 'written by fake/two\n', 'the edit is in the folder');
    assert.ok(!existsSync(join(folder, '.git')));
    const prompt = store.eventsFor(card.id).map((e) => (e.payload as any)?.event).find((e) => e?.role === 'user')?.text as string;
    assert.match(prompt, /the project folder itself \(direct mode/);
    assert.match(prompt, /no git checkout\/reset\/stash\/clean/);

    const changes = await api(cfg.port, 'GET', `/cards/${card.id}/changes`);
    assert.equal(changes.body.direct, true);
    assert.deepEqual(changes.body.files.map((f: any) => [f.path, f.status]), [['notes.md', 'M']]);
    assert.equal((await api(cfg.port, 'GET', `/cards/${card.id}/file?path=notes.md`)).body.content, 'written by fake/two\n');
    assert.equal((await api(cfg.port, 'GET', `/cards/${card.id}/file?path=notes.md&side=from`)).status, 404);
    assert.equal((await api(cfg.port, 'GET', `/cards/${card.id}/file?path=../x`)).status, 400);
    assert.deepEqual((await api(cfg.port, 'GET', `/cards/${card.id}/diff`)).body, { diff: '' });
  } finally {
    await close();
  }
});

test('direct boards run workers up to directParallel (default 3) and never form a council', async () => {
  const { store, scheduler, council, close } = await setup();
  try {
    const folder = mkdtempSync(join(tmpdir(), 'ih-direct-'));
    const board = store.createBoard({ name: 'Direct', repoPath: folder, defaultBranch: '', mode: 'direct' });
    assert.equal(store.getSettings(board.id).directParallel, 3, 'the default');
    store.updateSettings(board.id, {
      directParallel: 1,
      poolSlots: { fa: 3, fb: 3 },
      agents: [
        { id: 'o1', poolId: 'fa', model: '', role: 'orchestrator', delegatesTo: [], enabled: true },
        { id: 'o2', poolId: 'fb', model: '', role: 'orchestrator', delegatesTo: [], enabled: true },
      ],
    });
    assert.deepEqual(council.members(board.id), [], 'two orchestrators, but no council on a direct board');

    const a = store.createCard({ boardId: board.id, title: 'SLOW first', status: 'ready' });
    const b = store.createCard({ boardId: board.id, title: 'SLOW second', status: 'ready' });
    scheduler.start();
    const first = await waitFor(store, (e) => e.type === 'card.updated' && (e.payload as any).card.status === 'in_progress' && [a.id, b.id].includes(e.subject));
    const other = first.subject === a.id ? b.id : a.id;
    await new Promise((r) => setTimeout(r, 600)); // several scheduler ticks
    assert.equal(store.getCard(other)!.status, 'ready', 'the second waits while the first works');
    await waitFor(store, status(store, first.subject, 'done'));
    await waitFor(store, status(store, other, 'done'));
  } finally {
    await close();
  }
});

test('direct boards start independent cards together by default', async () => {
  const { store, scheduler, close } = await setup();
  try {
    const folder = mkdtempSync(join(tmpdir(), 'ih-direct-'));
    const board = store.createBoard({ name: 'Direct', repoPath: folder, defaultBranch: '', mode: 'direct' });
    store.updateSettings(board.id, { poolSlots: { fa: 3, fb: 3 } });
    const cards = ['SLOW one', 'SLOW two'].map((title) => store.createCard({ boardId: board.id, title, status: 'ready' }));
    scheduler.start();
    await waitFor(store, () => cards.every((c) => store.getCard(c.id)!.status === 'in_progress'));
    for (const c of cards) await waitFor(store, status(store, c.id, 'done'));
  } finally {
    await close();
  }
});

test('codexEnv: live web search by default, without overriding the user’s own CODEX_CONFIG', () => {
  assert.deepEqual(JSON.parse(codexEnv({}).CODEX_CONFIG!), { web_search: 'live' });
  assert.deepEqual(JSON.parse(codexEnv({ CODEX_CONFIG: '{"web_search":"disabled","model":"x"}' }).CODEX_CONFIG!), { web_search: 'disabled', model: 'x' });
  assert.equal(codexEnv({ CODEX_CONFIG: 'not json' }).CODEX_CONFIG, 'not json');
  // The worktree prompt is unchanged for normal boards.
  const card = { id: 'c_1', title: 'T', description: '', branch: 'ih/t' } as any;
  assert.match(buildPrompt(card, { name: 'B', mode: 'worktree' } as any, '/wt'), /a git worktree on branch ih\/t/);
});
