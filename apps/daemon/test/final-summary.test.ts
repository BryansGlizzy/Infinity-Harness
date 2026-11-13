// The final summary: when a goal's cards are all done, the orchestrator writes the report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Card, HarnessEvent } from '@ih/core';
import { buildChat } from '../src/chat.ts';
import { FinalSummary, buildSummaryPrompt } from '../src/final-summary.ts';
import { setup } from './harness.ts';

const card = (over: Partial<Card>): Card =>
  ({ id: 'c_1', boardId: 'b', parentId: null, title: 'T', description: '', status: 'done', role: 'worker', pipeline: {}, depth: 0, ...over }) as Card;

test('the summary prompt carries the digest and asks for each section, adapting to direct boards', () => {
  const goal = card({ id: 'c_goal', title: 'Port the CLI to Rust', description: 'Replace the Python tool.', role: 'orchestrator' });
  const cards = [
    card({ id: 'c_a', parentId: 'c_goal', title: 'Port ssh config', agentId: 'kimi', narration: 'Wrote sshconfig.rs', pipeline: { landedSha: 'abcdef0123456789', prUrl: 'https://github.com/x/y/pull/3' } }),
    card({ id: 'c_b', parentId: 'c_goal', title: 'Build the GUI', status: 'review' }),
  ];
  const notes = [{ id: 'a_9', kind: 'contract' as const, title: 'Key store trait' }];
  const worktree = buildSummaryPrompt({ goal, board: { name: 'Demo', mode: 'worktree', repoPath: '/repo' } as any, cards, notes });
  assert.match(worktree, /Goal: Port the CLI to Rust/);
  assert.match(worktree, /Cards \(1 of 2 work cards done\)/);
  assert.match(worktree, /- c_a \[worker\] "Port ssh config": done, by kimi, landed abcdef0123, https:\/\/github.com\/x\/y\/pull\/3\. Wrote sshconfig\.rs/);
  assert.match(worktree, /a_9 \(contract\): Key store trait/);
  assert.match(worktree, /git log --first-parent/);
  for (const section of ['Outcome', 'What was done', 'How to run and verify it', 'Decisions and interfaces', 'Open issues and follow-ups', 'Reference documentation']) assert.match(worktree, new RegExp(`\\*\\*${section}\\*\\*`));
  assert.match(worktree, /Verify that every path exists before you list it/);
  assert.match(worktree, /Do not edit files/);
  assert.match(worktree, /\n\nCards \(/, 'sections are separated by blank lines');
  const direct = buildSummaryPrompt({ goal, board: { name: 'Demo', mode: 'direct', repoPath: '/proj' } as any, cards, notes: [] });
  assert.match(direct, /The project folder is \/proj/);
  assert.doesNotMatch(direct, /git log --first-parent/);
  assert.doesNotMatch(direct, /Decisions, contracts and findings/, 'no notes, no list');
});

test('a finished goal gets its final summary once: a card, a report on the goal, a message for the humans', async () => {
  const { store, scheduler, refinery, context, board, close } = await setup();
  const summary = new FinalSummary({ store, context, startTask: (b, t, d, p) => scheduler.startTask(b, t, d, p) });
  try {
    store.updateSettings(board.id, { crossReview: false, testCommand: 'test -f notes.md', landMode: 'local' });
    scheduler.start();
    refinery.start();
    summary.start();
    const goal = await scheduler.startGoal(
      board.id,
      'Add notes',
      'CALL create_subtask {"title":"Write the notes","description":"Add notes.md","acceptance_criteria":["notes.md exists"]}',
    );
    const roots = () => store.listCards(board.id).filter((c) => !c.parentId && c.role === 'orchestrator');
    const deadline = Date.now() + 40_000;
    while (!(store.getCard(goal.id)!.pipeline.finalSummary && roots().find((c) => c.pipeline.summaryOf)?.status === 'done')) {
      if (Date.now() > deadline) throw new Error(`timed out: goal ${store.getCard(goal.id)!.status}, roots ${roots().map((c) => c.status)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    const done = store.getCard(goal.id)!;
    assert.equal(done.status, 'done');
    const task = roots().find((c) => c.pipeline.summaryOf)!;
    assert.equal(task.pipeline.summaryOf, goal.id);
    assert.equal(done.pipeline.finalSummary!.cardId, task.id);
    assert.equal(done.pipeline.finalSummary!.cards, 1);
    assert.match(task.title, /^Summary: Add notes/);

    // The orchestrator was given the digest, not left to find the work.
    const prompt = store.eventsFor(task.id).map((e) => (e.type === 'session.event' ? (e.payload as { event: HarnessEvent }).event : null)).find((h) => h?.type === 'message' && h.role === 'user');
    assert.match((prompt as { text: string }).text, /Every card under your goal is finished/);
    assert.ok(store.getSettings(board.id).finalSummary);

    // Filed on the goal, and the humans were told, with a way to the card.
    const report = store.listArtifacts(board.id, { cardIds: [goal.id], kinds: ['summary'] }).find((a) => a.title === 'Final summary: Add notes');
    assert.ok(report && report.author === 'daemon:summary');
    const told = store.boardMessages(board.id).filter((m) => m.fromActor === 'daemon:summary');
    assert.equal(told.length, 1);
    assert.match(told[0]!.body, new RegExp(`Final summary ready for "Add notes": open card ${task.id}`));

    // The goal's conversation (the VS Code chat) shows the notice too, since it names the goal.
    assert.ok(buildChat(store, goal.id).some((i) => i.kind === 'note' && /Final summary ready for "Add notes"/.test(i.text)), 'in the goal chat');

    // Not again for the same cards (the summary card itself is not a goal), and not at all when switched off.
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(roots().filter((c) => c.pipeline.summaryOf).length, 1);
    store.updateSettings(board.id, { finalSummary: false });
    const second = await scheduler.startGoal(board.id, 'Add more notes', 'CALL create_subtask {"title":"More notes","description":"Add more.md","acceptance_criteria":["exists"]}');
    const stop = Date.now() + 25_000;
    while (store.getCard(second.id)!.status !== 'done') {
      if (Date.now() > stop) throw new Error('second goal did not finish');
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(roots().filter((c) => c.pipeline.summaryOf).length, 1, 'switched off: no summary for the second goal');
  } finally {
    summary.stop();
    await close();
  }
});
