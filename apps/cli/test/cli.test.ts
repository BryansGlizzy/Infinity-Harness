// The ih CLI, run in-process against a real daemon with fake agents. Saved machines go through a stand-in for ssh -L.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup } from '../../daemon/test/harness.ts';
import { fakeSsh } from '../../../packages/client/test/fake-ssh.ts';
import { run } from '../src/cli.ts';
import type { Io } from '../src/io.ts';

type Env = Awaited<ReturnType<typeof setup>>;

function harness(t: Env, extra: Partial<Io> = {}) {
  const config = mkdtempSync(join(tmpdir(), 'ih-ih-'));
  const ih = async (args: string[], over: Partial<Io> = {}) => {
    let out = '';
    let err = '';
    const io: Io = { out: (s) => (out += s), err: (s) => (err += s), env: { IH_URL: `http://127.0.0.1:${t.cfg.port}`, XDG_CONFIG_HOME: config }, cwd: '/nowhere', tty: false, ...extra, ...over };
    const code = await run(args, io);
    return { code, out, err, json: () => JSON.parse(out) as any };
  };
  return { ih, config };
}

test('help, and mistakes are exit 2 with a message (JSON when not at a terminal)', async () => {
  const t = await setup();
  const { ih } = harness(t);
  try {
    const help = await ih(['help']);
    assert.equal(help.code, 0);
    assert.match(help.out, /Usage: ih/);
    for (const c of ['plan', 'needs', 'approve', 'machine', 'terminal', 'watch']) assert.match(help.out, new RegExp(`\\n  ${c}\\s`), c);
    assert.equal((await ih([])).code, 0);
    assert.match((await ih(['cards', '--help'])).out, /ih cards \[--board B\]/);

    const unknown = await ih(['frobnicate']);
    assert.equal(unknown.code, 2);
    assert.deepEqual(JSON.parse(unknown.err), { error: 'unknown command "frobnicate". `ih help` lists them.' });
    assert.equal((await ih(['cards', '--nope'])).code, 2, 'unknown option');
    assert.equal((await ih(['card'])).code, 2, 'missing argument');
    assert.equal((await ih(['move', 'x', 'sideways'])).code, 2);
    const human = await ih(['frobnicate'], { tty: true });
    assert.match(human.err, /^ih: unknown command/);

    const down = await ih(['boards'], { env: { IH_URL: 'http://127.0.0.1:9', XDG_CONFIG_HOME: '/tmp' } });
    assert.equal(down.code, 1);
    assert.match(JSON.parse(down.err).error, /no Infinity Harness daemon at http:\/\/127\.0\.0\.1:9/);
  } finally {
    await t.close();
  }
});

test('boards, cards and the card commands, in JSON and for a person', async () => {
  const t = await setup();
  const { ih } = harness(t);
  try {
    const status = (await ih(['status'])).json();
    assert.equal(status.auth, 'local');
    assert.equal(status.boards[0].id, t.board.id);
    assert.deepEqual(status.pools.map((p: any) => p.id).sort(), ['fa', 'fb']);
    assert.equal((await ih(['boards'])).json()[0].name, 'Demo');

    const added = (await ih(['add', 'Write', 'the', 'notes', '--description', 'in notes.md', '--status', 'backlog'])).json();
    assert.equal(added.title, 'Write the notes');
    assert.equal(added.status, 'backlog');
    assert.equal((await ih(['cards'])).json().length, 1, 'the only board is chosen without --board');
    assert.equal((await ih(['cards', '--status', 'ready'])).json().length, 0);
    assert.equal((await ih(['cards', '--status', 'weird'])).code, 2);

    const prefix = added.id.slice(0, 6);
    const card = (await ih(['card', prefix])).json();
    assert.equal(card.card.id, added.id);
    const moved = (await ih(['move', prefix, 'blocked'])).json();
    assert.equal(moved.status, 'blocked');
    const sent = (await ih(['message', prefix, 'please', 'hurry', '--urgent'])).json();
    assert.equal(sent.urgent, true);
    assert.ok(t.store.boardMessages(t.board.id).some((m) => m.body === 'please hurry' && m.toCard === added.id));
    assert.equal((await ih(['card', 'c_nope'])).code, 2);

    const table = await ih(['cards'], { tty: true });
    assert.match(table.out, /^ID\s+STATUS\s+ROLE\s+AGENT\s+TITLE\n/);
    assert.match(table.out, /blocked\s+worker\s+-\s+Write the notes/);
    assert.match((await ih(['card', prefix], { tty: true })).out, /Write the notes\nstatus blocked/);

    // Board resolution: by name, by folder, and ambiguity.
    assert.equal((await ih(['cards', '--board', 'demo'])).json().length, 1);
    assert.equal((await ih(['cards', '--board', 'nope'])).code, 2);
    const other = t.store.createBoard({ name: 'Other', repoPath: '/srv/other', defaultBranch: 'main' });
    const ambiguous = await ih(['cards']);
    assert.equal(ambiguous.code, 2);
    assert.match(JSON.parse(ambiguous.err).error, /which board\?/);
    assert.equal((await ih(['cards'], { cwd: '/srv/other/src' })).json().length, 0, 'the board holding the current folder');
    assert.equal((await ih(['cards', '--board', t.board.id])).json().length, 1);
    void other;
  } finally {
    await t.close();
  }
});

test('needs, approve and deny', async () => {
  const t = await setup();
  const { ih } = harness(t);
  try {
    const card = t.store.createCard({ boardId: t.board.id, title: 'Needs a hand' });
    t.store.updateCard(card.id, { status: 'blocked' });
    const skill = t.store.createApproval({ boardId: t.board.id, cardId: card.id, kind: 'install_skill', summary: 'Install the "lint" skill', payload: { skill: { name: 'lint', description: 'Run the linter', body: 'Run `pnpm lint`.' } }, requestedBy: `card:${card.id}` });
    const grant = t.store.createApproval({ boardId: t.board.id, cardId: card.id, kind: 'grant', summary: 'Give the card a browser', payload: { grant: 'browser' }, requestedBy: `card:${card.id}` });
    const ask = t.store.createApproval({ boardId: t.board.id, cardId: card.id, kind: 'escalation', summary: 'Which database?', payload: {}, requestedBy: `card:${card.id}` });

    const needs = (await ih(['needs'])).json() as { kind: string; id: string; title: string }[];
    assert.deepEqual(needs.map((n) => n.kind).sort(), ['approval', 'approval', 'approval'], 'the blocked card is not listed twice: its question is');
    assert.ok(needs.some((n) => n.title === 'Which database?'));
    assert.equal(((await ih(['approvals'])).json() as unknown[]).length, 3);

    const noNote = await ih(['approve', ask.id.slice(0, 8)]);
    assert.equal(noNote.code, 2);
    assert.match(JSON.parse(noNote.err).error, /give your answer with --note/);
    const answered = (await ih(['approve', ask.id, '--note', 'Postgres'])).json();
    assert.equal(answered.status, 'approved');
    assert.equal(answered.note, 'Postgres');

    const approved = (await ih(['approve', skill.id.slice(0, 10)])).json();
    assert.equal(approved.status, 'approved');
    assert.equal(t.store.getSettings(t.board.id).skills.some((s) => s.name === 'lint'), true, 'approving applied it');
    const denied = (await ih(['deny', grant.id, '--note', 'not for this'])).json();
    assert.equal(denied.status, 'denied');
    assert.equal((await ih(['approve', 'ap_zzzz'])).code, 2);
    assert.equal(((await ih(['approvals'])).json() as unknown[]).length, 0);
    assert.deepEqual((await ih(['needs'])).json(), [], 'the question was answered, so the card runs again and nothing waits');
    const stuck = t.store.createCard({ boardId: t.board.id, title: 'Stuck' });
    t.store.updateCard(stuck.id, { status: 'blocked' });
    assert.deepEqual(((await ih(['needs'])).json() as { kind: string }[]).map((n) => n.kind), ['blocked']);
    assert.match((await ih(['needs'], { tty: true })).out, /blocked\s+c_\w+\s+Blocked: Stuck/);
  } finally {
    await t.close();
  }
});

test('pools show whether the model answers; pool test and restore; messages list and clear', async () => {
  const t = await setup();
  const { ih } = harness(t);
  try {
    // Pools: a MODEL column, "OUT of rotation" once a pool was taken out.
    t.health.eject('fa', 'no answer within 8 s');
    const pools = (await ih(['pools'])).json() as { id: string; health?: { ejected: { reason: string } | null } }[];
    assert.match(pools.find((p) => p.id === 'fa')!.health!.ejected!.reason, /no answer/);
    const table = (await ih(['pools'], { tty: true })).out;
    assert.match(table, /MODEL/);
    assert.match(table, /fa\s+open\s+OUT of rotation/);

    const tested = await ih(['pool', 'test', 'fa'], { tty: true });
    assert.match(tested.out, /fa: online/);
    assert.match(tested.out, /out of rotation since .*: no answer within 8 s/);
    assert.match(tested.out, /ih pool restore fa/);
    assert.ok(t.health.ejection('fa'), 'testing does not put it back');
    assert.match((await ih(['pool', 'restore', 'fa'], { tty: true })).out, /fa is back in rotation/);
    assert.equal(t.health.ejection('fa'), null);
    assert.equal((await ih(['pool', 'frob', 'fa'])).code, 2);
    assert.equal((await ih(['pool', 'test'])).code, 2);
    assert.equal((await ih(['pool', 'test', 'nope'])).code, 1, 'an unknown pool is the daemon refusing');

    // Messages for the user.
    const card = t.store.createCard({ boardId: t.board.id, title: 'Chatty' });
    const say = (body: string) => t.store.postMessage({ boardId: t.board.id, fromActor: `card:${card.id}`, toCard: null, body, urgent: false });
    const [a, b] = [say('first question'), say('second question')];
    const listed = (await ih(['messages'])).json() as { id: string }[];
    assert.deepEqual(listed.map((m) => m.id).sort(), [a.id, b.id].sort());
    assert.match((await ih(['messages'], { tty: true })).out, /first question/);
    assert.deepEqual((await ih(['messages', 'clear', a.id])).json().dismissed, [a.id]);
    assert.deepEqual(((await ih(['messages'])).json() as { id: string }[]).map((m) => m.id), [b.id]);
    assert.deepEqual(((await ih(['needs'])).json() as { kind: string }[]).map((n) => n.kind), ['message'], 'needs lists what is left');
    assert.equal((await ih(['messages', 'clear'])).json().dismissed.length, 1);
    assert.deepEqual((await ih(['messages'])).json(), []);
    assert.match((await ih(['messages'], { tty: true })).out, /No messages for you/);
    assert.equal((await ih(['messages', 'frob'])).code, 2);
  } finally {
    await t.close();
  }
});

test('watch follows the event stream and stops after N events', async () => {
  const t = await setup();
  const { ih } = harness(t);
  try {
    const watching = ih(['watch', '--count', '2']);
    await new Promise((r) => setTimeout(r, 300));
    const a = t.store.createCard({ boardId: t.board.id, title: 'first' });
    t.store.createCard({ boardId: t.board.id, title: 'second' });
    const done = await watching;
    assert.equal(done.code, 0);
    const lines = done.out.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.ok(lines.some((e) => e.type === 'card.created' && e.subject === a.id));
  } finally {
    await t.close();
  }
});

test('saved machines: add (checked over ssh), list, use with --machine and machine:id, status, forward, remove', async () => {
  const t = await setup();
  const ssh = fakeSsh(t.cfg.port);
  const connection = { spawn: ssh.spawn, readyTimeoutMs: 1500, checkIntervalMs: 100, backoff: { minMs: 20, maxMs: 50, healthyMs: 100_000 } };
  // This machine's daemon is "elsewhere" for these commands: IH_URL points nowhere, so only the forward works.
  const { ih, config } = harness(t, { connection, env: { IH_URL: 'http://127.0.0.1:9', XDG_CONFIG_HOME: '' } });
  const env = { IH_URL: 'http://127.0.0.1:9', XDG_CONFIG_HOME: config };
  try {
    assert.match((await ih(['machine', 'list'], { env, tty: true })).out, /No saved machines/);
    const added = await ih(['machine', 'add', 'me@workbox', '--label', 'workbox', '--root', '~/infinity-harness'], { env });
    assert.equal(added.code, 0, added.err);
    assert.equal(ssh.made.length, 1, 'it connected once to check');
    assert.equal(added.json().label, 'workbox');
    assert.equal((await ih(['machine', 'list'], { env })).json().length, 1);

    const bad = await ih(['machine', 'add', '-oProxyCommand=evil', '--label', 'x'], { env });
    assert.equal(bad.code, 2);
    assert.equal((await ih(['machine', 'add', 'me@workbox', '--label', 'WorkBox'], { env })).code, 1, 'duplicate label');

    const viaFlag = await ih(['boards', '--machine', 'workbox'], { env });
    assert.equal(viaFlag.json()[0].id, t.board.id, 'the daemon behind the forward');
    const card = t.store.createCard({ boardId: t.board.id, title: 'Over there' });
    const viaScope = await ih(['card', `workbox:${card.id.slice(0, 6)}`], { env });
    assert.equal(viaScope.json().card.id, card.id, 'machine:id picks the machine');
    assert.equal((await ih(['boards', '--machine', 'ghost'], { env })).code, 2);

    const st = await ih(['machine', 'status'], { env });
    assert.deepEqual(st.json().map((r: any) => [r.machine, r.ok, r.state, r.boards]), [['workbox', true, 'online', 1]]);

    const abort = new AbortController();
    const forwarding = ih(['machine', 'forward', 'workbox', '--port', '47123'], { env, signal: abort.signal });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(((await (await fetch('http://127.0.0.1:47123/api/boards')).json()) as unknown[]).length, 1, 'the web UI or VS Code can use that address');
    abort.abort();
    assert.equal((await forwarding).code, 0);

    assert.equal((await ih(['machine', 'rename', 'workbox', 'lab'], { env })).json().label, 'lab');
    assert.equal((await ih(['machine', 'disable', 'lab'], { env })).json().enabled, false);
    assert.equal((await ih(['boards', '--machine', 'lab'], { env })).code, 2, 'disabled');
    assert.equal((await ih(['machine', 'remove', 'lab'], { env })).code, 0);
    assert.deepEqual((await ih(['machine', 'list'], { env })).json(), []);

    // Nothing reachable: not saved.
    const failing = { ...connection, spawn: (() => { let f: any; setTimeout(() => f?.(255, 'x: Permission denied (publickey).'), 5); return { kill() {}, onExit: (fn: any) => (f = fn) }; }) as any };
    const refused = await ih(['machine', 'add', 'me@nowhere', '--label', 'nowhere'], { env, connection: failing });
    assert.equal(refused.code, 1);
    assert.match(JSON.parse(refused.err).error, /not saved: cannot reach "nowhere" \(.*Permission denied/);
    assert.deepEqual((await ih(['machine', 'list'], { env })).json(), [], 'a machine that cannot be reached is not kept');
    assert.equal((await ih(['machine', 'add', 'me@nowhere', '--label', 'nowhere', '--no-check'], { env, connection: failing })).code, 0, '--no-check keeps it');
  } finally {
    await t.close();
  }
});

test('the skill file: valid, honest about the commands it names, and installable without clobbering', async () => {
  const { readFileSync, existsSync, writeFileSync } = await import('node:fs');
  const { ALL } = await import('../src/cli.ts');
  const { BUNDLED } = await import('../src/skill.ts');
  const text = readFileSync(BUNDLED, 'utf8');

  // Frontmatter the tools that load skills require.
  const front = /^---\nname: (.+)\ndescription: "(.+)"\n---\n/.exec(text);
  assert.ok(front, 'name and description frontmatter');
  assert.equal(front[1], 'infinity-harness');
  assert.match(front[2]!, /Use only when the user mentions Infinity Harness/, 'gated, like herdr\'s');
  assert.match(text, /If you have the `board` MCP tools/, 'it sends card agents elsewhere');

  // Every `ih <command>` the skill names exists, and every flag it names belongs to a command or is global.
  const names = new Set(ALL.map((c) => c.name));
  const spans = [...text.matchAll(/`ih ([a-z]+)([^`]*)`/g)];
  assert.ok(spans.length > 20);
  for (const [, command, rest] of spans) {
    assert.ok(names.has(command!), `the skill names \`ih ${command}\`, which does not exist`);
    for (const flag of rest!.matchAll(/--([a-z-]+)/g)) {
      const known = ALL.find((c) => c.name === command)?.options ?? {};
      assert.ok(flag[1]! in known || ['json', 'machine', 'board', 'url', 'token', 'help'].includes(flag[1]!), `\`ih ${command}\` has no --${flag[1]}`);
    }
  }
  for (const flag of ['--urgent', '--force', '--count', '--status', '--machine', '--board', '--json']) assert.ok(text.includes(flag), flag);

  const t = await setup();
  try {
    const { ih } = harness(t);
    const home = mkdtempSync(join(tmpdir(), 'ih-skill-'));
    const env = { HOME: home, XDG_CONFIG_HOME: home };
    const shown = await ih(['skill', 'show'], { env });
    assert.equal(shown.out, text);
    assert.equal((await ih(['skill', 'path'], { env })).json().path, BUNDLED);

    const where = join(home, '.claude', 'skills', 'infinity-harness', 'SKILL.md');
    assert.equal((await ih(['skill', 'status'], { env })).json().state, 'not installed');
    const installed = await ih(['skill', 'install'], { env });
    assert.equal(installed.code, 0, installed.err);
    assert.equal(readFileSync(where, 'utf8'), text);
    assert.equal((await ih(['skill', 'status'], { env })).json().state, 'up to date');

    writeFileSync(where, 'my own edits\n');
    assert.equal((await ih(['skill', 'status'], { env })).json().state, 'differs from this checkout');
    const refused = await ih(['skill', 'install'], { env });
    assert.equal(refused.code, 2);
    assert.match(JSON.parse(refused.err).error, /already exists and differs\. Use --force/);
    assert.equal(readFileSync(where, 'utf8'), 'my own edits\n', 'untouched');
    assert.equal((await ih(['skill', 'install', '--force'], { env })).json().replaced, true);
    assert.equal(readFileSync(where, 'utf8'), text);

    assert.equal((await ih(['skill', 'install', '--target', 'agents'], { env })).code, 0);
    assert.ok(existsSync(join(home, '.agents', 'skills', 'infinity-harness', 'SKILL.md')));
    const custom = join(home, 'elsewhere');
    assert.equal((await ih(['skill', 'install', '--dir', custom], { env })).code, 0);
    assert.ok(existsSync(join(custom, 'infinity-harness', 'SKILL.md')));
    assert.equal((await ih(['skill', 'install', '--target', 'nope'], { env })).code, 2);
  } finally {
    await t.close();
  }
});

test('weight: shows and sets the routing weight per agent, rejects nonsense, and the daemon applies it', async () => {
  const t = await setup();
  const { ih } = harness(t);
  try {
    const shown = (await ih(['weight'])).json();
    assert.ok(Object.keys(shown).length > 0, 'workers are listed');
    assert.ok(Object.values(shown).every((v) => v === 1));
    const agent = Object.keys(shown)[0]!;
    assert.deepEqual((await ih(['weight', agent, '2.5'])).json(), { [agent]: 2.5 });
    assert.equal(t.store.getSettings(t.board.id).agentWeights[agent], 2.5);
    assert.equal((await ih(['weight', agent])).json()[agent], 2.5);
    assert.match((await ih(['weight'], { tty: true })).out, /AGENT\s+MODEL\s+WEIGHT/);
    assert.equal((await ih(['weight', agent, '11'])).code, 2);
    assert.equal((await ih(['weight', agent, 'lots'])).code, 2);
    assert.equal((await ih(['weight', 'nobody', '2'])).code, 2);
    const res = await fetch(`http://127.0.0.1:${t.cfg.port}/api/boards/${t.board.id}/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentWeights: { [agent]: -1 } }) });
    assert.equal(res.status, 400);
    assert.deepEqual((await ih(['weight', agent, 'reset'])).json(), {});
    assert.equal(t.store.getSettings(t.board.id).agentWeights[agent], undefined);
  } finally {
    await t.close();
  }
});

test('ih mcp: list the library, switch a server on for the board, set an agent\'s access, start and stop it', async () => {
  const t = await setup();
  const { ih } = harness(t);
  try {
    const fake = fileURLToPath(new URL('../../daemon/test/fake-mcp-server.mjs', import.meta.url));
    t.mcp.save({ id: 'fake', label: 'Fake Studio', description: 'd', transport: 'stdio', command: process.execPath, args: [fake], hosting: 'shared', exclusive: false, toolKinds: {}, autoStart: false });
    const list = (await ih(['mcp'])).json();
    assert.deepEqual(list.servers.map((s: any) => s.entry.id).sort(), ['fake', 'rbxsync', 'roblox-studio']);
    assert.deepEqual(list.enabled, []);
    assert.match((await ih(['mcp'], { tty: true })).out, /fake\s+off\s+stopped/);

    const on = await ih(['mcp', 'on', 'fake']);
    assert.equal(on.code, 0);
    assert.deepEqual(on.json().enabled, ['fake']);
    assert.equal((await ih(['mcp'])).json().servers.find((s: any) => s.entry.id === 'fake').state, 'running', 'switching it on starts it');
    assert.equal((await ih(['mcp', 'access', 'fake', 'fa', 'read'])).json().access.fake.agents.fa, 'read');
    assert.equal((await ih(['mcp', 'access', 'fake', 'default', 'off'])).json().access.fake.default, 'off');
    assert.equal((await ih(['mcp', 'access', 'fake', 'fa', 'sideways'])).code, 2);
    assert.equal((await ih(['mcp', 'on', 'nope'])).code, 2, 'only servers in the library');
    assert.equal((await ih(['mcp', 'stop', 'fake'])).json().state, 'stopped');
    assert.deepEqual((await ih(['mcp', 'off', 'fake'])).json().enabled, []);
  } finally {
    await t.close();
  }
});

test('ih addon: list, switch on for a direct board (the sync starts in its folder), refuse a worktree board, switch off', async () => {
  const t = await setup();
  const { ih } = harness(t);
  try {
    const { createServer } = await import('node:http');
    const port = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    const dir = mkdtempSync(join(tmpdir(), 'ih-cli-addon-'));
    const here = (f: string) => fileURLToPath(new URL(`../../daemon/test/${f}`, import.meta.url));
    t.addons.register({
      id: 'fakeworld', label: 'Fake World', description: 'd', servers: [], boardModes: ['direct'],
      service: { id: 'fake-sync', label: 'Fake sync', command: process.execPath, args: [here('fake-sync-service.mjs'), String(port)], port, healthPath: '/health' },
    });
    const board = t.store.createBoard({ name: 'Game', repoPath: dir, defaultBranch: '', mode: 'direct' });

    const list = await ih(['addon', '--board', board.id]);
    assert.equal(list.json()[0].enabled, false, 'off by default');
    const on = await ih(['addon', 'on', 'fakeworld', '--board', board.id]);
    assert.equal(on.code, 0, on.err);
    assert.equal(on.json().components.find((c: any) => c.id === 'fake-sync').state, 'running');
    assert.match((await ih(['addon', '--board', board.id], { tty: true })).out, /fakeworld\s+on/);
    const wt = await ih(['addon', 'on', 'fakeworld', '--board', t.board.id]);
    assert.equal(wt.code, 1, 'a worktree board is refused');
    assert.match(wt.err, /direct boards/);
    assert.equal((await ih(['addon', 'sideways'])).code, 2);
    assert.equal((await ih(['addon', 'on'])).code, 2);
    assert.equal((await ih(['addon', 'off', 'fakeworld', '--board', board.id])).json().enabled, false);
    assert.equal(t.addons.serviceInfo('fake-sync'), null, 'switching off stops the process');
  } finally {
    await t.close();
  }
});

test('ih report: per-card effort, flags what looks wasteful, and filters to one card', async () => {
  const t = await setup();
  const { ih } = harness(t);
  try {
    const card = t.store.createCard({ boardId: t.board.id, title: 'Chatty worker' });
    for (let i = 0; i < 9; i++) t.store.append('session.event', card.id, { sessionId: 's', event: { type: 'tool_call', id: `t${i}`, title: 'ps aux | grep roblox' } }, 'x');
    const all = (await ih(['report'])).json();
    const row = all.cards.find((c: any) => c.id === card.id);
    assert.equal(row.steps, 9);
    assert.match(row.flags.join(' '), /9 shell commands that look like diagnosing/);
    assert.equal(all.totals.diagnosticShell, 9);
    assert.equal((await ih(['report', 'chatty'])).json().cards.length, 1, 'a word from the title picks the card');
    const human = await ih(['report'], { tty: true });
    assert.match(human.out, /Chatty worker/);
    assert.match(human.out, /diagnosing the machine/);
  } finally {
    await t.close();
  }
});
