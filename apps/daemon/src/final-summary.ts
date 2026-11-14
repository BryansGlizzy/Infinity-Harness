import type { Artifact, Board, Card, DaemonEvent } from '@ih/core';
import type { Store } from '@ih/db';
import type { ContextService } from '@ih/context';
import { lastAgentMessage } from './context.ts';
import type { Runner } from './runner.ts';

// When a goal's last card is done, the orchestrator that planned it gets one more turn to write the final report: what was done,
// how to check it, the decisions that matter, what is left, and the documentation that applies. It writes it from what its cards
// reported, not by investigating again: no new card, no new session when its own is still open, and no digging through the project.
// The report is that turn's reply; the daemon files it on the goal and tells the humans.

export interface SummaryInput {
  goal: Card;
  board?: Pick<Board, 'name'>;
  /** Everything under the goal. */
  cards: Card[];
  notes: (Pick<Artifact, 'id' | 'kind' | 'title'> & { body?: string })[];
  /**
   * What each finished card reported (its last message), by card id. Given when the orchestrator has to start over in a new
   * session and so does not remember them; left out when it is woken in its own conversation, which already holds them.
   */
  reports?: Map<string, string>;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** The end of a report is where a card says what it finished and what it ran. */
const tail = (s: string, n: number) => (s.length > n ? `…${s.slice(s.length - n + 1)}` : s);

/** Most characters of cards' reports put in a fresh orchestrator's prompt, and of each one. */
const REPORTS_TOTAL = 30_000;
const REPORT_EACH = 1800;

/** The request for the final report. A digest of the cards; the cards' own words when the orchestrator has none to remember. */
export function buildSummaryPrompt({ goal, board, cards, notes, reports }: SummaryInput): string {
  const workers = cards.filter((c) => c.role === 'worker');
  const lines = cards
    .filter((c) => c.role === 'worker' || c.role === 'lead')
    .slice(0, 80)
    .map((c) => {
      const landed = c.pipeline.landedSha ? `, landed ${c.pipeline.landedSha.slice(0, 10)}` : '';
      const pr = c.pipeline.prUrl ? `, ${c.pipeline.prUrl}` : '';
      return `- ${c.id} [${c.role}] "${clip(c.title, 90)}": ${c.status}${c.agentId ? `, by ${c.agentId}` : ''}${landed}${pr}${c.narration ? `. ${clip(c.narration, 140)}` : ''}`;
    });
  let budget = REPORTS_TOTAL;
  const submitted = reports
    ? cards
        .filter((c) => (c.role === 'worker' || c.role === 'lead') && reports.has(c.id))
        .flatMap((c) => {
          if (budget <= 0) return [];
          const text = tail(reports.get(c.id)!, Math.min(REPORT_EACH, budget));
          budget -= text.length;
          return ['', `### ${c.id} "${clip(c.title, 90)}"${c.agentId ? ` (${c.agentId})` : ''}`, text];
        })
    : [];
  return [
    `Every card under your goal${board ? ` on the "${board.name}" board` : ''} is finished. Write the final report now: it is your reply to this message.`,
    '',
    `Write it only from what the cards reported${reports ? ' (below)' : ': the reports they sent you earlier in this conversation, the notes they saved, and the digest below'}. Do not read files, run commands, search, open notes or check anything again, and do not create cards or message anyone: this is a report from what was submitted, not a review. Where the cards did not say something (how to run it, whether tests were run), write "not reported" instead of finding out.`,
    '',
    `Goal: ${goal.title}`,
    // In its own session the orchestrator already has the goal; a fresh one needs it.
    ...(goal.description && reports ? ['', clip(goal.description, 800)] : []),
    '',
    `Cards (${workers.filter((c) => c.status === 'done').length} of ${workers.length} work cards done):`,
    ...lines,
    ...(submitted.length ? ['', 'What each card reported:', ...submitted] : []),
    ...(notes.length
      ? [
          '',
          reports ? 'Decisions, contracts and findings the cards recorded:' : 'Decisions, contracts and findings the cards recorded (their titles; you were told their content as it happened):',
          ...notes.slice(0, 40).flatMap((n) => [`- ${n.id} (${n.kind}): ${clip(n.title, 100)}`, ...(reports && n.body ? [`  ${clip(n.body.replace(/\s+/g, ' '), 500)}`] : [])]),
        ]
      : []),
    '',
    'Your reply is the report, in markdown, with these sections:',
    '1. **Outcome**: was the goal achieved? One honest paragraph, including anything the cards said it falls short on.',
    '2. **What was done**: by area, naming the files or modules and which cards (by title) did it.',
    '3. **How to run and verify it**: the commands and checks the cards reported, and which they said they ran and passed. Say "not reported" when a card did not say.',
    '4. **Decisions and interfaces**: the choices and contracts later work must respect, with their note ids.',
    '5. **Open issues and follow-ups**: anything the cards said failed, was skipped, is risky, or waits for a human.',
    '6. **Reference documentation**: the files and documents the cards reported writing or updating, each with its path and one line on what it covers, and any references they cited (specs, library docs, URLs). Give them as reported; do not check that they exist. If none were reported, write "None".',
    '',
    'Be specific and scannable, with no filler. If the goal was research or an answer rather than code, say what the cards found instead of what they built. Do not write anything outside the report.',
  ].join('\n');
}

export interface FinalSummaryDeps {
  store: Store;
  context: ContextService;
  /** The orchestrator's session is woken (`promptIdle`), or its goal card is run again when the session is gone. */
  runner: Pick<Runner, 'sessionState' | 'promptIdle' | 'run'>;
  /** How long to wait between looks at a session that is still busy with something else, and how many looks. */
  waitMs?: number;
  waitTries?: number;
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
    if (!patch.status || card.role !== 'orchestrator' || card.parentId) return;
    // The report's turn ended: the card is back in Review (or the turn failed).
    if (card.pipeline.finalSummary?.pending && (patch.status === 'review' || patch.status === 'blocked')) void this.finish(card.id).catch(() => {});
    // A goal: a root orchestrator card whose cards are all done (a one-off task has no cards below it).
    else if (patch.status === 'done') void this.begin(card.id).catch(() => {});
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

  /** The goal just finished: its orchestrator writes the report (once, and again only if more cards finished since). */
  private async begin(goalId: string) {
    const { store, runner } = this.deps;
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
      // Marked before anyone is woken, so the end of the turn is recognised as the report.
      store.updateCard(goalId, { pipeline: { ...goal.pipeline, finalSummary: { cardId: goalId, cards: done, at: new Date().toISOString(), pending: true } } }, 'daemon:summary');
      const inSession = buildSummaryPrompt({ goal, cards, notes });
      if (await this.wake(goalId, inSession)) return;
      // Its session is gone (the idle timeout, a restart): the same card is run again, and told what its cards reported.
      const reports = new Map<string, string>();
      for (const c of cards) {
        const r = c.role === 'worker' || c.role === 'lead' ? lastAgentMessage(store, c.id) : null;
        if (r) reports.set(c.id, r);
      }
      const fresh = buildSummaryPrompt({ goal, board, cards, notes: notes.slice(0, 12), reports });
      const now = store.getCard(goalId)!;
      if (!now.poolId) throw new Error('the goal card has no agent to run');
      await runner.run(goalId, now.poolId, { agentId: now.agentId ?? undefined, prompt: fresh });
    } catch (err) {
      this.clearPending(goalId);
      this.tell(goal.boardId, `Could not start the final summary for "${goal.title}" (${goal.id}): ${(err as Error).message}.`);
    } finally {
      this.starting.delete(goalId);
    }
  }

  /** Gives the orchestrator's own open session the request; waits a little if it is busy with something else. False if it has none. */
  private async wake(goalId: string, prompt: string): Promise<boolean> {
    const { runner, waitMs = 3000, waitTries = 20 } = this.deps;
    for (let i = 0; i <= waitTries; i++) {
      const state = runner.sessionState(goalId);
      if (state === null) return false;
      if (state === 'idle' && runner.promptIdle(goalId, prompt)) return true;
      await new Promise((r) => setTimeout(r, waitMs));
    }
    return false;
  }

  private clearPending(goalId: string) {
    const { store } = this.deps;
    const goal = store.getCard(goalId);
    if (goal?.pipeline.finalSummary?.pending) store.updateCard(goalId, { pipeline: { ...goal.pipeline, finalSummary: { ...goal.pipeline.finalSummary, pending: false } } }, 'daemon:summary');
  }

  /** The report's turn ended: file it on the goal and tell the humans. */
  private async finish(goalId: string) {
    const { store, context } = this.deps;
    const goal = store.getCard(goalId);
    const pending = goal?.pipeline.finalSummary;
    if (!goal || !pending?.pending) return;
    const key = `${goalId}:${pending.at}`;
    if (this.finished.has(key)) return;
    this.finished.add(key);
    const report = goal.status === 'blocked' ? null : lastAgentMessage(store, goal.id);
    this.clearPending(goalId);
    if (!report) {
      this.tell(goal.boardId, `The final summary for "${goal.title}" (${goal.id}) could not be written (${goal.status === 'blocked' ? 'its turn was blocked' : 'it ended without a reply'}). Send the goal card a message asking for the report to try again.`);
      return;
    }
    const title = clip(`Final summary: ${goal.title}`, 160);
    const earlier = store.listArtifacts(goal.boardId, { cardIds: [goal.id], kinds: ['summary'] }).find((a) => a.title.startsWith('Final summary:'));
    context.put({ boardId: goal.boardId, cardId: goal.id, kind: 'summary', title, body: clip(report, 20_000), author: 'daemon:summary', commitSha: null, supersedes: earlier?.id ?? null });
    this.tell(goal.boardId, `Final summary ready for "${goal.title}" (${goal.id}): it is the last message on that card and is saved under its Context.\n\n${clip(report, 1800)}`);
  }

  private tell(boardId: string, body: string) {
    this.deps.store.postMessage({ boardId, fromActor: 'daemon:summary', toCard: null, body, urgent: false });
  }
}
