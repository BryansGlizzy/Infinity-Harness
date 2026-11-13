import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Council, HarnessEvent } from '@ih/core';
import type { Store } from '@ih/db';
import { KevClient } from '@ih/router';
import { readProposal, renderProposal } from '../src/council.ts';
import { setup } from './harness.ts';

async function until(check: () => boolean, ms = 40_000, debug?: () => unknown) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out ${debug ? JSON.stringify(debug()) : ''}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const said = (store: Store, id: string) =>
  store
    .eventsFor(id)
    .filter((e) => e.type === 'session.event')
    .map((e) => (e.payload as { event: HarnessEvent }).event)
    .filter((h): h is Extract<HarnessEvent, { type: 'message' }> => h.type === 'message')
    .map((h) => h.text)
    .join('\n');

const call = (tool: string, args: unknown, opts: { model?: string; when?: string } = {}) =>
  `${opts.when ? `WHEN(${opts.when}) ` : ''}CALL${opts.model ? `[${opts.model}]` : ''} ${tool} ${JSON.stringify(args)}`;

test('renderProposal / readProposal round-trip the shares', () => {
  const shares = [{ member: 'a', scope: 'Parser', cards: ['Lexer', 'Parser'] }];
  assert.deepEqual(readProposal(renderProposal('a', shares, 'clean split')), shares);
  assert.equal(readProposal('no json here'), null);
});

test('council: members propose, Kev picks the best split, each plans its share, then they cross-check and fix up', async () => {
  // Kev: proposal 1 (orch-a) scores higher than proposal 2; worker cards are small bugfixes.
  const kev = new KevClient({
    url: 'http://kev',
    model: 'kev-9b',
    fetch: (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const answers = body.questions.p1
        ? { p1: { score: 3 }, p2: { score: 1 } }
        : { work_type: { noul: 0.9, choice: 'feature' }, complexity: { score: 1 }, needs_review: { noul: 0.1 }, frontend: { noul: 0 } };
      return new Response(JSON.stringify({ answers }));
    }) as typeof fetch,
  });
  const { store, scheduler, refinery, council, board, cfg, close } = await setup({ kev });
  try {
    store.updateSettings(board.id, {
      agents: [
        { id: 'orch-a', poolId: 'fa', model: 'fake/one', role: 'orchestrator', delegatesTo: [], enabled: true },
        { id: 'orch-b', poolId: 'fb', model: '', role: 'orchestrator', delegatesTo: [], enabled: true },
        { id: 'worker', poolId: 'fb', model: '', role: 'worker', delegatesTo: [], enabled: true },
      ],
      crossReview: false,
      landMode: 'local',
      specLint: false,
      councilVerifyRounds: 2,
    });
    const sub = (title: string) => ({ title, description: `Do ${title}.`, acceptance_criteria: [`${title} exists`] });
    // Each scope carries the member's planning step, run only when that member is told "Your share".
    const split = (rationale: string) => ({
      shares: [
        { member: 'orch-a', scope: `Part A\n${call('create_subtask', sub('Card A'), { when: 'Your share', model: 'fake/one' })}`, cards: ['Card A'] },
        { member: 'orch-b', scope: `Part B\n${call('create_subtask', sub('Card B'), { when: 'Your share', model: 'fake/two' })}`, cards: ['Card B'] },
      ],
      rationale,
    });
    const description = [
      'Build parts A and B.',
      call('create_subtask', sub('Too early'), { when: 'propose how to split', model: 'fake/one' }),
      call('propose_split', split("a's split"), { when: 'propose how to split', model: 'fake/one' }),
      call('propose_split', split("b's split"), { when: 'propose how to split', model: 'fake/two' }),
      // In the first verification round orch-b (checking orch-a's share) adds a fix-up card.
      call('create_subtask', sub('Fix A'), { when: 'Verification round 1', model: 'fake/two' }),
    ].join('\n');

    scheduler.start();
    refinery.start();
    council.start();
    const res = await fetch(`http://127.0.0.1:${cfg.port}/api/boards/${board.id}/goals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'Parts A and B', description }),
    });
    assert.equal(res.status, 200);
    const goal = (await res.json()) as { id: string; pipeline: { council: Council } };
    const members = goal.pipeline.council.members;
    assert.deepEqual(members.map((m) => m.agentId), ['orch-a', 'orch-b']);
    const c = () => store.getCard(goal.id)!.pipeline.council!;
    const steps = () => store.eventsFor(goal.id).filter((e) => e.type === 'card.council').map((e) => (e.payload as { step: string }).step);

    await until(() => c().phase === 'done', 60_000, () => ({ phase: c().phase, steps: steps(), cards: store.listCards(board.id).map((x) => [x.title, x.status]) }));

    // Proposing: no cards before the split; both proposals saved; Kev chose orch-a's.
    const a = members[0]!;
    const b = members[1]!;
    assert.match(said(store, a.cardId), /create_subtask -> ERROR The council is still choosing a split/);
    assert.equal(store.listArtifacts(board.id, { kinds: ['proposal'] }).length, 2);
    assert.equal(c().winner, 'orch-a');
    assert.deepEqual(c().scores, { 'orch-a': 1, 'orch-b': 0.333 });
    assert.match(store.listArtifacts(board.id, { cardIds: [goal.id], kinds: ['decision'] })[0]!.title, /Council split: orch-a/);

    // Planning: each member created its own share's card under its own card, and they landed.
    const under = (id: string) => store.listCards(board.id).filter((x) => x.parentId === id).map((x) => x.title).sort();
    assert.deepEqual(under(a.cardId), ['Card A']);
    assert.deepEqual(under(b.cardId), ['Card B', 'Fix A']);
    for (const x of store.listCards(board.id).filter((x) => x.role === 'worker')) assert.equal(x.status, 'done', x.title);

    // Verification: cross-checks (a checks b, b checks a), a fix-up round, then a clean round.
    assert.match(said(store, a.cardId), /you check orch-b's share/);
    assert.match(said(store, b.cardId), /you check orch-a's share/);
    assert.deepEqual(steps(), ['proposing', 'decided', 'working', 'verifying', 'verified', 'verifying', 'verified', 'done']);
    assert.equal(c().round, 2);
    assert.equal(store.getCard(goal.id)!.status, 'done');
    for (const m of members) assert.equal(store.getCard(m.cardId)!.status, 'done');
  } finally {
    await close();
  }
});

test('a goal with one orchestrator is planned as before; council needs two with open pools', async () => {
  const { store, council, board, limiter, close } = await setup();
  try {
    assert.equal(council.members(board.id).length, 1);
    store.updateSettings(board.id, {
      agents: [
        { id: 'o1', poolId: 'fa', model: '', role: 'orchestrator', delegatesTo: [], enabled: true },
        { id: 'o2', poolId: 'fb', model: '', role: 'orchestrator', delegatesTo: [], enabled: true },
      ],
    });
    assert.equal(council.members(board.id).length, 2);
    limiter.force('fb', 96);
    assert.equal(council.members(board.id).length, 1, 'a halted pool sits out');
    await assert.rejects(council.startGoal(board.id, 'x', ''), /at least two/);
  } finally {
    await close();
  }
});
