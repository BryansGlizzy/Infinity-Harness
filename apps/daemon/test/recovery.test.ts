// What a daemon restart does to cards that were being worked (master plan 6.6, step 8): their sessions are closed, the
// workers go back to Ready, planners wait for a human, and the agent's own conversation is picked up again when the
// harness can.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { Card } from '@ih/core';
import { AcpAgent, claudeArgs } from '@ih/adapters';
import { Runner } from '../src/runner.ts';
import { setup, status, waitFor } from './harness.ts';

const fakeAgent = fileURLToPath(new URL('../../../packages/adapters/test/fake-agent.mjs', import.meta.url));
type Env = Awaited<ReturnType<typeof setup>>;

const until = async (cond: () => boolean, ms = 8000) => {
  for (let t = 0; !cond(); t += 15) {
    if (t > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
};
const agentText = (t: Env, cardId: string) =>
  t.store
    .eventsFor(cardId)
    .filter((e) => e.type === 'session.event')
    .map((e) => (e.payload as { event: { type: string; text?: string; message?: string } }).event)
    .map((e) => e.text ?? e.message ?? '')
    .join('\n');

/** A second daemon on the same database: a new Runner with its own agent processes. */
function restarted(t: Env, agentEnv: Record<string, string> = {}) {
  return new Runner(t.store, t.cfg, {
    isInstalled: () => false,
    makeAdapter: () => new AcpAgent({ id: 'fake', command: process.execPath, args: [fakeAgent], cwd: t.cfg.dataDir, env: { ...process.env, ...agentEnv } }),
    caps: (boardId) => t.store.getSettings(boardId),
  });
}

/** Starts a card that stays mid-turn, as a daemon about to go away would find it. */
async function midWork(t: Env, title = 'Long job') {
  const card = t.store.createCard({ boardId: t.board.id, title, description: 'SLOW: take your time' });
  await t.runner.run(card.id, 'fa');
  await until(() => t.store.getCard(card.id)!.status === 'in_progress' && !!t.store.listSessions(card.id)[0]?.vendorSessionId);
  return card;
}

test('crash recovery: dead sessions are closed, workers go back to Ready, planners wait for a human, live work is left alone', async () => {
  const t = await setup();
  try {
    const worker = t.store.createCard({ boardId: t.board.id, title: 'Worker' });
    const planner = t.store.createCard({ boardId: t.board.id, title: 'Planner', role: 'orchestrator' });
    const inReview = t.store.createCard({ boardId: t.board.id, title: 'Reviewed' });
    for (const c of [worker, planner]) t.store.updateCard(c.id, { status: 'in_progress', poolId: 'fa' });
    t.store.updateCard(inReview.id, { status: 'review' });
    // What a crash leaves: sessions marked open, with no process behind them.
    const s1 = t.store.createSession({ cardId: worker.id, poolId: 'fa', harness: 'opencode', model: 'fake/two' });
    t.store.updateSession(s1.id, { state: 'running', vendorSessionId: 'v-1' });
    const s2 = t.store.createSession({ cardId: planner.id, poolId: 'fa', harness: 'opencode', model: 'fake/two' });
    t.store.updateSession(s2.id, { state: 'idle' });
    const s3 = t.store.createSession({ cardId: inReview.id, poolId: 'fb', harness: 'opencode', model: 'fake/two' });
    t.store.updateSession(s3.id, { state: 'running' });

    const out = t.runner.recoverInterrupted();
    assert.equal(out.sessions, 3);
    assert.deepEqual(out.requeued.map((c) => c.title), ['Worker']);
    assert.deepEqual(out.blocked.map((c) => c.title), ['Planner']);
    assert.equal(t.store.getCard(worker.id)!.status, 'ready');
    assert.equal(t.store.getCard(planner.id)!.status, 'blocked');
    assert.equal(t.store.getCard(inReview.id)!.status, 'review', 'a card waiting for review stays there');
    assert.deepEqual(t.store.openSessions(), [], 'nothing is marked running any more');
    assert.equal(t.store.listSessions(worker.id)[0]!.state, 'failed');
    const marker = t.store.eventsFor(worker.id).find((e) => e.type === 'session.interrupted')!;
    assert.deepEqual(marker.payload, { sessionId: s1.id, poolId: 'fa', vendorSessionId: 'v-1', reason: 'daemon_restart' });
    const note = t.store.boardMessages(t.board.id).find((m) => m.fromActor === 'daemon:recovery')!;
    assert.match(note.body, /restarted while cards were being worked\. Put back in Ready.*"Worker".*Blocked for you.*"Planner"/);
    assert.equal(note.toCard, null, 'it goes to the humans');

    assert.deepEqual(t.runner.recoverInterrupted(), { sessions: 0, requeued: [], blocked: [] }, 'idempotent');
    assert.equal(t.store.boardMessages(t.board.id).filter((m) => m.fromActor === 'daemon:recovery').length, 1);
  } finally {
    await t.close();
  }
});

test('recovery leaves a card that is being worked right now alone', async () => {
  const t = await setup();
  try {
    const card = await midWork(t);
    assert.deepEqual(t.runner.recoverInterrupted(), { sessions: 0, requeued: [], blocked: [] });
    assert.equal(t.store.getCard(card.id)!.status, 'in_progress');
    await t.runner.cancel(card.id);
  } finally {
    await t.close();
  }
});

test('a graceful restart picks the agent\'s conversation up again: the old history is not replayed into the log and the agent is told what happened', async () => {
  const t = await setup();
  let r2: Runner | null = null;
  try {
    const card = await midWork(t);
    const first = t.store.listSessions(card.id)[0]!;
    assert.equal(first.vendorSessionId, 'fake-1');

    t.runner.shutdown(); // the daemon goes away mid-turn
    assert.equal(t.store.listSessions(card.id)[0]!.state, 'failed');
    assert.equal((t.store.eventsFor(card.id).find((e) => e.type === 'session.interrupted')!.payload as { reason: string }).reason, 'daemon_shutdown');

    r2 = restarted(t); // ...and comes back
    const out = r2.recoverInterrupted();
    assert.deepEqual(out.requeued.map((c: Card) => c.id), [card.id]);
    const reached = waitFor(t.store, status(t.store, card.id, 'review'));
    await r2.run(card.id, 'fa');
    await reached;

    const sessions = t.store.listSessions(card.id);
    assert.equal(sessions.length, 2);
    assert.equal(sessions[1]!.vendorSessionId, 'fake-1', 'the same conversation');
    const said = agentText(t, card.id);
    assert.match(said, /Picked up the earlier session after the daemon restarted\./);
    assert.match(said, /loaded prompt:The daemon that runs this board restarted while you were working/);
    assert.ok(!said.includes('SLOW: take your time') || said.indexOf('SLOW: take your time') < said.indexOf('Picked up'), 'the task is not sent again');
    assert.ok(!said.includes('REPLAYED-OLD-PROMPT') && !said.includes('REPLAYED-OLD-ANSWER'), 'the replayed history stays out of the card log');
  } finally {
    r2?.shutdown();
    await t.close();
  }
});

test('when the harness cannot resume, or the old session is gone, the card starts a fresh session with the "earlier session stopped" note', async () => {
  for (const [name, env, mentions] of [
    ['the load is refused', { FAKE_LOAD_FAILS: '1' }, /could not pick up the earlier fake session \(unknown session\); starting a new one/],
    ['the harness has no loadSession', { FAKE_NO_LOAD: '1' }, null],
  ] as const) {
    const t = await setup();
    let r2: Runner | null = null;
    try {
      const card = await midWork(t, name);
      t.runner.shutdown();
      r2 = restarted(t, env);
      r2.recoverInterrupted();
      t.store.updateCard(card.id, { description: 'finish quickly please' }); // (the first run was told to dawdle)
      const reached = waitFor(t.store, status(t.store, card.id, 'review'));
      await r2.run(card.id, 'fa');
      await reached;
      const said = agentText(t, card.id);
      if (mentions) assert.match(said, mentions, name);
      else assert.ok(!said.includes('could not pick up'), `${name}: nothing to apologise for`);
      assert.ok(!said.includes('Picked up the earlier session'), name);
      assert.ok(!said.includes('loaded prompt:'), name);
      assert.match(said, /An earlier session on fa stopped before finishing\. Whatever it did is committed on this branch/, `${name}: the old fallback note`);
      assert.match(said, /finish quickly please/, `${name}: the task is sent in full`);
    } finally {
      r2?.shutdown();
      await t.close();
    }
  }
});

test('a card routed to another pool after the restart starts fresh there', async () => {
  const t = await setup();
  let r2: Runner | null = null;
  try {
    const card = await midWork(t);
    t.runner.shutdown();
    r2 = restarted(t);
    r2.recoverInterrupted();
    t.store.updateCard(card.id, { description: 'finish quickly please' });
    const reached = waitFor(t.store, status(t.store, card.id, 'review'));
    await r2.run(card.id, 'fb');
    await reached;
    const said = agentText(t, card.id);
    assert.ok(!said.includes('loaded prompt:') && !said.includes('Picked up the earlier session'));
    assert.match(said, /An earlier session on fa stopped before finishing/);
  } finally {
    r2?.shutdown();
    await t.close();
  }
});

test('claude is resumed with --resume, and only with a session id', () => {
  const base = { settingsFile: '/s.json', mcpFile: '/m.json' };
  assert.deepEqual(claudeArgs({ ...base, resume: 'abc-123' }).slice(-2), ['--resume', 'abc-123']);
  assert.ok(!claudeArgs(base).includes('--resume'));
  const full = claudeArgs({ ...base, model: 'sonnet', reasoning: 'high', resume: 'abc' });
  assert.deepEqual(full.slice(0, 7), ['--settings', '/s.json', '--mcp-config', '/m.json', '--strict-mcp-config', '--setting-sources', 'project,local']);
  assert.ok(full.includes('--model') && full.includes('--effort'));
  assert.ok(!claudeArgs({ ...base, reasoning: 'bogus' }).includes('--effort'), 'an effort level Claude does not offer is dropped');
});
