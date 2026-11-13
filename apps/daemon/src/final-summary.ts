import type { Artifact, Board, Card, DaemonEvent } from '@ih/core';
import type { Store } from '@ih/db';
import type { ContextService } from '@ih/context';
import { lastAgentMessage } from './context.ts';

// When every card of a goal is done, the orchestrator reads what was built and writes the final report: what was done,
// how to check it, the decisions that matter, what is left, and the documentation that applies. The report is its last
// reply; the daemon files it on the goal and tells the humans.

export interface SummaryInput {
  goal: Card;
  board: Board;
  /** Everything under the goal. */
  cards: Card[];
  notes: Pick<Artifact, 'id' | 'kind' | 'title'>[];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The orchestrator's prompt for the final report. A digest to start from; the board tools hold the rest. */
export function buildSummaryPrompt({ goal, board, cards, notes }: SummaryInput): string {
  const direct = board.mode === 'direct';
  const workers = cards.filter((c) => c.role === 'worker');
  const lines = cards
    .filter((c) => c.role === 'worker' || c.role === 'lead')
    .slice(0, 80)
    .map((c) => {
      const landed = c.pipeline.landedSha ? `, landed ${c.pipeline.landedSha.slice(0, 10)}` : '';
      const pr = c.pipeline.prUrl ? `, ${c.pipeline.prUrl}` : '';
      return `- ${c.id} [${c.role}] "${clip(c.title, 90)}": ${c.status}${c.agentId ? `, by ${c.agentId}` : ''}${landed}${pr}${c.narration ? `. ${clip(c.narration, 140)}` : ''}`;
    });
  return [
    `You are the orchestrator of the "${board.name}" board. Every card under your goal is finished, so you now write the final report.`,
    '',
    `Goal: ${goal.title}`,
    ...(goal.description ? ['', goal.description] : []),
    direct
      ? `The project folder is ${board.repoPath}; the cards' edits are in it. Read it, but do not edit files, run anything that changes it, or create cards.`
      : `The repository is checked out read-only for you, on the default branch with the landed work. Do not edit files, push, or create cards. \`git log --first-parent\` reads as one commit per card, and \`git show --stat <sha>\` lists what a card changed.`,
    '',
    `Cards (${workers.filter((c) => c.status === 'done').length} of ${workers.length} work cards done):`,
    ...lines,
    ...(notes.length ? ['', 'Decisions, contracts and findings recorded on the way (read with get_artifact):', ...notes.slice(0, 40).map((n) => `- ${n.id} (${n.kind}): ${clip(n.title, 100)}`)] : []),
    '',
    'Use the board tools to fill in what this digest leaves out: list_cards, get_artifact (each card left a summary and sometimes handoffs), search_context. Check the repository itself for what actually exists instead of trusting the cards\' own words.',
    '',
    'Your final reply is the report, in markdown, with these sections:',
    '1. **Outcome**: was the goal achieved? One honest paragraph, including anything it falls short on.',
    '2. **What was done**: by area, naming the files or modules and which cards (by title) did it.',
    '3. **How to run and verify it**: the exact commands, and which of them were actually run and passed (from the cards\' acceptance criteria and test results). Say so when something was not run.',
    '4. **Decisions and interfaces**: the choices and contracts later work must respect, with their artifact ids.',
    '5. **Open issues and follow-ups**: anything failed, skipped, risky, or waiting for a human.',
    '6. **Reference documentation**: the documentation that applies to this work. Files in the project that these cards wrote or updated (README, docs, API or usage notes) and others worth reading, each with its path and one line on what it covers; and external references the cards cited (specs, library docs, URLs), if any. Verify that every path exists before you list it. If nothing applies, write "None".',
    '',
    'Be specific and scannable, with no filler. If the goal was research or an answer rather than code, say what was found instead of what was built. Do not write anything outside the report.',
  ].join('\n');
}

export interface FinalSummaryDeps {
  store: Store;
  context: ContextService;
  /** Runs the orchestrator agent on a new card with this prompt (Scheduler.startTask). */
  startTask: (boardId: string, title: string, description: string, prompt: string) => Promise<Card>;
}

export class FinalSummary {
  private off: (() => void) | null = null;
  private starting = new Set<string>();
  private finished = new Set<string>();
  private deps: FinalSummaryDeps;

  constructor(deps: FinalSummaryDeps) {
    this.deps = deps;
  }

  start() {
    this.off = this.deps.store.onEvent((e) => this.onEvent(e));
  }

  stop() {
    this.off?.();
  }

  private onEvent(e: DaemonEvent) {
    if (e.type !== 'card.updated') return;
    const { patch, card } = e.payload as { patch: Partial<Card>; card: Card };
    if (!patch.status) return;
    if (card.pipeline.summaryOf) {
      if (patch.status === 'review' || patch.status === 'blocked') void this.finish(card.id).catch(() => {});
      return;
    }
    // A goal: a root orchestrator card whose cards are all done (a one-off task has no cards below it).
    if (patch.status === 'done' && card.role === 'orchestrator' && !card.parentId) void this.begin(card.id).catch(() => {});
  }

  private below(cardId: string): Card[] {
    const { store } = this.deps;
    const out: Card[] = [];
    const walk = (id: string) => {
      for (const c of store.children(id)) {
        out.push(c);
        walk(c.id);
      }
    };
    walk(cardId);
    return out;
  }

  /** The goal just finished: ask the orchestrator for the report (once, and again only if more cards finished since). */
  private async begin(goalId: string) {
    const { store, startTask } = this.deps;
    const goal = store.getCard(goalId);
    if (!goal || this.starting.has(goalId) || !store.getSettings(goal.boardId).finalSummary) return;
    const cards = this.below(goalId);
    const done = cards.filter((c) => c.role === 'worker' && c.status === 'done').length;
    if (!done || (goal.pipeline.finalSummary && goal.pipeline.finalSummary.cards >= done)) return;
    this.starting.add(goalId);
    try {
      const board = store.getBoard(goal.boardId)!;
      const ids = [goalId, ...cards.map((c) => c.id)];
      const notes = store.listArtifacts(goal.boardId, { cardIds: ids, kinds: ['decision', 'contract', 'finding'], limit: 40 });
      const prompt = buildSummaryPrompt({ goal, board, cards, notes });
      const task = await startTask(goal.boardId, clip(`Summary: ${goal.title}`, 140), 'The orchestrator\'s final report on the finished goal.', prompt);
      store.updateCard(task.id, { pipeline: { ...task.pipeline, summaryOf: goalId } }, 'daemon:summary');
      const now = store.getCard(goalId)!;
      store.updateCard(goalId, { pipeline: { ...now.pipeline, finalSummary: { cardId: task.id, cards: done, at: new Date().toISOString() } } }, 'daemon:summary');
    } catch (err) {
      this.tell(goal.boardId, `Could not start the final summary for "${goal.title}" (${goal.id}): ${(err as Error).message}.`);
    } finally {
      this.starting.delete(goalId);
    }
  }

  /** The summary card's turn ended: file the report on the goal and tell the humans. */
  private async finish(summaryCardId: string) {
    const { store, context } = this.deps;
    if (this.finished.has(summaryCardId)) return;
    const card = store.getCard(summaryCardId);
    const goal = card?.pipeline.summaryOf ? store.getCard(card.pipeline.summaryOf) : undefined;
    if (!card || !goal) return;
    const report = lastAgentMessage(store, card.id);
    if (card.status === 'blocked' || !report) {
      this.finished.add(summaryCardId);
      this.tell(goal.boardId, `The final summary for "${goal.title}" could not be written (card ${card.id} ${card.status === 'blocked' ? 'is blocked' : 'ended without a reply'}). Open it to see why, and press Run to try again.`);
      return;
    }
    this.finished.add(summaryCardId);
    const title = clip(`Final summary: ${goal.title}`, 160);
    const earlier = store.listArtifacts(goal.boardId, { cardIds: [goal.id], kinds: ['summary'] }).find((a) => a.title.startsWith('Final summary:'));
    context.put({ boardId: goal.boardId, cardId: goal.id, kind: 'summary', title, body: clip(report, 20_000), author: 'daemon:summary', commitSha: null, supersedes: earlier?.id ?? null });
    store.updateCard(card.id, { status: 'done' }, 'daemon:summary');
    const excerpt = clip(report, 1800);
    this.tell(goal.boardId, `Final summary ready for "${goal.title}": open card ${card.id} for the full report, also saved on the goal (${goal.id}) under Context.\n\n${excerpt}`);
  }

  private tell(boardId: string, body: string) {
    this.deps.store.postMessage({ boardId, fromActor: 'daemon:summary', toCard: null, body, urgent: false });
  }
}
