import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { builtinAddons, type AddonDef } from '../src/addons.ts';
import { builtinMcp, vinegarPluginsDir } from '../src/mcp-hub.ts';
import { mkdirSync, symlinkSync } from 'node:fs';
import { setup } from './harness.ts';

const here = (f: string) => fileURLToPath(new URL(`./${f}`, import.meta.url));

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

const def = (port: number, over: Partial<AddonDef> = {}): AddonDef => ({
  id: 'fakeworld',
  label: 'Fake World',
  description: 'A stand-in for the Roblox add-on.',
  servers: ['fake'],
  boardModes: ['direct'],
  service: {
    id: 'fake-sync',
    label: 'Fake sync',
    command: process.execPath,
    args: [here('fake-sync-service.mjs'), String(port)],
    port,
    healthPath: '/health',
    init: { marker: 'fakesync.json', command: process.execPath, args: (folder, name) => [here('fake-sync-init.mjs'), folder, name], creates: ['fakesync.json', 'src/'] },
  },
  conflicts: [{ file: 'default.project.json', text: 'This folder has a Rojo project.' }],
  ...over,
});

async function api(port: number, method: string, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json()) as any };
}

const folder = () => mkdtempSync(join(tmpdir(), 'ih-addon-'));
const health = async (port: number) => (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })).json() as Promise<{ cwd: string }>;
const down = (port: number) => fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) }).then(() => false, () => true);

async function world() {
  const ctx = await setup();
  const port = await freePort();
  ctx.addons.register(def(port));
  ctx.mcp.save({ id: 'fake', label: 'Fake Studio', description: 'd', transport: 'stdio', command: process.execPath, args: [here('fake-mcp-server.mjs')], hosting: 'shared', exclusive: true, toolKinds: {}, autoStart: false });
  const dir = folder();
  const direct = ctx.store.createBoard({ name: 'Game', repoPath: dir, defaultBranch: '', mode: 'direct' });
  return { ctx, port, dir, direct };
}

test('the Roblox add-on ships off, direct-only, and names the pieces it brings', () => {
  const [roblox] = builtinAddons();
  assert.equal(roblox!.id, 'roblox');
  assert.deepEqual(roblox!.servers, ['roblox-studio', 'rbxsync']);
  assert.deepEqual(roblox!.boardModes, ['direct']);
  assert.equal(roblox!.service!.port, 44755);
  assert.deepEqual(roblox!.service!.args, ['serve']);
  assert.equal(roblox!.service!.init!.args('/p', 'Game').join(' '), 'init --name Game --path /p', 'init takes the folder as a flag, so nothing runs in the wrong place');
});

test('Studio reads plugins from the Wine prefix, not from Vinegar\'s appdata folder: the plugin goes where Studio looks', () => {
  const home = mkdtempSync(join(tmpdir(), 'ih-home-'));
  const base = join(home, '.var/app/org.vinegarhq.Vinegar/data/vinegar');
  mkdirSync(join(base, 'appdata/Roblox/Plugins'), { recursive: true });
  assert.equal(vinegarPluginsDir(home), join(base, 'appdata/Roblox/Plugins'), 'only the fallback exists yet');
  mkdirSync(join(base, 'prefixes/studio/drive_c/users/Public/AppData/Local/Roblox/Plugins'), { recursive: true });
  mkdirSync(join(base, 'prefixes/studio/drive_c/users/future/AppData/Local/Roblox/Plugins'), { recursive: true });
  symlinkSync(join(base, 'appdata/Roblox/Plugins/RbxSync.rbxm'), join(base, 'prefixes/studio/drive_c/users/future/AppData/Local/Roblox/Plugins/RbxSync.rbxm'));
  assert.equal(vinegarPluginsDir(home), join(base, 'prefixes/studio/drive_c/users/future/AppData/Local/Roblox/Plugins'), 'the prefix wins, and the Public profile is not mistaken for the user');
  assert.equal(vinegarPluginsDir(mkdtempSync(join(tmpdir(), 'ih-empty-'))), null, 'no Vinegar, no folder');
  // The shipped entry points the server's installer at it.
  assert.equal(builtinMcp('/x', home).find((e) => e.id === 'roblox-studio')!.env!.MCP_PLUGINS_DIR, vinegarPluginsDir(home));
});

test('RbxSync\'s server marks no tools read-only itself, so the plainly reading ones are listed for Read only access', () => {
  const rbx = builtinMcp('/x').find((e) => e.id === 'rbxsync')!;
  assert.equal(rbx.toolKinds.git_status, 'read');
  assert.equal(rbx.toolKinds.console_history, 'read');
  assert.equal(rbx.toolKinds.run_code, undefined, 'running Luau can change anything: it is a change');
  assert.equal(rbx.toolKinds.git_commit, undefined);
  assert.equal(rbx.toolKinds.sync_to_studio, undefined);
});

test('off by default; a worktree board is told why it cannot have it; a missing helper is named', async () => {
  const { ctx, port, direct } = await world();
  try {
    const list = await api(ctx.cfg.port, 'GET', `/boards/${direct.id}/addons`);
    assert.equal(list.status, 200);
    const a = list.body.find((x: any) => x.id === 'fakeworld');
    assert.equal(a.enabled, false, 'switched off until someone switches it on');
    assert.equal(a.available, true);
    assert.deepEqual(a.willCreate, ['fakesync.json', 'src/'], 'the folder gets files, and the view says which');
    assert.deepEqual(a.components.map((c: any) => [c.id, c.state]), [['fake', 'stopped'], ['fake-sync', 'stopped']]);

    const wt = (await api(ctx.cfg.port, 'GET', `/boards/${ctx.board.id}/addons`)).body.find((x: any) => x.id === 'fakeworld');
    assert.equal(wt.available, false);
    assert.match(wt.reasons.join(' '), /direct boards.*worktree mode/s);
    const refused = await api(ctx.cfg.port, 'POST', `/boards/${ctx.board.id}/addons/fakeworld/enable`, {});
    assert.equal(refused.status, 409);
    assert.deepEqual(ctx.store.getSettings(ctx.board.id).addons, []);

    ctx.addons.register(def(port, { service: { ...def(port).service!, command: '/no/such/binary' } }));
    const missing = (await api(ctx.cfg.port, 'GET', `/boards/${direct.id}/addons`)).body.find((x: any) => x.id === 'fakeworld');
    assert.match(missing.reasons.join(' '), /is not installed on this machine/);
    assert.equal((await api(ctx.cfg.port, 'POST', `/boards/${direct.id}/addons/nope/enable`, {})).status, 404);
  } finally {
    await ctx.close();
  }
});

test('switching it on: sets up the folder, starts the sync there, switches the servers on; off stops it all and keeps the files', async () => {
  const { ctx, port, dir, direct } = await world();
  try {
    writeFileSync(join(dir, '.gitignore'), 'keepme\n');
    writeFileSync(join(dir, 'default.project.json'), '{}');
    const before = (await api(ctx.cfg.port, 'GET', `/boards/${direct.id}/addons`)).body[0];
    assert.match(before.warnings.join(' '), /Rojo/, 'another sync tool in the folder is a warning, not a block');

    const on = await api(ctx.cfg.port, 'POST', `/boards/${direct.id}/addons/fakeworld/enable`, {});
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.enabled, true);
    assert.equal(JSON.parse(readFileSync(join(dir, 'fakesync.json'), 'utf8')).name, 'Game');
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8').startsWith('keepme\n'), true, 'what was in the folder is kept');
    assert.equal(realpath(await health(port).then((h) => h.cwd)), realpath(dir), 'the sync runs in the board\'s own folder');

    const s = ctx.store.getSettings(direct.id);
    assert.deepEqual(s.addons, ['fakeworld']);
    assert.deepEqual(s.mcp.enabled, ['fake'], 'its MCP servers are on for the board');
    const view = (await api(ctx.cfg.port, 'GET', `/boards/${direct.id}/addons`)).body[0];
    assert.deepEqual(view.components.find((c: any) => c.id === 'fake-sync'), { id: 'fake-sync', label: 'Fake sync', kind: 'service', state: 'running', detail: `serving ${dir} on port ${port}` });
    assert.deepEqual(view.willCreate, [], 'nothing more to create once set up');
    assert.equal((await api(ctx.cfg.port, 'POST', `/boards/${direct.id}/addons/fakeworld/enable`, {})).body.enabled, true, 'switching on twice changes nothing');

    const off = await api(ctx.cfg.port, 'POST', `/boards/${direct.id}/addons/fakeworld/disable`);
    assert.equal(off.body.enabled, false);
    assert.equal(await down(port), true, 'the sync process is stopped');
    assert.deepEqual(ctx.store.getSettings(direct.id).addons, []);
    assert.deepEqual(ctx.store.getSettings(direct.id).mcp.enabled, []);
    assert.equal(existsSync(join(dir, 'fakesync.json')), true, 'files it made are left alone');
    assert.equal(ctx.mcp.view('fake')!.state, 'stopped', 'a server nobody has on any more is stopped');
  } finally {
    await ctx.close();
  }
});

const realpath = (p: string) => p.replace(/^\/private/, '').replace(/\/+$/, '');

test('one folder at a time: a second board is refused until it asks to take the sync over', async () => {
  const { ctx, port, dir, direct } = await world();
  try {
    const dir2 = folder();
    const second = ctx.store.createBoard({ name: 'Other game', repoPath: dir2, defaultBranch: '', mode: 'direct' });
    assert.equal((await api(ctx.cfg.port, 'POST', `/boards/${direct.id}/addons/fakeworld/enable`, {})).status, 200);

    const view = (await api(ctx.cfg.port, 'GET', `/boards/${second.id}/addons`)).body[0];
    assert.deepEqual(view.heldBy, { boardId: direct.id, boardName: 'Game' });
    const refused = await api(ctx.cfg.port, 'POST', `/boards/${second.id}/addons/fakeworld/enable`, {});
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /is serving "Game".*only one folder/);
    assert.equal(realpath((await health(port)).cwd), realpath(dir), 'the first board keeps it');
    assert.deepEqual(ctx.store.getSettings(second.id).addons, []);

    const moved = await api(ctx.cfg.port, 'POST', `/boards/${second.id}/addons/fakeworld/enable`, { move: true });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(realpath((await health(port)).cwd), realpath(dir2), 'the sync now runs in the second board\'s folder');
    assert.deepEqual(ctx.store.getSettings(direct.id).addons, [], 'and is off for the first');
    assert.deepEqual(ctx.store.getSettings(second.id).addons, ['fakeworld']);
  } finally {
    await ctx.close();
  }
});

test('a port something else already holds is reported, not mistaken for the sync', async () => {
  const { ctx, port, direct } = await world();
  const squatter = createServer((_req, res) => res.end('{"status":"ok"}')).listen(port, '127.0.0.1');
  await new Promise((r) => squatter.once('listening', r));
  try {
    const r = await api(ctx.cfg.port, 'POST', `/boards/${direct.id}/addons/fakeworld/enable`, {});
    assert.equal(r.status, 409);
    assert.match(r.body.error, new RegExp(`Port ${port} is already in use`));
    assert.deepEqual(ctx.store.getSettings(direct.id).addons, [], 'nothing was switched on');
  } finally {
    squatter.close();
    await ctx.close();
  }
});

test('add-ons are only switched with their own endpoints, and a daemon restart starts the sync again', async () => {
  const { ctx, port, dir, direct } = await world();
  try {
    const blunt = await api(ctx.cfg.port, 'PATCH', `/boards/${direct.id}/settings`, { addons: ['fakeworld'] });
    assert.equal(blunt.status, 400);
    assert.match(blunt.body.error, /addons\/:addon\/enable/);

    // The state a stopped daemon leaves: the add-on on in the settings, nothing running.
    writeFileSync(join(dir, 'fakesync.json'), '{}');
    ctx.store.updateSettings(direct.id, { addons: ['fakeworld'], mcp: { ...ctx.store.getSettings(direct.id).mcp, enabled: ['fake'] } });
    assert.equal(await down(port), true);
    await ctx.addons.reconcile();
    assert.equal(realpath((await health(port)).cwd), realpath(dir), 'started again in the board\'s folder');
    assert.equal(ctx.addons.serviceInfo('fake-sync')!.boardId, direct.id);

    // A board that goes away lets go of the process.
    await ctx.addons.forgetBoard(direct.id);
    assert.equal(await down(port), true);
  } finally {
    await ctx.close();
  }
});
