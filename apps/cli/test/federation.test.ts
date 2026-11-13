// Swarm federation driven from the command line: two real daemons (fake agents), each with its own federation
// listener, connected by local URL, and `ih` talking to each one's operator API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup } from '../../daemon/test/harness.ts';
import { run } from '../src/cli.ts';
import type { Io } from '../src/io.ts';

type Env = Awaited<ReturnType<typeof setup>>;

function cli(t: Env) {
  const config = mkdtempSync(join(tmpdir(), 'ih-ih-'));
  return async (args: string[]) => {
    let out = '';
    let err = '';
    const io: Io = { out: (s) => (out += s), err: (s) => (err += s), env: { IH_URL: `http://127.0.0.1:${t.cfg.port}`, XDG_CONFIG_HOME: config }, cwd: '/nowhere', tty: false };
    const code = await run(args, io);
    return { code, out, err, json: () => JSON.parse(out) as any };
  };
}

test('two swarms: knock, accept, share a project, search it, ask for a fix, land it, confirm', async () => {
  const [a, b] = await Promise.all([setup({ federation: true }), setup({ federation: true })]);
  const ihA = cli(a);
  const ihB = cli(b);
  try {
    // Identity.
    const selfA = (await ihA(['swarm', '--name', 'Alpha'])).json();
    const selfB = (await ihB(['swarm', '--name', 'Beta'])).json();
    assert.equal(selfA.self.name, 'Alpha');
    assert.match(selfB.self.fingerprint, /^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);
    assert.notEqual(selfA.self.swarmId, selfB.self.swarmId);
    // What to give someone who wants to connect: the federation port and where this machine is.
    assert.equal(selfA.port, Number(new URL(a.fedUrl).port));
    assert.ok(selfA.host.name.length > 0);
    assert.match((await ihA(['swarm'])).out, /"port": \d+/);

    // B shares its project: draft, edit, publish.
    const drafted = (await ihB(['project', 'draft'])).json();
    assert.ok(drafted.shared.draft, 'drafted from the repository');
    assert.equal(drafted.shared.draft.accepts.requests, false, 'never defaults to taking requests');
    const set = await ihB(['project', 'set', '--one-line', 'A demo library', '--provides', '@beta/demo;demo-cli', '--accepts', 'yes', '--about', 'Does demo things. Private detail here.']);
    assert.equal(set.code, 0, set.err);
    assert.equal((await ihB(['project', 'publish', 'full'])).code, 0);
    assert.equal((await ihB(['project', 'list'])).json()[0].visibility, 'full');

    // A connects; B is silent until accepted.
    const add = await ihA(['peer', 'add', 'beta', '--peer-url', b.fedUrl, '--fingerprint', selfB.self.fingerprint]);
    assert.equal(add.code, 0, add.err);
    assert.equal((await ihA(['peer', 'poll', 'beta'])).json().link, 'waiting');
    assert.deepEqual((await ihA(['peer', 'projects'])).json(), [], 'A sees nothing yet');

    // B's operator sees the knock in `needs`, with the fingerprint to compare, and accepts it.
    const needs = (await ihB(['needs'])).json();
    const knock = needs.find((n: any) => n.kind === 'peer');
    assert.ok(knock, 'a knock is waiting');
    assert.match(knock.title, /Alpha/);
    assert.ok(knock.detail.includes(selfA.self.fingerprint));
    const accepted = await ihB(['peer', 'approve', knock.id]);
    assert.equal(accepted.code, 0, accepted.err);
    assert.equal((await ihB(['needs'])).json().filter((n: any) => n.kind === 'peer').length, 0);

    // A's next round is answered; the project is visible at BASIC (B has not marked A trusted).
    const polled = (await ihA(['peer', 'poll', 'beta'])).json();
    assert.equal(polled.link, 'online');
    assert.equal(polled.fingerprint, selfB.self.fingerprint);
    const found = (await ihA(['peer', 'projects', 'demo-cli'])).json();
    assert.equal(found.length, 1);
    assert.equal(found[0].card.about, '', 'a peer that is not trusted does not get the paragraph');
    assert.equal(found[0].card.accepts.requests, true);
    const show = (await ihA(['peer', 'show', 'beta'])).json();
    assert.equal(show.projects[0].card.name.length > 0, true);

    // B trusts A and previews what it receives.
    const peerOnB = (await ihB(['peer', 'list'])).json()[0];
    assert.equal((await ihB(['peer', 'trust', peerOnB.id])).code, 0);
    assert.equal((await ihB(['peer', 'shares', peerOnB.id, 'full'])).code, 0);
    const preview = (await ihB(['peer', 'preview', peerOnB.id])).json();
    assert.equal(preview.allowed, 'full');
    assert.match(preview.projects[0].about, /Private detail/);
    await ihA(['peer', 'poll', 'beta']);
    assert.match((await ihA(['peer', 'projects', 'demo'])).json()[0].card.about, /Private detail/);

    // A asks B for a fix.
    const sent = await ihA(['peer', 'request', 'beta', 'Crash on empty input', '--description', 'parse("") throws', '--project', b.board.id, '--blocking', '--acceptance', 'parse("") returns []']);
    assert.equal(sent.code, 0, sent.err);
    const outReq = sent.json();
    assert.equal(outReq.status, 'pending');
    assert.ok(outReq.remoteId);

    // B's operator sees it and nothing has run.
    const waiting = (await ihB(['needs'])).json().find((n: any) => n.kind === 'peer_request');
    assert.ok(waiting);
    assert.match(waiting.title, /Crash on empty input/);
    assert.equal(b.store.listCards(b.board.id).some((c) => c.title.includes('Crash on empty input')), false, 'no card before approval');
    assert.equal((await ihB(['request', 'show', waiting.id])).json().description, 'parse("") throws');

    // B asks a question first; A answers it.
    assert.equal((await ihB(['request', 'ask', waiting.id, 'Which', 'parser?'])).code, 0);
    await ihA(['peer', 'poll', 'beta']);
    assert.equal((await ihA(['request', 'show', outReq.id])).json().status, 'needs_info');
    const answer = (await ihA(['request', 'comment', outReq.id, 'The', 'JSON', 'one'])).json();
    assert.equal(answer.thread.at(-1).text, 'The JSON one');

    // B approves: a goal for the orchestrator appears, marked as coming from outside.
    const approveRun = await ihB(['request', 'approve', waiting.id, '--note', 'ok']);
    assert.equal(approveRun.code, 0, approveRun.err);
    const approved = approveRun.json();
    assert.equal(approved.status, 'in_progress');
    const goal = b.store.getCard(approved.cardId)!;
    assert.match(goal.title, /^\[Alpha\] Crash on empty input/);
    assert.match(goal.description, /EXTERNAL REQUEST/);
    // The approved goal started a (fake) planning session; stop it before the daemon shuts down.
    await b.runner.cancel(goal.id).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));

    // B reports it landed; A sees it and confirms.
    assert.equal((await ihB(['request', 'landed', waiting.id, '--ref', 'abc1234', 'Fixed', 'in', 'parser'])).code, 0);
    await ihA(['peer', 'poll', 'beta']);
    const landed = (await ihA(['request', 'show', outReq.id])).json();
    assert.equal(landed.status, 'landed');
    assert.equal(landed.resolution.ref, 'abc1234');
    assert.equal((await ihA(['request', 'confirm', outReq.id])).json().status, 'done');
    assert.equal((await ihB(['request', 'show', waiting.id])).json().status, 'done');
    assert.match((await ihA(['request', 'list', '--all'])).out, /Crash on empty input/);
    assert.equal((await ihA(['request', 'list'])).json().length, 0, 'finished requests are not listed by default');

    // Mistakes are usage errors.
    assert.equal((await ihA(['peer', 'add', 'x'])).code, 2);
    assert.equal((await ihA(['peer', 'shares', 'beta', 'everything'])).code, 2);
    assert.equal((await ihA(['peer', 'request', 'beta', 'No description'])).code, 2);
    assert.equal((await ihA(['peer', 'add', 'evil', '--ssh=-oProxyCommand=x'])).code, 1, 'a bad SSH target is refused by the daemon');
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});

test('the operator API refuses what only a person may decide when the data is wrong', async () => {
  const a = await setup({ federation: true });
  const ih = cli(a);
  try {
    assert.equal((await ih(['peer', 'approve', 'nobody'])).code, 1);
    assert.equal((await ih(['request', 'approve', 'fr_nothing'])).code, 1);
    assert.equal((await ih(['peer'])).json().length, 0);
    assert.match((await ih(['help'])).out, /\n  peer\s/);
    // The federation routes exist on the federation port only: the main port (and its operator API) does not serve them.
    const base = `http://127.0.0.1:${a.cfg.port}`;
    for (const [method, path] of [['POST', '/fed/hello'], ['GET', '/fed/health'], ['POST', '/fed/requests']] as const) {
      const res = await fetch(`${base}${path}`, { method, body: method === 'POST' ? '{}' : undefined, headers: { 'content-type': 'application/json' } });
      assert.equal(res.status, 404, `${method} ${path} on the main port`);
    }
    assert.equal((await fetch(`${a.fedUrl}/api/federation`)).status, 404, 'and the operator API is not on the federation port');
  } finally {
    await a.close();
  }
});

test('auto-accept, milestones, budget and sending a result back, from the command line', async () => {
  const [a, b] = await Promise.all([setup({ federation: true }), setup({ federation: true })]);
  const ihA = cli(a);
  const ihB = cli(b);
  try {
    await ihB(['swarm', '--name', 'Beta']);
    await ihB(['project', 'draft']);
    await ihB(['project', 'set', '--accepts', 'yes', '--provides', '@beta/lib']);
    await ihB(['project', 'publish', 'basic']);
    await ihA(['peer', 'add', 'beta', '--peer-url', b.fedUrl]);
    await ihA(['peer', 'poll', 'beta']);
    const knock = (await ihB(['needs'])).json().find((n: any) => n.kind === 'peer');
    await ihB(['peer', 'approve', knock.id]);
    await ihA(['peer', 'poll', 'beta']);
    const peerOnB = (await ihB(['peer', 'list'])).json()[0];

    // Auto-accept is refused until the peer is trusted and has limits; mistakes are usage errors.
    assert.equal((await ihB(['peer', 'auto-accept', peerOnB.id, 'on', '--per-request-tokens', '50000', '--per-day-tokens', '200000'])).code, 1, 'not trusted yet');
    await ihB(['peer', 'trust', peerOnB.id]);
    const plain = await ihB(['peer', 'auto-accept', peerOnB.id, 'on']);
    assert.equal(plain.code, 0, 'without limits: sensible ones are used');
    assert.deepEqual(plain.json().caps.perRequest, { tokens: 300000 });
    assert.equal((await ihB(['peer', 'auto-accept', peerOnB.id, 'maybe'])).code, 2);
    assert.equal((await ihB(['peer', 'auto-accept', peerOnB.id, 'on', '--per-day-tokens', '-5'])).code, 2);
    const on = await ihB(['peer', 'auto-accept', peerOnB.id, 'on', '--per-request-tokens', '50000', '--per-day-tokens', '200000']);
    assert.equal(on.code, 0, on.err);
    assert.equal(on.json().autoAccept, true);
    assert.match((await ihB(['peer', 'show', peerOnB.id])).out, /"autoAccept": true/);

    // A's request starts by itself on B.
    const sent = (await ihA(['peer', 'request', 'beta', 'Fix the parser', '--description', 'It throws on empty input', '--project', b.board.id, '--milestones', 'Reproduce;Fix;Release', '--max-tokens', '30000'])).json();
    let inbound: any;
    for (let i = 0; i < 100; i++) {
      inbound = (await ihB(['request', 'list', '--in', '--all'])).json()[0];
      if (inbound?.status === 'in_progress') break;
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(inbound.status, 'in_progress', 'nobody was asked');
    assert.equal(inbound.auto, true);
    assert.deepEqual(inbound.budget, { maxTokens: 30000 }, 'the sender\'s smaller budget stands');
    assert.ok(b.store.boardMessages(b.board.id).some((m) => /Auto-accepted a request from/.test(m.body)));
    await b.runner.cancel(inbound.cardId).catch(() => {});

    // Milestones and the budget.
    assert.equal((await ihB(['request', 'milestone', inbound.id, '9'])).code, 1);
    assert.equal((await ihB(['request', 'milestone', inbound.id, 'x'])).code, 2);
    assert.equal((await ihB(['request', 'milestone', inbound.id, '0'])).code, 0);
    assert.deepEqual((await ihB(['request', 'show', inbound.id])).json().milestonesDone, [0]);
    const raised = await ihB(['request', 'budget', inbound.id, '--max-tokens', '40000']);
    assert.deepEqual(raised.json().budget, { maxTokens: 40000 });
    await ihA(['peer', 'poll', 'beta']);
    assert.deepEqual((await ihA(['request', 'show', sent.id])).json().milestonesDone, [0]);

    // Landed; A finds it wanting and sends it back; B's operator sees it again (and, being auto-accepted, it restarts).
    await ihB(['request', 'landed', inbound.id, '--ref', 'abc1234']);
    await ihA(['peer', 'poll', 'beta']);
    const needsA = (await ihA(['needs'])).json().find((n: any) => n.kind === 'peer_reply');
    assert.match(needsA.title, /Check what Beta landed/);
    assert.equal((await ihA(['request', 'reopen', sent.id])).code, 2, 'say what is wrong');
    const back = await ihA(['request', 'reopen', sent.id, 'still', 'throws', 'on', 'whitespace']);
    assert.equal(back.code, 0, back.err);
    for (let i = 0; i < 100; i++) {
      inbound = (await ihB(['request', 'show', inbound.id])).json();
      if (inbound.status === 'in_progress') break;
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(inbound.status, 'in_progress');
    assert.match(inbound.thread.map((e: any) => e.text).join('\n'), /Reopened: still throws on whitespace/);
    if (inbound.cardId) await b.runner.cancel(inbound.cardId).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});
