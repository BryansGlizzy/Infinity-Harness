// The final summary: when a goal's last card is done, the orchestrator that planned it writes the report from what its cards reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Card, HarnessEvent } from '@ih/core';
import { buildChat } from '../src/chat.ts';
import { FinalSummary, buildSummaryPrompt } from '../src/final-summary.ts';
import { setup } from './harness.ts';

const card = (over: Partial<Card>): Card =>
  ({ id: 'c_1', boardId: 'b', parentId: null, title: 'T', description: '', status: 'done', role: 'worker', pipeline: {}, depth: 0, ...over }) as Card;

const goal = card({ id: 'c_goal', title: 'Port the CLI to Rust', description: 'Replace the Python tool.', role: 'orchestrator' });
const cards = [
  card({ id: 'c_a', parentId: 'c_goal', title: 'Port ssh config', agentId: 'kimi', narration: 'Wrote sshconfig.rs', pipeline: { landedSha: 'abcdef0123456789', prUrl: 'https://github.com/x/y/pull/3' } }),
  card({ id: 'c_b', parentId: 'c_goal', title: 'Build the GUI', status: 'review' }),
];
const SECTIONS = ['Outcome', 'What was done', 'How to run and verify it', 'Decisions and interfaces', 'Open issues and follow-ups', 'Reference documentation'];

test('the request is a report from what was submitted: no digging, every section, "not reported" instead of finding out', () => {
  const p = buildSummaryPrompt({ goal, cards, notes: [{ id: 'a_9', kind: 'contract' as const, title: 'Key store trait' }] });
  assert.match(p, /Every card under your goal is finished\. Write the final report now: it is your reply to this message\./);
  assert.match(p, /Do not read files, run commands, search, open notes or check anything again, and do not create cards or message anyone/);
  assert.match(p, /write "not reported" instead of finding out/);
  assert.doesNotMatch(p, /Check the repository|Use the board tools to fill in|trusting the cards|Verify that every path exists|git log --first-parent|do not edit files/i, 'nothing that sends it back through the project');
  assert.match(p, /Goal: Port the CLI to Rust/);
  assert.doesNotMatch(p, /Replace the Python tool/, 'in its own session it already has the goal text');
  assert.match(p, /Cards \(1 of 2 work cards done\)/);
  assert.match(p, /- c_a \[worker\] "Port ssh config": done, by kimi, landed abcdef0123, https:\/\/github.com\/x\/y\/pull\/3\. Wrote sshconfig\.rs/);
  assert.match(p, /a_9 \(contract\): Key store trait/);
  assert.doesNotMatch(p, /What each card reported/, 'it holds those reports in its conversation already');
  for (const section of SECTIONS) assert.match(p, new RegExp(`\\*\\*${section}\\*\\*`));
  assert.match(p, /Give them as reported; do not check that they exist/);
  assert.doesNotMatch(buildSummaryPrompt({ goal, cards, notes: [] }), /Decisions, contracts and findings/, 'no notes, no list');
});

test('a fresh orchestrator is given the cards\' own reports, trimmed, since it remembers nothing', () => {
  const reports = new Map([['c_a', `${'x'.repeat(5000)} FINISHED: wrote sshconfig.rs, ran cargo test, all passed.`]]);
  const p = buildSummaryPrompt({ goal, board: { name: 'Demo' }, cards, notes: [{ id: 'a_9', kind: 'decision' as const, title: 'Use serde', body: 'We use serde for\nall config.' }], reports });
  assert.match(p, /on the "Demo" board is finished/);
  assert.match(p, /Replace the Python tool/, 'it needs the goal text');
  assert.match(p, /What each card reported:\n\n### c_a "Port ssh config" \(kimi\)\n…/);
  assert.match(p, /FINISHED: wrote sshconfig\.rs, ran cargo test, all passed\./, 'the end of a report, where a card says what it finished, is kept');
  assert.ok(p.length < 12_000, 'a long report is cut, not pasted whole');
  assert.match(p, /We use serde for all config\./);
  assert.doesNotMatch(p, /"Build the GUI"[\s\S]*### c_b/, 'a card with no report gets no empty entry');
  assert.match(p, /Do not read files/);
});

test('a finished goal: its own orchestrator writes the report in its own session; no new card, no new session; filed once; humans told', async () => {
  const { store, scheduler, refinery, runner, context, board, close } = await setup();
  const summary = new FinalSummary({ store, context, runner });
  try {
    store.updateSettings(board.id, { crossReview: false, testCommand: 'test -f notes.md', landMode: 'local' });
    scheduler.start();
    refinery.start();
    summary.start();
    const g = await scheduler.startGoal(board.id, 'Add notes', 'CALL create_subtask {"title":"Write the notes","description":"Add notes.md","acceptance_criteria":["notes.md exists"]}');
    const reported = () => {
      const c = store.getCard(g.id)!;
      return c.pipeline.finalSummary?.pending === false && c.status === 'done';
    };
    const deadline = Date.now() + 40_000;
    while (!reported()) {
      if (Date.now() > deadline) throw new Error(`timed out: goal ${store.getCard(g.id)!.status}, ${JSON.stringify(store.getCard(g.id)!.pipeline.finalSummary)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    const roots = () => store.listCards(board.id).filter((c) => !c.parentId && c.role === 'orchestrator');
    const done = store.getCard(g.id)!;
    assert.equal(roots().length, 1, 'no "Summary:" card was made');
    assert.equal(store.listSessions(g.id).length, 1, 'the orchestrator was not started over: it is the same session');
    assert.deepEqual({ cardId: done.pipeline.finalSummary!.cardId, cards: done.pipeline.finalSummary!.cards }, { cardId: g.id, cards: 1 });

    // It was asked in its own conversation, with the request and not the planning prompt again.
    const asked = store.eventsFor(g.id).map((e) => (e.type === 'session.event' ? (e.payload as { event: HarnessEvent }).event : null)).filter((h) => h?.type === 'message' && h.role === 'user').map((h) => (h as { text: string }).text);
    assert.equal(asked.length, 2, 'the planning prompt, then the report request');
    assert.match(asked[1]!, /Every card under your goal is finished\. Write the final report now/);
    assert.match(asked[1]!, /Do not read files/);

    // Filed on the goal, the humans told once, with a way to the card.
    const report = store.listArtifacts(board.id, { cardIds: [g.id], kinds: ['summary'] }).find((a) => a.title === 'Final summary: Add notes');
    assert.ok(report && report.author === 'daemon:summary');
    const told = store.boardMessages(board.id).filter((m) => m.fromActor === 'daemon:summary');
    assert.equal(told.length, 1);
    assert.match(told[0]!.body, new RegExp(`Final summary ready for "Add notes" \\(${g.id}\\): it is the last message on that card`));
    assert.ok(buildChat(store, g.id).some((i) => i.kind === 'note' && /Final summary ready for "Add notes"/.test(i.text)), 'the goal chat shows the notice too');

    // Not again for the same cards, though the card went Done twice; and not at all when switched off.
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(store.boardMessages(board.id).filter((m) => m.fromActor === 'daemon:summary').length, 1);
    assert.equal(store.listSessions(g.id).length, 1);
    store.updateSettings(board.id, { finalSummary: false });
    const second = await scheduler.startGoal(board.id, 'Add more notes', 'CALL create_subtask {"title":"More notes","description":"Add more.md","acceptance_criteria":["exists"]}');
    const stop = Date.now() + 25_000;
    while (store.getCard(second.id)!.status !== 'done') {
      if (Date.now() > stop) throw new Error('second goal did not finish');
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(store.boardMessages(board.id).filter((m) => m.fromActor === 'daemon:summary').length, 1, 'switched off: no summary for the second goal');
    assert.equal(store.listSessions(second.id).length, 1);
  } finally {
    summary.stop();
    await close();
  }
});

async function stubbed(runner: object, over: object = {}) {
  const ctx = await setup();
  const g = ctx.store.createCard({ boardId: ctx.board.id, title: 'Port it', description: 'Port the tool.', role: 'orchestrator', status: 'in_progress' });
  ctx.store.updateCard(g.id, { poolId: 'fa', agentId: 'orchestrator' });
  const child = ctx.store.createCard({ boardId: ctx.board.id, title: 'Write A', parentId: g.id, role: 'worker', status: 'done' });
  ctx.store.append('session.event', child.id, { sessionId: 's', event: { type: 'message', role: 'agent', text: 'Wrote a.md; ran test -f a.md and it passed.' } }, 'agent:kimi');
  const fs = new FinalSummary({ store: ctx.store, context: ctx.context, runner: runner as never, waitMs: 5, ...over });
  fs.start();
  return { ...ctx, g, child, fs };
}
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(ok(), 'timed out');
};

test('when the orchestrator\'s session is gone, the same goal card runs again with its cards\' reports; still no new card', async () => {
  const calls: { id: string; pool: string; opts: { agentId?: string; prompt?: string } }[] = [];
  const ctx = await stubbed({ sessionState: () => null, promptIdle: () => false, run: async (id: string, pool: string, opts: never) => void calls.push({ id, pool, opts }) });
  try {
    ctx.store.updateCard(ctx.g.id, { status: 'done' });
    await until(() => calls.length === 1);
    assert.equal(calls[0]!.id, ctx.g.id, 'the goal card itself');
    assert.deepEqual([calls[0]!.pool, calls[0]!.opts.agentId], ['fa', 'orchestrator'], 'the agent that planned it');
    assert.match(calls[0]!.opts.prompt!, /Wrote a\.md; ran test -f a\.md and it passed\./, 'what the card reported is in the prompt');
    assert.match(calls[0]!.opts.prompt!, /Port the tool\./);
    assert.match(calls[0]!.opts.prompt!, /Do not read files/);
    assert.equal(ctx.store.listCards(ctx.board.id).length, 2, 'goal and its card only');
    assert.equal(ctx.store.getCard(ctx.g.id)!.pipeline.finalSummary!.pending, true, 'the end of that turn will be taken as the report');
  } finally {
    ctx.fs.stop();
    await ctx.close();
  }
});

test('a session still busy with something else is waited for, then asked in its own conversation', async () => {
  const states = ['busy', 'starting', 'idle'];
  let looks = 0;
  const prompts: string[] = [];
  let ran = 0;
  const ctx = await stubbed({ sessionState: () => states[Math.min(looks++, 2)], promptIdle: (_id: string, p: string) => (prompts.push(p), true), run: async () => void ran++ });
  try {
    ctx.store.updateCard(ctx.g.id, { status: 'done' });
    await until(() => prompts.length === 1);
    assert.equal(ran, 0, 'its own session was used');
    assert.match(prompts[0]!, /Write the final report now/);
    assert.doesNotMatch(prompts[0]!, /What each card reported/);
  } finally {
    ctx.fs.stop();
    await ctx.close();
  }
});

test('a report that cannot be started is said plainly, and nothing is left waiting', async () => {
  const ctx = await stubbed({ sessionState: () => null, promptIdle: () => false, run: async () => Promise.reject(new Error('budget used up')) });
  try {
    ctx.store.updateCard(ctx.g.id, { status: 'done' });
    await until(() => ctx.store.boardMessages(ctx.board.id).some((m) => /Could not start the final summary for "Port it".*budget used up/.test(m.body)));
    assert.equal(ctx.store.getCard(ctx.g.id)!.pipeline.finalSummary!.pending, false);
  } finally {
    ctx.fs.stop();
    await ctx.close();
  }
});

test('when the report turn ends, the last message is filed; a turn with no reply is reported without suggesting a re-plan', async () => {
  const ctx = await stubbed({ sessionState: () => 'idle', promptIdle: () => true, run: async () => ({}) });
  try {
    ctx.store.updateCard(ctx.g.id, { status: 'done' });
    await until(() => ctx.store.getCard(ctx.g.id)!.pipeline.finalSummary?.pending === true);
    ctx.store.append('session.event', ctx.g.id, { sessionId: 's', event: { type: 'message', role: 'agent', text: '## Outcome\nIt worked.' } }, 'agent:orchestrator');
    ctx.store.updateCard(ctx.g.id, { status: 'review' });
    await until(() => ctx.store.getCard(ctx.g.id)!.pipeline.finalSummary?.pending === false);
    assert.ok(ctx.store.listArtifacts(ctx.board.id, { cardIds: [ctx.g.id], kinds: ['summary'] }).some((a) => a.title === 'Final summary: Port it' && /It worked\./.test(a.body)));

    const other = await stubbed({ sessionState: () => 'idle', promptIdle: () => true, run: async () => ({}) });
    try {
      other.store.updateCard(other.g.id, { status: 'done' });
      await until(() => other.store.getCard(other.g.id)!.pipeline.finalSummary?.pending === true);
      other.store.updateCard(other.g.id, { status: 'blocked' });
      await until(() => other.store.boardMessages(other.board.id).some((m) => /could not be written/.test(m.body)));
      const msg = other.store.boardMessages(other.board.id).find((m) => /could not be written/.test(m.body))!;
      assert.match(msg.body, /Send the goal card a message asking for the report/);
      assert.doesNotMatch(msg.body, /press Run/i, 'Run on a goal card would plan it again and duplicate its cards');
    } finally {
      other.fs.stop();
      await other.close();
    }
  } finally {
    ctx.fs.stop();
    await ctx.close();
  }
});
