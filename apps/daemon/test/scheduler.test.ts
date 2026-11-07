import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '@mh/db';
import { git } from '../src/git.ts';
import { reservePaths } from '../src/leases.ts';
import { LOCKOUT_PATTERN } from '../src/runner.ts';
import { lockoutUntil } from '../src/scheduler.ts';
import { allReviewed, kevStub, laneStub, setup, status, waitFor } from './harness.ts';

const routedEvents = (store: Store, id: string) => store.eventsFor(id).filter((e) => e.type === 'card.routed').map((e) => e.payload as any);

test('goal → orchestrator plans via board MCP → Kev classifies → cards auto-route away from a halted pool', async () => {
  const { store, limiter, scheduler, board, close } = await setup({ kev: kevStub });
  try {
    scheduler.start();
    limiter.force('fa', 95); // the orchestrator's configured pool is halted: it falls back, and so do the workers
    const goal = await scheduler.startGoal(
      board.id,
      'Tidy the docs',
      [
        'CALL create_subtask {"title":"Fix README typo","description":"README.md has a typo","acceptance_criteria":["typo gone"],"work_type":"docs"}',
        'CALL create_subtask {"title":"Add CHANGELOG","description":"Create CHANGELOG.md","acceptance_criteria":["file exists"]}',
      ].join('\n'),
    );
    assert.equal(goal.role, 'orchestrator');
    assert.equal(goal.poolId, 'fb');

    const children = await allReviewed(store, board.id, (c) => c.parentId === goal.id);
    assert.deepEqual(children.map((c) => c.title).sort(), ['Add CHANGELOG', 'Fix README typo']);
    for (const child of children) {
      assert.equal(child.depth, 1);
      assert.equal(child.createdBy, `card:${goal.id}`);
      assert.equal(child.classification?.source, 'kev');
      assert.equal(child.poolId, 'fb');
      assert.match(child.description, /Acceptance criteria:\n- /);
      const [routed] = routedEvents(store, child.id);
      assert.equal(routed.poolId, 'fb');
      const fa = routed.candidates.find((c: any) => c.poolId === 'fa');
      assert.equal(fa.eligible, false);
      assert.match(fa.reasons.join(), /pool halted/);
    }
    assert.equal(store.getCard(children.find((c) => c.title === 'Fix README typo')!.id)!.workType, 'docs');

    // With the pool open again, new work spreads back onto it.
    limiter.force('fa', null);
    store.updateSettings(board.id, { scarcity: { fa: 1, fb: 0.5 } });
    const later = store.createCard({ boardId: board.id, title: 'One more', status: 'ready' });
    await waitFor(store, status(store, later.id, 'review'));
    assert.equal(store.getCard(later.id)!.poolId, 'fa');
  } finally {
    await close();
  }
});

test('delegation: the orchestrator marks a lead card, the lead plans it, and each level routes only to its targets', async () => {
  const { store, scheduler, board, cfg, close } = await setup();
  const agent = (id: string, poolId: string, role: 'orchestrator' | 'lead' | 'worker', delegatesTo: string[] = [], model = '') => ({ id, poolId, model, role, delegatesTo, enabled: true });
  try {
    store.updateSettings(board.id, {
      agents: [
        agent('orchestrator', 'fa', 'orchestrator', ['planner', 'fa-worker']),
        agent('planner', 'fa', 'lead', ['fb'], 'fake/one'),
        agent('fa-worker', 'fa', 'worker'),
        agent('fb', 'fb', 'worker'),
      ],
    });
    scheduler.start();
    const leaf = JSON.stringify({ title: 'Leaf', description: 'x', acceptance_criteria: ['y'] });
    const goal = await scheduler.startGoal(
      board.id,
      'Build it',
      [
        `CALL create_subtask ${JSON.stringify({ title: 'Big chunk', description: `CALL create_subtask ${leaf}`, acceptance_criteria: ['split'], delegate: true })}`,
        'CALL create_subtask {"title":"Direct","description":"x","acceptance_criteria":["y"]}',
      ].join('\n'),
    );
    assert.equal(goal.agentId, 'orchestrator');

    let all = await allReviewed(store, board.id, (c) => c.id !== goal.id);
    while (all.length < 3) all = await allReviewed(store, board.id, (c) => c.id !== goal.id);
    const byTitle = Object.fromEntries(all.map((c) => [c.title, c]));
    const chunk = byTitle['Big chunk']!;
    assert.equal(chunk.role, 'lead');
    assert.deepEqual(chunk.routing, { pools: ['planner', 'fa-worker'] });
    assert.equal(chunk.agentId, 'planner');
    assert.equal(store.listSessions(chunk.id)[0]!.model, 'fake/one', 'the lead runs its own model');
    assert.match(JSON.stringify(store.eventsFor(chunk.id)), /You are a lead agent/);

    assert.equal(byTitle.Leaf!.parentId, chunk.id);
    assert.equal(byTitle.Leaf!.depth, 2);
    assert.deepEqual(byTitle.Leaf!.routing, { pools: ['fb'] });
    assert.equal(byTitle.Leaf!.agentId, 'fb');
    assert.equal(byTitle.Direct!.agentId, 'fa-worker');

    // Cycles are refused when settings are saved.
    const res = await fetch(`http://127.0.0.1:${cfg.port}/api/boards/${board.id}/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agents: [agent('a', 'fa', 'lead', ['b']), agent('b', 'fb', 'lead', ['a'])] }),
    });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as any).error, /delegation cycle/);
  } finally {
    await close();
  }
});

test('a card blocked by a lead waits for the lead’s whole subtree, then merges its workers’ branches', async () => {
  const { store, scheduler, board, repo, close } = await setup();
  try {
    const lead = store.createCard({ boardId: board.id, title: 'Chunk', role: 'lead', status: 'review' }); // planned already
    const work = store.createCard({ boardId: board.id, parentId: lead.id, title: 'Chunk work' });
    const after = store.createCard({ boardId: board.id, title: 'After the chunk' });
    store.addDependency(after.id, lead.id);
    store.updateCard(after.id, { status: 'ready' });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(store.getCard(after.id)!.status, 'ready', 'the lead is in review but its worker has not run');

    store.updateCard(work.id, { status: 'ready' });
    await waitFor(store, status(store, after.id, 'review'));
    assert.equal(store.getCard(work.id)!.status, 'review');
    const log = await git(repo, ['log', '--format=%s', store.getCard(after.id)!.branch!]);
    assert.match(log, /Chunk work/);
  } finally {
    await close();
  }
});

test('delegate=true is refused when no lead agent is on the team', async () => {
  const { store, runner, board, close } = await setup();
  try {
    const orch = store.createCard({
      boardId: board.id,
      title: 'Plan',
      role: 'orchestrator',
      description: 'CALL create_subtask {"title":"Chunk","description":"x","acceptance_criteria":["y"],"delegate":true}',
    });
    const done = waitFor(store, status(store, orch.id, 'review'));
    await runner.run(orch.id, 'fa');
    await done;
    assert.equal(store.children(orch.id).length, 0);
    assert.match(store.eventsFor(orch.id).map((e) => JSON.stringify(e.payload)).join(), /No lead agent is on your team/);
  } finally {
    await close();
  }
});

test('a blocked card waits for its blocker, then starts with the blocker’s branch merged', async () => {
  const { store, scheduler, board, repo, close } = await setup();
  try {
    const a = store.createCard({ boardId: board.id, title: 'First part' });
    const b = store.createCard({ boardId: board.id, title: 'Second part' });
    store.addDependency(b.id, a.id);
    store.updateCard(b.id, { status: 'ready' });
    store.updateCard(a.id, { status: 'ready' });
    scheduler.start();

    const aDone = waitFor(store, status(store, a.id, 'review'));
    const bStarted = waitFor(store, status(store, b.id, 'in_progress'));
    const first = await Promise.race([aDone.then(() => 'a'), bStarted.then(() => 'b')]);
    assert.equal(first, 'a', 'B must not start before A is in review');
    await waitFor(store, status(store, b.id, 'review'));

    // The fake agent writes the same notes.md for both cards, so B adds no commit of its own; A's is merged in.
    const log = await git(repo, ['log', '--format=%s', store.getCard(b.id)!.branch!]);
    assert.match(log, /First part/);
    assert.ok(routedEvents(store, b.id).length === 1);
  } finally {
    await close();
  }
});

test('a card waits for its previous pool, then is re-routed when that pool stays halted', async () => {
  const { store, limiter, scheduler, board, close } = await setup();
  try {
    store.updateSettings(board.id, { rerouteAfterSec: 1 });
    const card = store.createCard({ boardId: board.id, title: 'Sticky' });
    store.updateCard(card.id, { poolId: 'fa' }); // ran on fa before
    limiter.force('fa', 96);
    scheduler.start();
    const t0 = Date.now();
    store.updateCard(card.id, { status: 'ready' });
    await waitFor(store, (e) => e.type === 'card.routed' && e.subject === card.id);
    const elapsed = Date.now() - t0;
    const [routed] = routedEvents(store, card.id);
    assert.equal(routed.poolId, 'fb');
    assert.equal(routed.rerouted, true);
    assert.equal(routed.from, 'fa');
    assert.ok(elapsed >= 900, `re-routed after ${elapsed} ms`);
  } finally {
    await close();
  }
});

test('tree tools: worker role refused, fan-out cap enforced, cycles refused', async () => {
  const { store, runner, board, close } = await setup();
  try {
    const worker = store.createCard({
      boardId: board.id,
      title: 'Worker',
      description: 'CALL create_subtask {"title":"Sneaky","description":"x","acceptance_criteria":["y"]}',
    });
    let done = waitFor(store, status(store, worker.id, 'review'));
    await runner.run(worker.id, 'fa');
    await done;
    assert.match(store.eventsFor(worker.id).map((e) => JSON.stringify(e.payload)).join(), /may not create cards/);

    store.updateSettings(board.id, { maxChildren: 1 });
    const orch = store.createCard({
      boardId: board.id,
      title: 'Plan',
      role: 'orchestrator',
      description: [
        'CALL create_subtask {"title":"One","description":"x","acceptance_criteria":["y"]}',
        'CALL create_subtask {"title":"Two","description":"x","acceptance_criteria":["y"]}',
      ].join('\n'),
    });
    done = waitFor(store, status(store, orch.id, 'review'));
    await runner.run(orch.id, 'fa');
    await done;
    assert.deepEqual(store.children(orch.id).map((c) => c.title), ['One']);
    assert.match(store.eventsFor(orch.id).map((e) => JSON.stringify(e.payload)).join(), /already has 1 children/);
  } finally {
    await close();
  }
});

test('spec lint sends a vague agent-written card back to its creator; narration is written', async () => {
  const { store, scheduler, board, close } = await setup({ lane: laneStub() });
  try {
    scheduler.start();
    const goal = await scheduler.startGoal(
      board.id,
      'Plan things',
      [
        'CALL create_subtask {"title":"VAGUE improve stuff","description":"make it better","acceptance_criteria":["better"]}',
        'CALL create_subtask {"title":"Clear task","description":"Create TODO.md","acceptance_criteria":["file exists"]}',
      ].join('\n'),
    );
    const clear = (await allReviewed(store, board.id, (c) => c.title === 'Clear task'))[0]!;
    const vague = store.listCards(board.id).find((c) => c.title.startsWith('VAGUE'))!;
    const deadline = Date.now() + 10_000;
    while (store.getCard(vague.id)!.status !== 'backlog' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.equal(store.getCard(vague.id)!.status, 'backlog');
    assert.match(store.getCard(vague.id)!.narration ?? '', /Spec sent back: No clear scope/);
    const toOrch = store.boardMessages(board.id).find((m) => m.toCard === goal.id && m.fromActor === 'daemon:spec-lint');
    assert.match(toOrch?.body ?? '', /was sent back before assignment: No clear scope\. Fix it with update_subtask/);
    assert.equal(store.getCard(clear.id)!.narration, 'Working through the card');
  } finally {
    await close();
  }
});

test('a card refused a leased file is told when the lease is released', async () => {
  const { store, runner, board, close } = await setup();
  try {
    const holder = store.createCard({ boardId: board.id, title: 'Holder' });
    reservePaths(store, board.id, holder.id, ['notes.md']);
    const waiter = store.createCard({ boardId: board.id, title: 'Waiter' });
    await runner.run(waiter.id, 'fa');
    await waitFor(store, status(store, waiter.id, 'review'));
    assert.equal(existsSync(join(store.getCard(waiter.id)!.worktree!, 'notes.md')), false);

    const woken = waitFor(store, (e) => e.type === 'message.delivered' && e.subject === waiter.id);
    store.releaseLeases(holder.id);
    await woken;
    await waitFor(store, status(store, waiter.id, 'review'));
    assert.ok(existsSync(join(store.getCard(waiter.id)!.worktree!, 'notes.md')));
    assert.ok(store.boardMessages(board.id).some((m) => m.toCard === waiter.id && /notes\.md is no longer reserved/.test(m.body)));
  } finally {
    await close();
  }
});

test('a silently stalled turn is cancelled, its pool locked, and the card re-routed with its work kept', async () => {
  const { store, runner, limiter, scheduler, board, close } = await setup();
  try {
    store.updateSettings(board.id, { scarcity: { fa: 1, fb: 0.5 } });
    const card = store.createCard({ boardId: board.id, title: 'SLOW stalls on its first pool' });
    scheduler.start();
    const started = waitFor(store, (e) => e.subject === card.id && e.type === 'session.event' && /prompt:/.test((e.payload as any).event.text ?? ''));
    store.updateCard(card.id, { status: 'ready' });
    await started;
    assert.equal(store.getCard(card.id)!.poolId, 'fa');

    const rerouted = waitFor(store, (e) => e.type === 'card.routed' && e.subject === card.id && (e.payload as any).poolId === 'fb');
    runner.checkStalls(Date.now() + 6 * 60_000); // as if 6 minutes passed without activity
    await rerouted;
    const fa = limiter.status('fa');
    assert.equal(fa.state, 'locked');
    assert.ok(Math.abs(fa.lockedUntil! - Date.now() - 10 * 60_000) < 5000, 'locked for 10 minutes');
    assert.ok(store.eventsFor(card.id).some((e) => e.type === 'session.event' && /Stalled: locking Fake A for 10 minutes/.test((e.payload as any).event.message ?? '')));
    assert.deepEqual(store.listSessions(card.id).map((s) => s.state).slice(0, 1), ['failed']);

    // The second agent is told an earlier session stopped; the card finishes on the other pool.
    await waitFor(store, status(store, card.id, 'review'), 20_000);
    const prompts = store.eventsFor(card.id).filter((e) => e.type === 'session.event' && (e.payload as any).event.role === 'user');
    assert.match((prompts[prompts.length - 1]!.payload as any).event.text, /An earlier session on fa stopped before finishing/);
    assert.equal(store.getCard(card.id)!.poolId, 'fb');
  } finally {
    await close();
  }
});

test('observed lockouts: pattern and lock duration', () => {
  assert.ok(LOCKOUT_PATTERN.test('Error 429: Too Many Requests'));
  assert.ok(LOCKOUT_PATTERN.test('You have reached your usage limit. Try again in 2 hours.'));
  assert.ok(!LOCKOUT_PATTERN.test('TypeError: x is undefined'));
  assert.equal(lockoutUntil('try again in 2 hours', 0), 2 * 3_600_000);
  assert.equal(lockoutUntil('resets in 30 minutes', 0), 30 * 60_000);
  assert.equal(lockoutUntil('quota exhausted', 0), 15 * 60_000);
});
