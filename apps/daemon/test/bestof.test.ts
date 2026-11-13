// Phase 6.5: best-of-N. A big card is raced by several agents; Kev picks the winner; the losers are discarded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { slugify } from '@ih/core';
import type { AgentProfile } from '@ih/core';
import { KevClient } from '@ih/router';
import { git } from '../src/git.ts';
import { setup, waitFor } from './harness.ts';

const agent = (id: string, poolId: string, model = ''): AgentProfile => ({ id, poolId, model, role: 'worker', delegatesTo: [], enabled: true });

/** Kev: classifies everything as a complexity-1.2 bugfix, and scores a change higher when its diff says fake/two. */
const kev = new KevClient({
  url: 'http://kev',
  model: 'kev-9b',
  fetch: (async (_url: string, init: RequestInit) => {
    const body = String(init.body);
    if (body.includes('in_scope')) {
      const better = body.includes('written by fake/two');
      return new Response(JSON.stringify({ answers: { quality: { score: better ? 4 : 2 }, in_scope: { noul: 0.9 } } }));
    }
    return new Response(
      JSON.stringify({
        answers: {
          work_type: { type: 'noul', noul: 0.8, choice: 'bugfix', probabilities: { bugfix: 0.8 } },
          complexity: { type: 'score', score: 1.2, probabilities: { 1: 0.8 } },
          needs_review: { type: 'noul', noul: 0.2 },
        },
      }),
    );
  }) as typeof fetch,
});

const BASE = { agents: [agent('fa', 'fa', 'fake/one'), agent('fb', 'fb', 'fake/two')], crossReview: false, testCommand: 'test -f notes.md', landMode: 'local' as const };

async function until(check: () => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('best-of-N: two agents race a card, Kev picks the better diff, the loser is discarded and dependents follow the winner', async () => {
  const { store, scheduler, refinery, bestOf, board, repo, cfg, close } = await setup({ kev });
  try {
    store.updateSettings(board.id, { ...BASE, bestOfN: { enabled: true, n: 2, minComplexity: 1 } });
    const card = store.createCard({ boardId: board.id, title: 'Notes', status: 'ready' });
    const after = store.createCard({ boardId: board.id, title: 'After notes', status: 'ready' });
    store.addDependency(after.id, card.id);
    scheduler.start();
    bestOf.start();
    refinery.start();

    await until(() => store.listCards(board.id).filter((c) => c.pipeline.bestOf).length === 2);
    const group = store.listCards(board.id).filter((c) => c.pipeline.bestOf);
    assert.deepEqual(group.map((c) => c.title).sort(), ['Notes', 'Notes (candidate 2)']);
    assert.deepEqual(group.map((c) => c.pipeline.bestOf!.candidate).sort(), [1, 2]);
    assert.ok(group.every((c) => c.pipeline.bestOf!.group === card.id && c.pipeline.bestOf!.of === 2));
    assert.deepEqual(store.blockers(group.find((c) => c.id !== card.id)!.id).map((c) => c.id), [], 'the clone copies the original’s dependencies (none here)');

    // The dependent waits for the judgement, not for the first candidate to reach Review.
    await until(() => group.every((c) => ['review', 'merging', 'done'].includes(store.getCard(c.id)!.status)) || store.getCard(card.id)!.pipeline.bestOf?.state !== 'running');
    // Both ran, on different agents.
    const ranOn = group.map((c) => store.listSessions(c.id)[0]!.poolId).sort();
    assert.deepEqual(ranOn, ['fa', 'fb']);

    // The judgement: fb's change scores higher.
    await until(() => store.listCards(board.id).some((c) => c.pipeline.bestOf?.state === 'won'));
    const won = store.listCards(board.id).find((c) => c.pipeline.bestOf?.state === 'won')!;
    const lost = store.listCards(board.id).find((c) => c.pipeline.bestOf?.state === 'lost')!;
    assert.equal(won.poolId, 'fb');
    assert.equal(lost.poolId, 'fa');
    assert.ok(won.pipeline.bestOf!.score! > lost.pipeline.bestOf!.score!);
    const judged = store.eventsFor(won.id).find((e) => (e.payload as any).step === 'best_of_judged')!.payload as any;
    assert.equal(judged.winner, won.id);

    // The loser: done, no branch, no worktree, its branch deleted; a low outcome is recorded for its agent.
    await until(() => store.getCard(lost.id)!.status === 'done' && store.getCard(lost.id)!.branch === null);
    const dir = join(cfg.worktreesDir, board.id, lost.id);
    const branch = `ih/${slugify(lost.title)}-${lost.id.slice(-4)}`;
    assert.equal(existsSync(dir), false, 'its worktree is gone');
    assert.equal((await git(repo, ['branch', '--list', branch])).trim(), '', 'and its branch');
    assert.ok(store.listSessions(lost.id).length > 0, 'it did run');
    assert.ok(store.outcomesFor(lost.id).some((o) => o.note === 'lost a best-of-N' && o.agentId === 'fa'));

    // The winner goes through the usual landing; the dependent follows the winner, not the original.
    await until(() => store.getCard(won.id)!.status === 'done' && !!store.getCard(won.id)!.pipeline.landedSha);
    assert.deepEqual(store.blockers(after.id).map((c) => c.id), [won.id]);
    await until(() => store.getCard(after.id)!.status === 'done', 40_000);
    assert.deepEqual((await git(repo, ['log', '--first-parent', '--format=%s', 'main'])).split('\n').slice(-2), ['Notes', 'init'].map((s, i) => (i === 0 ? store.getCard(won.id)!.title : s)));
  } finally {
    await close();
  }
});

test('best-of-N is off by default, and a card only one agent can take is not raced', async () => {
  const { store, scheduler, bestOf, board, close } = await setup({ kev });
  try {
    store.updateSettings(board.id, { ...BASE });
    const a = store.createCard({ boardId: board.id, title: 'Off by default', status: 'ready' });
    scheduler.start();
    bestOf.start();
    await waitFor(store, (e) => e.type === 'card.updated' && e.subject === a.id && (e.payload as any).card.status === 'review');
    assert.equal(store.listCards(board.id).length, 1);
    assert.equal(store.getCard(a.id)!.pipeline.bestOf, undefined);

    store.updateSettings(board.id, { bestOfN: { enabled: true, n: 3, minComplexity: 1 } });
    const single = store.createCard({ boardId: board.id, title: 'Only fa', routing: { pools: ['fa'] }, status: 'ready' });
    await waitFor(store, (e) => e.type === 'card.updated' && e.subject === single.id && (e.payload as any).card.status === 'review');
    assert.equal(store.listCards(board.id).length, 2, 'no clones: a single eligible agent');

    // Below the complexity threshold nothing is raced either.
    store.updateSettings(board.id, { bestOfN: { enabled: true, n: 2, minComplexity: 3 } });
    const small = store.createCard({ boardId: board.id, title: 'Small', status: 'ready' });
    await waitFor(store, (e) => e.type === 'card.updated' && e.subject === small.id && (e.payload as any).card.status === 'review');
    assert.equal(store.listCards(board.id).length, 3);
  } finally {
    await close();
  }
});

test('a card still racing can’t be reviewed or landed by hand', async () => {
  const { store, refinery, board, close } = await setup({ kev });
  try {
    const card = store.createCard({ boardId: board.id, title: 'Racing', status: 'review' });
    store.updateCard(card.id, { branch: 'ih/x', pipeline: { bestOf: { group: card.id, candidate: 1, of: 2, state: 'running' } } });
    assert.throws(() => refinery.humanVerdict(card.id, 'approve', ''), /still racing/);
    assert.throws(() => refinery.landNow(card.id), /still racing/);
  } finally {
    await close();
  }
});
