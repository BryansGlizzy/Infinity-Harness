// Saved machines and the SSH forwards to them. The forward itself is replaced by a local TCP proxy standing in for
// `ssh -L` (a real sshd is checked by hand; see the master plan), so the daemon, the client and the reconnect logic
// are real and the transport is controlled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup } from '../../../apps/daemon/test/harness.ts';
import { fakeSsh } from './fake-ssh.ts';
import { Fleet, MachineCatalog, MachineConnection, classifySshFailure, parseScoped, remotePath, scoped, tunnelArgs, type MachineProfile, type SpawnTunnel } from '../src/node/index.ts';

const profile = (over: Partial<MachineProfile> = {}): MachineProfile => ({ id: 'm_1', label: 'workbox', target: 'me@workbox', remotePort: 7420, enabled: true, ...over });

test('the catalog: add, find, rename, disable, remove; private file; bad input refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ih-cat-'));
  const file = join(dir, 'sub', 'machines.json');
  const cat = new MachineCatalog(file);
  assert.deepEqual(cat.list(), [], 'no file yet');
  const a = cat.add({ label: 'workbox', target: 'me@workbox.lan', remoteRoot: '~/infinity-harness' });
  assert.match(a.id, /^m_[0-9a-f]{10}$/);
  assert.equal(a.remotePort, 7420);
  assert.equal(a.enabled, true);
  assert.equal(statSync(file).mode & 0o777, 0o600, 'readable by this user only');
  const b = cat.add({ label: 'Lab', target: 'lab', sshPort: 2222, remotePort: 7430 });
  assert.deepEqual(cat.list().map((m) => m.label), ['workbox', 'Lab']);
  assert.equal(cat.find('workbox')?.id, a.id);
  assert.equal(cat.find(b.id)?.label, 'Lab');
  assert.equal(new MachineCatalog(file).list().length, 2, 'persisted');

  assert.throws(() => cat.add({ label: 'WORKBOX', target: 'x' }), /already a machine called/);
  assert.throws(() => cat.add({ label: 'local', target: 'x' }), /this machine/);
  assert.throws(() => cat.add({ label: 'evil', target: '-oProxyCommand=touch /tmp/pwned' }), /SSH target looks wrong/);
  assert.throws(() => cat.add({ label: 'evil', target: 'host; rm -rf ~' }), /SSH target looks wrong/);
  assert.throws(() => cat.add({ label: 'evil', target: 'h', remoteRoot: '/a/../../etc' }), /remote folder looks wrong/);
  assert.throws(() => cat.add({ label: 'evil', target: 'h', remoteRoot: '/a; reboot' }), /remote folder looks wrong/);
  assert.throws(() => cat.add({ label: 'p', target: 'h', remotePort: 70000 }), /port number/);
  assert.throws(() => cat.add({ label: '', target: 'h' }), /label/);

  assert.equal(cat.rename('Lab', 'Lab 2').label, 'Lab 2');
  assert.throws(() => cat.rename('Lab 2', 'workbox'), /already a machine/);
  assert.equal(cat.setEnabled('workbox', false).enabled, false);
  assert.equal(cat.remove('Lab 2').id, b.id);
  assert.deepEqual(cat.list().map((m) => m.label), ['workbox']);
  assert.throws(() => cat.remove('nope'), /no saved machine/);
});

test('ssh arguments never prompt and cannot be steered by the target; failures are told apart', () => {
  const args = tunnelArgs(profile({ sshPort: 2222 }), 40001);
  assert.equal(args.at(-1), 'me@workbox');
  assert.equal(args.at(-2), '--', 'the target comes after --, so it can never be read as an option');
  assert.ok(args.includes('BatchMode=yes') && args.includes('ExitOnForwardFailure=yes'));
  assert.equal(args[args.indexOf('-L') + 1], '127.0.0.1:40001:127.0.0.1:7420');
  assert.equal(args[args.indexOf('-p') + 1], '2222');
  assert.ok(!tunnelArgs(profile(), 1).includes('-p'));

  assert.equal(classifySshFailure('me@workbox: Permission denied (publickey).'), 'auth');
  assert.equal(classifySshFailure('Host key verification failed.'), 'hostkey');
  assert.equal(classifySshFailure('@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@'), 'hostkey');
  assert.equal(classifySshFailure('ssh: connect to host workbox port 22: Connection timed out'), null);
  assert.equal(classifySshFailure('Could not resolve hostname workbox'), null);

  assert.equal(remotePath('~/infinity harness'), `"$HOME"/'infinity harness'`);
  assert.equal(remotePath("/srv/it's"), `'/srv/it'\\''s'`);
});

const fast = { readyTimeoutMs: 1500, checkIntervalMs: 60, checkTimeoutMs: 150, backoff: { minMs: 20, maxMs: 80, healthyMs: 100_000 } };
const until = async (cond: () => boolean, ms = 4000) => {
  for (let t = 0; !cond(); t += 10) {
    if (t > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('a machine comes online through the forward, and comes back on a new port after the forward drops', async () => {
  const t = await setup();
  const ssh = fakeSsh(t.cfg.port);
  const conn = new MachineConnection(profile(), { spawn: ssh.spawn, ...fast });
  const states: string[] = [];
  conn.onChange((c) => states.push(c.state));
  try {
    conn.start();
    await conn.ready();
    assert.equal(conn.state, 'online');
    assert.match(conn.baseUrl!, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.deepEqual((await conn.api.boards()).map((b) => b.id), [t.board.id], 'the daemon on the far side of the forward answers');
    const firstUrl = conn.baseUrl;

    ssh.made[0]!.exit(255, 'client_loop: send disconnect: Broken pipe');
    await until(() => conn.state === 'reconnecting');
    assert.match(conn.error ?? '', /Broken pipe/);
    await until(() => conn.state === 'online');
    assert.notEqual(conn.baseUrl, firstUrl, 'a fresh forward');
    assert.equal((await conn.api.boards()).length, 1);
    assert.deepEqual([...new Set(states)], ['connecting', 'online', 'reconnecting']);
  } finally {
    conn.stop();
    await until(() => conn.state === 'stopped');
    await t.close();
  }
});

test('a forward that stays open but stops answering is noticed and rebuilt', async () => {
  const t = await setup();
  const ssh = fakeSsh(t.cfg.port);
  const conn = new MachineConnection(profile(), { spawn: ssh.spawn, ...fast });
  try {
    conn.start();
    await conn.ready();
    ssh.made[0]!.blackhole = true;
    for (const s of ssh.made[0]!.sockets) s.destroy();
    await until(() => conn.state === 'reconnecting');
    assert.match(conn.error ?? '', /stopped answering/);
    await until(() => conn.state === 'online');
    assert.equal(ssh.made.length, 2);
  } finally {
    conn.stop();
    await t.close();
  }
});

test('a login failure needs a person: no retry loop, and retry() tries once more', async () => {
  const t = await setup();
  let denied = true;
  const ok = fakeSsh(t.cfg.port);
  let spawned = 0;
  const spawn: SpawnTunnel = (a) => {
    spawned++;
    if (!denied) return ok.spawn(a);
    let fn: ((c: number | null, s: string) => void) | null = null;
    setTimeout(() => fn?.(255, 'me@workbox: Permission denied (publickey).\n'), 10);
    return { kill: () => {}, onExit: (f) => (fn = f) };
  };
  const conn = new MachineConnection(profile(), { spawn, ...fast });
  try {
    conn.start();
    await assert.rejects(conn.ready(), /Permission denied/);
    assert.equal(conn.state, 'attention');
    assert.equal(conn.attention, 'auth');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(spawned, 1, 'not retried on its own: BatchMode never prompts, so retrying cannot help');

    denied = false;
    conn.retry();
    await conn.ready();
    assert.equal(conn.state, 'online');
    assert.equal(conn.attention, null);
  } finally {
    conn.stop();
    await t.close();
  }
});

test('a daemon that is not running there is reported in words, and retried quietly', async () => {
  const dead = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => dead.once('listening', r));
  const deadPort = (dead.address() as { port: number }).port;
  await new Promise((r) => dead.close(r));
  const ssh = fakeSsh(deadPort);
  const conn = new MachineConnection(profile(), { spawn: ssh.spawn, ...fast, readyTimeoutMs: 400 });
  try {
    conn.start();
    await until(() => conn.state === 'reconnecting');
    assert.match(conn.error ?? '', /no Infinity Harness daemon answers on its port 7420\. Start it there/);
    await until(() => ssh.made.length >= 2, 3000);
  } finally {
    conn.stop();
  }
});

test('a daemon that requires its token: the token is fetched over SSH and used; without a way to fetch it, attention', async () => {
  const t = await setup({ auth: { token: 'remote-secret', requireToken: true, loopbackBound: true, allowedHosts: [] } });
  const ssh = fakeSsh(t.cfg.port);
  const asked: string[] = [];
  const conn = new MachineConnection(profile({ remoteRoot: '~/infinity-harness' }), {
    spawn: ssh.spawn,
    ...fast,
    readToken: async (p) => (asked.push(p.label), 'remote-secret'),
  });
  const bare = new MachineConnection(profile({ label: 'bare' }), { spawn: ssh.spawn, ...fast, readToken: async () => { throw new Error('set the remote folder'); } });
  try {
    conn.start();
    await conn.ready();
    assert.deepEqual(asked, ['workbox']);
    assert.equal((await conn.api.boards()).length, 1, 'requests carry the token');

    bare.start();
    await assert.rejects(bare.ready(), /set the remote folder/);
    assert.equal(bare.attention, 'token');
  } finally {
    conn.stop();
    bare.stop();
    await t.close();
  }
});

test('the fleet: this machine first, saved machines after, scoped ids', async () => {
  const t = await setup();
  const ssh = fakeSsh(t.cfg.port);
  const cat = new MachineCatalog(join(mkdtempSync(join(tmpdir(), 'ih-fleet-')), 'machines.json'));
  cat.add({ label: 'workbox', target: 'me@workbox' });
  cat.add({ label: 'parked', target: 'old' });
  cat.setEnabled('parked', false);
  const fleet = new Fleet({ catalog: cat, localUrl: `http://127.0.0.1:${t.cfg.port}`, connection: { spawn: ssh.spawn, ...fast } });
  try {
    fleet.start();
    await fleet.connection('workbox')!.ready();
    const eps = fleet.endpoints();
    assert.deepEqual(eps.map((e) => [e.label, e.state]), [['local', 'online'], ['workbox', 'online'], ['parked', 'stopped']]);
    assert.equal(eps[2]!.error, 'disabled');
    assert.equal((await eps[0]!.api!.boards())[0]!.id, t.board.id);
    assert.equal((await eps[1]!.api!.boards())[0]!.id, t.board.id, 'the same daemon here, reached two ways');
    assert.notEqual(eps[0]!.baseUrl, eps[1]!.baseUrl);

    assert.deepEqual(parseScoped('workbox:c_9'), { machine: 'workbox', id: 'c_9' });
    assert.deepEqual(parseScoped('c_9'), { machine: 'local', id: 'c_9' });
    assert.equal(scoped('local', 'c_9'), 'c_9');
    assert.equal(scoped('workbox', 'c_9'), 'workbox:c_9');

    cat.remove('workbox');
    fleet.start();
    await until(() => fleet.connection('workbox') === undefined);
    assert.deepEqual(fleet.endpoints().map((e) => e.label), ['local', 'parked']);
  } finally {
    fleet.stop();
    await t.close();
  }
});
