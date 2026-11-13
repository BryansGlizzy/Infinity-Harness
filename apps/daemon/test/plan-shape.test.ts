// Plan shape (parallelism of the cards a planner creates) and the planning prompt's guidance on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planHint, planShape } from '../src/plan-shape.ts';
import { buildOrchestratorPrompt } from '../src/runner.ts';
import { setup, status, waitFor } from './harness.ts';

const dep = (cardId: string, blockedBy: string) => ({ cardId, blockedBy });

test('planShape counts waves, width and the longest chain', () => {
  // The real plan from a past run: scaffold → two ports → validation → two more → two UIs → parity review.
  const ids = ['s', 'a', 'b', 'v', 'i', 'g', 'gui', 'cli', 'r'];
  const shape = planShape(ids, [dep('a', 's'), dep('b', 's'), dep('v', 'a'), dep('v', 'b'), dep('i', 'v'), dep('g', 'v'), dep('gui', 'i'), dep('gui', 'g'), dep('cli', 'i'), dep('cli', 'g'), dep('r', 'gui'), dep('r', 'cli')]);
  assert.equal(shape.cards, 9);
  assert.equal(shape.waves, 6);
  assert.equal(shape.widest, 2);
  assert.equal(shape.criticalPath.length, 6);
  assert.equal(shape.criticalPath[0], 's');
  assert.equal(shape.criticalPath.at(-1), 'r');

  const flat = planShape(['a', 'b', 'c', 'd'], [dep('d', 'a'), dep('d', 'b'), dep('d', 'c')]);
  assert.deepEqual([flat.waves, flat.widest], [2, 3]);
  assert.deepEqual(planShape([], []), { cards: 0, waves: 0, widest: 0, criticalPath: [] });
  assert.equal(planShape(['a', 'b'], [dep('b', 'outside')]).waves, 1, 'edges leaving the set are ignored');
});

test('planHint nudges a chain only when the board could run cards side by side', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const chain = planShape(ids, [dep('b', 'a'), dep('c', 'b'), dep('d', 'c'), dep('e', 'd')]);
  const title = (id: string) => `card ${id}`;
  const hint = planHint(chain, 4, title);
  assert.ok(hint);
  assert.match(hint!, /5 cards .* 5 waves/);
  assert.match(hint!, /"card a" → "card b" → "card c" → "card d" → "card e"/);
  assert.equal(planHint(chain, 1, title), null, 'one lane: a chain costs nothing extra');
  assert.equal(planHint(planShape(['a', 'b', 'c'], [dep('b', 'a'), dep('c', 'b')]), 4, title), null, 'too small to matter');
  const wide = planShape(ids, [dep('e', 'a'), dep('e', 'b'), dep('e', 'c'), dep('e', 'd')]);
  assert.equal(planHint(wide, 4, title), null, 'a wide plan with one final card is fine');
});

test('the planning prompt tells the orchestrator how wide it can go and how to cut for parallel work', () => {
  const card = { id: 'c_1', title: 'Goal', description: '', role: 'orchestrator' } as any;
  const board = { name: 'B', mode: 'worktree' } as any;
  const wide = buildOrchestratorPrompt(card, board, '/w', { maxChildren: 12, maxDepth: 5, parallel: 7 });
  assert.match(wide, /Up to 7 cards run at the same time/);
  assert.match(wide, /Cut by module, file or layer, not by step/);
  assert.match(wide, /blocked_by means "cannot start without/);
  assert.match(wide, /Create the cards that have no blocked_by first/);
  const narrow = buildOrchestratorPrompt(card, board, '/w', { maxChildren: 12, maxDepth: 5, parallel: 1 });
  assert.match(narrow, /runs one card at a time/);
  assert.doesNotMatch(buildOrchestratorPrompt(card, board, '/w', { maxChildren: 12, maxDepth: 5 }), /Up to \d+ cards run/);
});

test('the board reports how many cards it runs at once', async () => {
  const { store, runner, close } = await setup();
  try {
    const board = store.createBoard({ name: 'Wide', repoPath: mkdtempSync(join(tmpdir(), 'ih-par-')), defaultBranch: '', mode: 'direct' });
    assert.equal(runner.parallelism(board.id), 3, 'direct boards: the folder limit, 3 by default');
    store.updateSettings(board.id, { directParallel: 1 });
    assert.equal(runner.parallelism(board.id), 1);
    const git = store.createBoard({ name: 'Git', repoPath: mkdtempSync(join(tmpdir(), 'ih-par-')), defaultBranch: 'main' });
    store.updateSettings(git.id, { poolSlots: { fa: 2, fb: 3 }, agents: [{ id: 'w1', poolId: 'fa', model: '', role: 'worker', delegatesTo: [], enabled: true }, { id: 'w2', poolId: 'fb', model: '', role: 'worker', delegatesTo: [], enabled: true }, { id: 'w3', poolId: 'fb', model: 'x', role: 'worker', delegatesTo: [], enabled: false }] });
    assert.equal(runner.parallelism(git.id), 5, 'slots of each pool with an enabled worker, counted once per pool');
  } finally {
    await close();
  }
});

test('create_subtask tells the planner how its plan runs', async () => {
  const { store, board, scheduler, close } = await setup();
  try {
    scheduler.start();
    const goal = await scheduler.startGoal(
      board.id,
      'Two pieces',
      [
        'CALL create_subtask {"title":"Piece one","description":"files a/","acceptance_criteria":["ok"]}',
        'CALL create_subtask {"title":"Piece two","description":"files b/","acceptance_criteria":["ok"]}',
      ].join('\n'),
    );
    await waitFor(store, status(store, goal.id, 'review'));
    const text = store
      .eventsFor(goal.id)
      .filter((e) => e.type === 'session.event')
      .map((e) => (e.payload as any).event)
      .filter((h) => h.type === 'message')
      .map((h) => h.text)
      .join('\n');
    assert.match(text, /"plan": "1 card in 1 wave, widest wave 1"/);
    assert.match(text, /"plan": "2 cards in 1 wave, widest wave 2"/);
    assert.doesNotMatch(text, /plan_hint/, 'two parallel cards need no nudge');
  } finally {
    await close();
  }
});
