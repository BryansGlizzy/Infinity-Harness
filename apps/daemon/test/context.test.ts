import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentProfile, DaemonEvent, HarnessEvent, Settings } from '@mh/core';
import type { Store } from '@mh/db';
import { FastLane } from '@mh/fast-lane';
import { KevClient } from '@mh/router';
import { setup, waitFor } from './harness.ts';

const agent = (id: string, poolId: string, model = ''): AgentProfile => ({ id, poolId, model, role: 'worker', delegatesTo: [], enabled: true });
/** fa runs fake/one, fb the pool default fake/two: CALL[fake/one] lines run only on fa. */
const AGENTS = [agent('fa', 'fa', 'fake/one'), agent('fb', 'fb')];
const QUIET: Partial<Settings> = { agents: AGENTS, crossReview: false, testCommand: 'test -f notes.md', landMode: 'local' };

/** Polls: some states (a parked, idle session) change without an event. */
async function until(store: Store, check: () => boolean, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      if (process.env.DEBUG_CTX) for (const b of store.listBoards()) for (const c of store.listCards(b.id)) console.log(c.title, c.status, said(store, c.id).slice(-1500));
      throw new Error('timed out');
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Agent messages on a card (the fake agent echoes its prompts and board tool results as messages). */
const said = (store: Store, cardId: string) =>
  store
    .eventsFor(cardId)
    .filter((e: DaemonEvent) => e.type === 'session.event')
    .map((e) => (e.payload as { event: HarnessEvent }).event)
    .filter((h): h is Extract<HarnessEvent, { type: 'message' }> => h.type === 'message')
    .map((h) => h.text)
    .join('\n');

const call = (tool: string, args: unknown, model?: string) => `CALL${model ? `[${model}]` : ''} ${tool} ${JSON.stringify(args)}`;

test('exit: a reassigned card\'s new agent finds the prior decision through search; outcomes change routing', async () => {
  const kev = new KevClient({
    url: 'http://kev',
    model: 'kev-9b',
    fetch: (async () => new Response(JSON.stringify({ answers: { quality: { score: 3 }, in_scope: { noul: 0.9 } } }))) as typeof fetch,
  });
  const { store, scheduler, refinery, board, close } = await setup({ outcomeKev: kev });
  try {
    store.updateSettings(board.id, { ...QUIET, scarcity: { fa: 1, fb: 0.95 } });
    const description = [
      'Add the export command.',
      call('put_artifact', { kind: 'decision', title: 'CSV, not JSON', body: 'Exports are CSV with a header row; the downstream tool cannot read JSON.' }, 'fake/one'),
      call('write_handoff', { state: 'CSV writer half done', decisions: ['CSV with header row'], next_steps: ['finish the writer'] }, 'fake/one'),
      'FAIL[fake/one]',
      call('search_context', { query: 'what export format did we choose', scope: 'card' }, 'fake/two'),
    ].join('\n');
    const card = store.createCard({ boardId: board.id, title: 'Export command', description, status: 'ready', workType: 'feature' });
    store.updateCard(card.id, { classification: { workType: 'feature', workTypeProbs: {}, complexity: 1, complexityProbs: {}, needsReview: 0, source: 'kev', at: '' } });

    const before = scheduler.rank(store.getCard(card.id)!);
    assert.equal(before[0]!.agentId, 'fa', 'fa ranks first before any outcomes');

    scheduler.start();
    refinery.start();
    await until(store, () => store.getCard(card.id)!.status === 'done', 40_000);

    // The first agent left a decision and a handoff before failing; the daemon's handoff kept both.
    const sessions = store.listSessions(card.id).map((s) => s.poolId);
    assert.deepEqual(sessions, ['fa', 'fb']);
    const decision = store.listArtifacts(board.id, { cardIds: [card.id], kinds: ['decision'] })[0]!;
    assert.equal(decision.title, 'CSV, not JSON');
    const handoffs = store.listArtifacts(board.id, { cardIds: [card.id], kinds: ['handoff'], all: true });
    assert.equal(handoffs.length, 2, "the agent's own handoff, superseded by the daemon's");
    const daemonHandoff = handoffs.find((h) => h.author === 'daemon:handoff')!;
    assert.equal(daemonHandoff.supersededBy, null);
    assert.match(daemonHandoff.body, /## State[\s\S]*previous run failed[\s\S]*## Decisions\n- \[a_\w+\] decision: CSV, not JSON[\s\S]*The previous agent's own handoff[\s\S]*CSV writer half done/);

    // The new agent's prompt listed the notes, and its search found the decision.
    const text = said(store, card.id);
    assert.match(text, new RegExp(`Earlier work on this card left these notes[\\s\\S]*${decision.id} \\(decision\\): CSV, not JSON`));
    assert.match(store.boardMessages(board.id).find((m) => m.fromActor === 'daemon:handoff')!.body, /Saved as artifact a_/);
    const search = /search_context -> (.*)/.exec(text)?.[1] ?? '';
    assert.match(search, new RegExp(decision.id));
    assert.match(search, /CSV, not JSON/);

    // Spec and summary were captured automatically.
    assert.equal(store.listArtifacts(board.id, { cardIds: [card.id], kinds: ['spec'] }).length, 1);
    assert.match(store.listArtifacts(board.id, { cardIds: [card.id], kinds: ['summary'] })[0]!.body, /Done with fake\/two/);

    // Outcomes: fa failed the run, fb landed it (Kev: fully meets, in scope).
    await until(store, () => store.outcomesFor(card.id).length === 2, 10_000);
    const outcomes = store.outcomesFor(card.id).map((o) => [o.agentId, o.model, o.result, o.value]);
    assert.deepEqual(outcomes, [
      ['fa', 'fake/one', 'failed_run', 0],
      ['fb', 'fake/two', 'landed', 1],
    ]);

    // Routing for the next feature card has visibly changed: fa's success fell below its prior, fb's rose.
    const next = store.createCard({ boardId: board.id, title: 'Another feature', workType: 'feature' });
    store.updateCard(next.id, { classification: { workType: 'feature', workTypeProbs: {}, complexity: 1, complexityProbs: {}, needsReview: 0, source: 'kev', at: '' } });
    const after = scheduler.rank(store.getCard(next.id)!);
    assert.equal(after[0]!.agentId, 'fb');
    const fa = after.find((c) => c.agentId === 'fa')!;
    assert.ok(fa.score < before.find((c) => c.agentId === 'fa')!.score);
    assert.match(fa.reasons.join(), /observed 0 n=1/);
    assert.match(after[0]!.reasons.join(), /observed 1 n=1/);

    // With learning off, routing goes back to the priors.
    store.updateSettings(board.id, { learnFromOutcomes: false });
    assert.equal(scheduler.rank(store.getCard(next.id)!)[0]!.agentId, 'fa');
  } finally {
    await close();
  }
});

test('ask_agent: an idle agent is asked directly and its reply returned; a busy one is answered from its notes', async () => {
  const lane = new FastLane({
    gatewayUrl: 'http://gw',
    token: 't',
    chain: [{ poolId: 'groq', model: 'g' }],
    poolState: () => 'open',
    fetch: (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const [system, input] = [body.messages[0].content as string, body.messages[1].content as string];
      const content = system.includes('busy') ? (/^Question: .*port/im.test(input) && /listens on 9090/.test(input) ? 'It listens on port 9090 (contract).' : 'UNKNOWN') : '';
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
    }) as typeof fetch,
  });
  const { store, runner, scheduler, board, close } = await setup({ lane });
  try {
    store.updateSettings(board.id, { ...QUIET, narrator: false, specLint: false, queryRewrite: false, artifactTagging: false });

    // Idle target: finishes its turn and parks; the question wakes it and it replies.
    const idle = store.createCard({ boardId: board.id, title: 'Server', status: 'ready', routing: { pools: ['fa'] } });
    scheduler.start();
    await until(store, () => store.getCard(idle.id)!.status === 'review' && runner.sessionState(idle.id) === 'idle');
    const asker = store.createCard({ boardId: board.id, title: 'Client', routing: { pools: ['fb'] } });
    const question = `Which port?\n${call('post_message', { to: asker.id, body: 'port 8080' })}`;
    store.updateCard(asker.id, { description: call('ask_agent', { card_id: idle.id, question, timeout_seconds: 20 }), status: 'ready' });
    await until(store, () => store.getCard(asker.id)!.status === 'review');
    assert.match(said(store, asker.id), /ask_agent -> \{ "answered": true, "from": "agent", "answer": "port 8080" \}/);
    assert.equal(store.pendingMessages(asker.id).length, 0, 'the reply was returned, not queued');

    // Busy target: records a contract, then works slowly; the question is answered from the contract.
    const busy = store.createCard({
      boardId: board.id,
      title: 'Worker',
      description: `${call('put_artifact', { kind: 'contract', title: 'Port', body: 'The worker listens on 9090.' })}\nSLOW`,
      status: 'ready',
      routing: { pools: ['fa'] },
    });
    await waitFor(store, (e) => e.type === 'artifact.saved' && e.subject === busy.id && (e.payload as any).artifact.kind === 'contract');
    assert.equal(runner.sessionState(busy.id), 'busy');
    const asker2 = store.createCard({
      boardId: board.id,
      title: 'Client 2',
      description: call('ask_agent', { card_id: busy.id, question: 'Which port does the worker listen on?' }),
      status: 'ready',
      routing: { pools: ['fb'] },
    });
    await until(store, () => store.getCard(asker2.id)!.status === 'review');
    const answer = /ask_agent -> (.*)/.exec(said(store, asker2.id))?.[1] ?? '';
    assert.match(answer, /"from": "notes"/);
    assert.match(answer, /9090/);
    const contract = store.listArtifacts(board.id, { cardIds: [busy.id], kinds: ['contract'] })[0]!;
    assert.match(answer, new RegExp(`"sources": \\[[^\\]]*"${contract.id}"`));
    assert.equal(store.pendingMessages(busy.id).length, 0, 'the busy agent was not interrupted or sent the question');

    // Not covered by its notes: the question waits in the target's inbox instead.
    const asker3 = store.createCard({
      boardId: board.id,
      title: 'Client 3',
      description: call('ask_agent', { card_id: busy.id, question: 'What colour is the logo?' }),
      status: 'ready',
      routing: { pools: ['fb'] },
    });
    await until(store, () => store.getCard(asker3.id)!.status === 'review');
    assert.match(said(store, asker3.id), /"answered": false/);
    assert.ok(store.boardMessages(board.id).some((m) => m.toCard === busy.id && /logo/.test(m.body)));
  } finally {
    await close();
  }
});

test('report_blocked asks for a handoff first and is weighed by a human, not counted; search_context respects scope; the HTTP API lists and searches artifacts', async () => {
  const { store, scheduler, refinery, board, cfg, close } = await setup();
  try {
    store.updateSettings(board.id, { ...QUIET, maxRetries: 0 });
    const parent = store.createCard({ boardId: board.id, title: 'Parent', role: 'lead' });
    const sibling = store.createCard({ boardId: board.id, title: 'Sibling', parentId: parent.id });
    store.putArtifact({ boardId: board.id, cardId: sibling.id, kind: 'contract', title: 'Shared schema', body: 'users(id, email)', author: 'card:x' });
    const far = store.createCard({ boardId: board.id, title: 'Elsewhere' });
    store.putArtifact({ boardId: board.id, cardId: far.id, kind: 'contract', title: 'Other schema', body: 'orders(id, email)', author: 'card:y' });
    const card = store.createCard({
      boardId: board.id,
      title: 'Blocked one',
      parentId: parent.id,
      description: [call('search_context', { query: 'email schema', scope: 'subtree' }), call('report_blocked', { reason: 'needs keys' })].join('\n'),
      status: 'ready',
    });
    scheduler.start();
    refinery.start();
    await until(store, () => store.getCard(card.id)!.status === 'blocked' && store.outcomesFor(card.id).length > 0);
    const text = said(store, card.id);
    assert.match(/search_context -> (.*)/.exec(text)![1]!, /Shared schema/);
    assert.doesNotMatch(/search_context -> (.*)/.exec(text)![1]!, /Other schema/);
    assert.match(text, /report_blocked -> .*call write_handoff now/);

    const base = `http://127.0.0.1:${cfg.port}/api`;
    const hits = (await (await fetch(`${base}/boards/${board.id}/context?q=email&kinds=contract`)).json()) as { artifact: { title: string } }[];
    assert.deepEqual(hits.map((h) => h.artifact.title).sort(), ['Other schema', 'Shared schema']);
    const posted = await fetch(`${base}/cards/${card.id}/artifacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'note', title: 'Keys', body: 'Use the staging keys in vault.' }),
    });
    assert.equal(posted.status, 200);
    const list = (await (await fetch(`${base}/cards/${card.id}/artifacts`)).json()) as { kind: string; author: string }[];
    assert.deepEqual(list.map((a) => a.kind).sort(), ['note', 'spec']);
    const priors = (await (await fetch(`${base}/boards/${board.id}/priors`)).json()) as { agentId: string; prior: { family: string } }[];
    assert.deepEqual(priors.map((p) => p.agentId).sort(), ['fa', 'fb']);

    // The block is not counted against the agent: it waits for a human, who is told.
    const [blocked] = store.outcomesFor(card.id);
    assert.equal(store.outcomesFor(card.id).length, 1, 'no escalation outcome either');
    assert.equal(blocked!.result, 'blocked');
    assert.equal(blocked!.review, 'pending');
    assert.equal(blocked!.note, 'needs keys');
    assert.ok(store.boardMessages(board.id).some((m) => m.fromActor === 'daemon:outcomes' && /Weigh it/.test(m.body)));
    const work = store.getCard(card.id)!.classification!;
    const stats = () => store.outcomeStats(work.workType, work.complexity);
    assert.deepEqual(stats(), [], 'pending outcomes do not count');
    const pending = (await (await fetch(`${base}/outcomes?board=${board.id}&pending=1`)).json()) as { id: number }[];
    assert.deepEqual(pending.map((o) => o.id), [blocked!.id]);

    const weigh = (verdict: string) =>
      fetch(`${base}/outcomes/${blocked!.id}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verdict }) });
    assert.equal((await weigh('maybe')).status, 400);
    assert.equal((await weigh('ignore')).status, 200);
    assert.deepEqual(stats(), [], 'ignored outcomes do not count');
    await weigh('pass');
    assert.equal(stats()[0]!.rate, 1);
    await weigh('fail');
    assert.equal(stats()[0]!.rate, 0);
    assert.equal(((await (await fetch(`${base}/outcomes?board=${board.id}&pending=1`)).json()) as unknown[]).length, 0);
    assert.ok(store.eventsFor(card.id).some((e) => e.type === 'outcome.reviewed'));
  } finally {
    await close();
  }
});
