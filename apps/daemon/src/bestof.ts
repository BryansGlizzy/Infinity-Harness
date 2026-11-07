import type { Board, Card } from '@mh/core';
import { outcomeValue } from '@mh/core';
import type { Store } from '@mh/db';
import { trimInput } from '@mh/fast-lane';
import type { KevClient } from '@mh/router';
import { currentArtifact } from './context.ts';
import { branchDiff, removeWorktree } from './git.ts';
import type { Runner } from './runner.ts';
import type { Scheduler } from './scheduler.ts';

// Best-of-N (master plan §5.4 step 9, Phase 6.5). Off by default. A big worker card is worked by 2–3 agents at once, each
// on its own branch; when all have finished, Kev scores their diffs against the card's criteria and the best one goes on
// to review and landing. The others are discarded. Candidates are sibling cards sharing a `bestOf.group`.

const TICK_MS = 1500;
const MAX_N = 3;

/** Statuses in which a candidate has stopped working (done racing). */
const SETTLED = new Set(['review', 'merging', 'done', 'blocked']);

export interface BestOfDeps {
  store: Store;
  runner: Runner;
  scheduler: Scheduler;
  kev?: KevClient | null;
  tickMs?: number;
}

export class BestOf {
  private deps: BestOfDeps;
  private timer: NodeJS.Timeout | null = null;
  private judging = new Set<string>();

  constructor(deps: BestOfDeps) {
    this.deps = deps;
  }

  start() {
    this.timer = setInterval(() => void this.tick(), this.deps.tickMs ?? TICK_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Called by the scheduler for a ready, classified worker card. When best-of-N applies, clones the card into N
   * candidates (this one is candidate 1) and returns true; the scheduler then routes each candidate in turn.
   */
  intercept(card: Card): boolean {
    const { store, scheduler } = this.deps;
    const s = store.getSettings(card.boardId).bestOfN;
    if (!s?.enabled || card.pipeline.bestOf || card.agentId || card.worktree) return false;
    if ((card.classification?.complexity ?? 0) < s.minComplexity) return false;
    const n = Math.min(MAX_N, Math.max(2, Math.floor(s.n)));
    // Two candidates need two different agents that could take the card; otherwise it is just worked once.
    const eligible = scheduler.rank(card).filter((c) => c.eligible);
    if (new Set(eligible.map((c) => c.agentId)).size < 2) return false;
    const bestOf = { group: card.id, of: n, state: 'running' as const };
    store.updateCard(card.id, { pipeline: { ...card.pipeline, bestOf: { ...bestOf, candidate: 1 } } }, 'best-of');
    const blockers = store.blockers(card.id);
    for (let k = 2; k <= n; k++) {
      const clone = store.createCard({
        boardId: card.boardId,
        parentId: card.parentId,
        title: `${card.title} (candidate ${k})`,
        description: card.description,
        workType: card.workType,
        role: 'worker',
        routing: card.routing,
        grants: card.grants,
        status: 'backlog',
        createdBy: 'daemon:best-of',
      });
      store.updateCard(clone.id, { classification: card.classification, pipeline: { bestOf: { ...bestOf, candidate: k } } }, 'best-of');
      for (const b of blockers) store.addDependency(clone.id, b.id, 'best-of');
      store.updateCard(clone.id, { status: 'ready' }, 'best-of');
    }
    store.append('card.refinery', card.id, { step: 'best_of', detail: `running ${n} candidates in parallel` }, 'best-of');
    return true;
  }

  /** Agents the card's running siblings are on, so each candidate prefers a different agent. */
  siblingAgents(card: Card): string[] {
    const group = card.pipeline.bestOf?.group;
    if (!group) return [];
    return this.members(card.boardId, group)
      .filter((c) => c.id !== card.id && c.agentId)
      .map((c) => c.agentId!);
  }

  private members(boardId: string, group: string): Card[] {
    return this.deps.store.listCards(boardId).filter((c) => c.pipeline.bestOf?.group === group);
  }

  async tick() {
    const { store } = this.deps;
    for (const board of store.listBoards()) {
      const groups = new Set(store.listCards(board.id).filter((c) => c.pipeline.bestOf?.state === 'running').map((c) => c.pipeline.bestOf!.group));
      for (const group of groups) await this.judgeIfReady(board, group).catch((err: Error) => store.append('card.refinery', group, { step: 'error', message: `best-of: ${err.message}` }, 'best-of'));
    }
  }

  private async judgeIfReady(board: Board, group: string) {
    const { store, runner, kev } = this.deps;
    if (this.judging.has(group)) return;
    const racing = this.members(board.id, group).filter((c) => c.pipeline.bestOf?.state === 'running');
    if (!racing.length || racing.some((c) => !SETTLED.has(c.status) || runner.isActive(c.id))) return;
    const finished = racing.filter((c) => c.status === 'review' && c.branch);
    if (!finished.length) return; // every candidate is blocked or escalated: a human takes it from here
    this.judging.add(group);
    try {
      const settings = store.getSettings(board.id);
      const scored: { card: Card; score: number; size: number }[] = [];
      for (const card of finished) {
        const diff = await branchDiff(board.repoPath, board.defaultBranch, card.branch!).catch(() => '');
        let score = 0.5;
        if (kev && settings.kevOutcomeScoring) {
          try {
            const r = await kev.scoreOutcome({ title: card.title, description: card.description, diff: trimInput(diff, 9000), summary: currentArtifact(store, card, 'summary')?.body });
            score = r.quality * (r.inScope < 0.5 ? 0.7 : 1);
          } catch {
            // Kev unreachable: the candidates are told apart by size below.
          }
        }
        scored.push({ card, score, size: diff.length });
      }
      // Highest score wins; equal scores go to the smaller change.
      scored.sort((a, b) => b.score - a.score || a.size - b.size);
      const winner = scored[0]!.card;
      const original = this.members(board.id, group).find((c) => c.id === group) ?? winner;
      for (const { card, score } of scored) {
        const bo = card.pipeline.bestOf!;
        store.updateCard(card.id, { pipeline: { ...card.pipeline, bestOf: { ...bo, score: Math.round(score * 1000) / 1000, state: card.id === winner.id ? 'won' : 'lost' } } }, 'best-of');
      }
      // The racing candidates that didn't make it to Review (blocked) are out too.
      for (const card of racing.filter((c) => !finished.includes(c))) {
        store.updateCard(card.id, { pipeline: { ...card.pipeline, bestOf: { ...card.pipeline.bestOf!, state: 'lost' } }, status: 'done' }, 'best-of');
      }
      store.append(
        'card.refinery',
        winner.id,
        { step: 'best_of_judged', winner: winner.id, scores: Object.fromEntries(scored.map((x) => [x.card.agentId ?? x.card.id, Math.round(x.score * 100) / 100])) },
        'best-of',
      );
      // Dependents follow the winner, whichever candidate it was.
      if (winner.id !== original.id) store.moveDependents(original.id, winner.id);
      for (const { card, score } of scored.slice(1)) await this.discard(board, card, score);
    } finally {
      this.judging.delete(group);
    }
  }

  /** A loser: its session closes, its worktree and branch go, and the routing history learns from its score. */
  private async discard(board: Board, card: Card, score: number) {
    const { store, runner } = this.deps;
    if (runner.sessionState(card.id)) await runner.cancel(card.id);
    await removeWorktree(board.repoPath, card.worktree, card.branch);
    const session = store.listSessions(card.id).at(-1);
    if (card.agentId && card.poolId && session) {
      const base = { result: 'landed' as const, quality: score, inScope: null, changesRequested: card.pipeline.changesRequested ?? 0 };
      store.recordOutcome(
        {
          cardId: card.id,
          boardId: card.boardId,
          agentId: card.agentId,
          poolId: card.poolId,
          model: session.model,
          workType: card.classification?.workType ?? card.workType ?? 'feature',
          complexity: card.classification?.complexity ?? 2,
          ...base,
          testsPassed: null,
          value: outcomeValue(base),
          review: null,
          note: 'lost a best-of-N',
        },
        'best-of',
      );
    }
    // Branch and worktree are gone: nothing downstream may merge them.
    store.updateCard(card.id, { status: 'done', branch: null, worktree: null }, 'best-of');
  }
}
