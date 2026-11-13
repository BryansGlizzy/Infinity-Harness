import { join } from 'node:path';
import { outcomeValue, type Board, type Card, type HarnessEvent, type OutcomeResult, type Pipeline, type Settings, type DaemonEvent } from '@ih/core';
import type { ContextService } from '@ih/context';
import type { KevClient } from '@ih/router';
import { buildHandoff, currentArtifact } from './context.ts';
import type { Store } from '@ih/db';
import { commitMessageJob, readCommitMessage, readTriage, trimInput, triageJob, type FastLane } from '@ih/fast-lane';
import type { DaemonConfig } from './config.ts';
import { advanceBranch, branchDiff, changedFiles, git, mergeBase, originUrl, pushBranch, revParse, runTests, landingCommit } from './git.ts';
import { ghCli, isGitHubRemote, type GitHub } from './github.ts';
import { heldByOthers } from './leases.ts';
import { LOCKOUT_PATTERN, type Runner } from './runner.ts';
import { PROVIDER_DOWN_PATTERN } from './health.ts';
import type { Scheduler } from './scheduler.ts';
import type { Approvals } from './approvals.ts';

const TICK_MS = 3000;
/** A card that can't land yet (lease held, branch checkout dirty, no reviewer free) is retried after this. */
const DEFER_MS = 30_000;
const REVIEW_DIFF_CHARS = 30_000;

/** Reads the reviewer's verdict: the last `VERDICT: APPROVE|CHANGES` line, and the notes after it. */
export function parseVerdict(text: string): { verdict: 'approve' | 'changes' | null; notes: string } {
  const matches = [...text.matchAll(/VERDICT:\s*\**\s*(APPROVE|CHANGES)\b/gi)];
  const last = matches[matches.length - 1];
  if (!last) return { verdict: null, notes: text.trim() };
  const after = text.slice(last.index! + last[0].length).replace(/^[\s*:.]+/, '').trim();
  return { verdict: last[1]!.toLowerCase() as 'approve' | 'changes', notes: after || text.slice(0, last.index).trim() };
}

export function reviewPrompt(card: Card, base: string, diff: string): string {
  return [
    `You are reviewing another agent's work on the card "${card.title}" (${card.id}). You did not write it.`,
    '',
    card.description,
    '',
    `The working directory is a read-only copy of its branch ${card.branch}. Read the code and run its tests if that helps; do not edit files.`,
    `The change against ${base}:`,
    '',
    trimInput(diff, REVIEW_DIFF_CHARS),
    '',
    'Check it against the task and its acceptance criteria: correctness, missing pieces, broken behaviour. Ignore style nits.',
    'End your reply with one line, VERDICT: APPROVE or VERDICT: CHANGES, followed by the specific changes needed (if any) as a short list.',
  ].join('\n');
}

/** The handoff message for the next agent on a card (the structured note, see buildHandoff). */
export function handoffNote(store: Store, card: Card, reason: string, detail: string, base: string): string {
  return `Handoff: this card was reassigned to you because ${reason}.\n\n${buildHandoff(store, card, reason, detail, base).body}`;
}

export interface RefineryDeps {
  store: Store;
  runner: Runner;
  scheduler: Scheduler;
  config: DaemonConfig;
  fastLane: FastLane | null;
  /** Saves handoffs as artifacts (master plan §5.7); without it they are only messages. */
  context?: ContextService | null;
  /** Scores landed work against its acceptance criteria for outcome learning. */
  kev?: KevClient | null;
  /** Defaults to the gh CLI when it is installed. */
  github?: GitHub | null;
  /** Escalations also wait in the approval queue (Phase 6.4). */
  approvals?: Approvals | null;
  tickMs?: number;
}

/**
 * The refinery (master plan §5.6): cross-provider review, then a serial merge queue per board that brings each card
 * up to date, checks leases, runs the board's tests and lands it (a merge commit, locally or as a merged GitHub PR).
 * Failures go back to the author, then to another agent, then to a human. Failed runs are reassigned with a handoff.
 */
export class Refinery {
  private deps: RefineryDeps;
  private github: GitHub | null;
  private timer: NodeJS.Timeout | null = null;
  private soon: NodeJS.Timeout | null = null;
  private off: (() => void)[] = [];
  /** Boards with a landing in progress (one at a time per board). */
  private landing = new Set<string>();
  private deciding = new Set<string>();
  /** Card → time before which it is not tried again. */
  private deferred = new Map<string, number>();
  /** Card → when it joined the queue, for FIFO order. */
  private queuedAt = new Map<string, number>();
  /** Card → last "waiting" reason logged, so a waiting card doesn't flood its log. */
  private noted = new Map<string, string>();

  constructor(deps: RefineryDeps) {
    this.deps = deps;
    this.github = deps.github !== undefined ? deps.github : deps.config.binaries.gh ? ghCli(deps.config.binaries.gh) : null;
  }

  start() {
    this.off.push(this.deps.store.onEvent((e) => this.onEvent(e)));
    this.timer = setInterval(() => this.tick(), this.deps.tickMs ?? TICK_MS);
    this.timer.unref?.();
    this.kick();
  }

  stop() {
    for (const off of this.off) off();
    if (this.timer) clearInterval(this.timer);
    if (this.soon) clearTimeout(this.soon);
  }

  kick() {
    if (this.soon) return;
    this.soon = setTimeout(() => {
      this.soon = null;
      this.tick();
    }, 100);
    this.soon.unref?.();
  }

  private onEvent(e: DaemonEvent) {
    if (e.type === 'card.updated') {
      const { patch, card } = e.payload as { patch: Partial<Card>; card: Card };
      // The runner (actor "daemon") blocks a card whose run failed; humans and the refinery itself are left alone.
      if (patch.status === 'blocked' && e.actor === 'daemon' && card.role === 'worker') this.retry(card);
    }
    if (['card.updated', 'settings.updated', 'session.ended', 'lease.released'].includes(e.type)) this.kick();
  }

  private log(card: Card, step: string, detail: Record<string, unknown> = {}) {
    this.deps.store.append('card.refinery', card.id, { step, ...detail }, 'refinery');
  }

  /** Logs a waiting reason once per change and defers the card. */
  private wait(card: Card, reason: string) {
    this.deferred.set(card.id, Date.now() + DEFER_MS);
    if (this.noted.get(card.id) === reason) return;
    this.noted.set(card.id, reason);
    this.log(card, 'waiting', { reason });
  }

  private setPipeline(card: Card, patch: Partial<Pipeline>, status?: Card['status']): Card {
    const now = this.deps.store.getCard(card.id) ?? card;
    return this.deps.store.updateCard(card.id, { pipeline: { ...now.pipeline, ...patch }, status }, 'refinery');
  }

  tick() {
    const { store, runner } = this.deps;
    const now = Date.now();
    for (const board of store.listBoards()) {
      const settings = store.getSettings(board.id);
      if (!settings.autoLand) continue;
      const cards = store.listCards(board.id);
      this.completePlanning(cards);
      for (const card of cards) {
        if (card.role !== 'worker' || card.status !== 'review' || !card.branch) continue;
        // A best-of-N candidate waits for the judgement before it is reviewed or landed.
        if (card.pipeline.bestOf?.state === 'running') continue;
        if (runner.isActive(card.id) || runner.isReviewing(card.id) || this.deciding.has(card.id)) continue;
        if ((this.deferred.get(card.id) ?? 0) > now) continue;
        void this.afterWork(board, card, settings);
      }
      if (!this.landing.has(board.id)) {
        const next = this.nextToLand(cards, now);
        if (next) void this.land(board, next, settings);
      }
    }
  }

  /** A lead or orchestrator card is done once every card below it has landed. */
  private completePlanning(cards: Card[]) {
    // Council goals and their members' cards are closed by the council, after verification.
    const council = new Set(cards.filter((c) => c.pipeline.council).flatMap((c) => [c.id, ...c.pipeline.council!.members.map((m) => m.cardId)]));
    const byDepth = cards.filter((c) => c.role !== 'worker' && c.status === 'review' && !council.has(c.id)).sort((a, b) => b.depth - a.depth);
    const status = new Map(cards.map((c) => [c.id, c.status]));
    for (const card of byDepth) {
      const kids = cards.filter((c) => c.parentId === card.id);
      if (kids.length && kids.every((k) => status.get(k.id) === 'done')) {
        this.deps.store.updateCard(card.id, { status: 'done' }, 'refinery');
        status.set(card.id, 'done');
      }
    }
  }

  // --- review

  private async afterWork(board: Board, card: Card, settings: Settings) {
    this.deciding.add(card.id);
    try {
      const head = await revParse(board.repoPath, card.branch!);
      // The operator's word stands in for the agent reviewer (Phase 6.1): an approval goes straight to the queue, and with
      // "hold cards for my review" on, a card waits here until the operator gives a verdict.
      const human = card.pipeline.humanReview;
      if (human?.verdict === 'approve') {
        this.log(card, 'approved', { by: human.by, notes: human.notes.slice(0, 4000), human: true });
        this.enqueue(card);
        return;
      }
      if (settings.humanReview) return this.wait(card, 'waiting for your review (approve it, or request changes)');
      const rounds = card.pipeline.reviewRounds ?? 0;
      const wanted = settings.crossReview && (card.classification?.needsReview ?? 0) >= settings.reviewThreshold && card.pipeline.reviewedSha !== head;
      if (wanted && rounds < settings.maxReviewRounds) {
        await this.review(board, card, head!, settings);
        return;
      }
      if (wanted) this.log(card, 'review_skipped', { reason: `${rounds} review round(s) already, the limit` });
      this.enqueue(card);
    } catch (err) {
      this.log(card, 'error', { message: (err as Error).message });
      this.deferred.set(card.id, Date.now() + DEFER_MS);
    } finally {
      this.deciding.delete(card.id);
      this.kick();
    }
  }

  private enqueue(card: Card) {
    if (this.deps.store.getCard(card.id)?.status !== 'review') return;
    this.queuedAt.set(card.id, Date.now());
    this.noted.delete(card.id);
    this.deferred.delete(card.id);
    this.deps.store.updateCard(card.id, { status: 'merging' }, 'refinery');
    this.log(card, 'queued');
  }

  private async review(board: Board, card: Card, head: string, settings: Settings) {
    const { runner, scheduler } = this.deps;
    const reviewer = scheduler.rankReviewers(card).find((c) => c.eligible);
    if (!reviewer) return this.wait(card, 'no agent on another provider is free to review');
    const round = (card.pipeline.reviewRounds ?? 0) + 1;
    this.setPipeline(card, { reviewRounds: round });
    this.log(card, 'review', { round, agentId: reviewer.agentId, poolId: reviewer.poolId, model: reviewer.model });
    const base = await this.base(board, settings);
    let verdict: ReturnType<typeof parseVerdict>;
    try {
      const diff = await branchDiff(board.repoPath, base, card.branch!);
      const reasoning = settings.agents.find((a) => a.id === reviewer.agentId)?.reasoning;
      verdict = parseVerdict(await runner.review(card.id, reviewer.poolId, reviewer.model, reviewPrompt(card, base, diff), reasoning));
    } catch (err) {
      // A broken reviewer must not hold the card forever: the tests still gate landing.
      this.log(card, 'review_failed', { agentId: reviewer.agentId, message: (err as Error).message });
      this.setPipeline(card, { reviewedSha: head });
      this.enqueue(card);
      return;
    }
    const now = this.deps.store.getCard(card.id);
    if (!now || now.status !== 'review') return;
    this.setPipeline(now, { reviewedSha: head });
    if (verdict.verdict === 'changes' && round < settings.maxReviewRounds) {
      this.log(now, 'changes_requested', { agentId: reviewer.agentId, notes: verdict.notes.slice(0, 4000) });
      this.setPipeline(now, { changesRequested: (now.pipeline.changesRequested ?? 0) + 1 });
      this.toAuthor(
        now,
        `A reviewer on another provider (${reviewer.agentId}, ${reviewer.model}) asked for changes:\n\n${verdict.notes}\n\nAddress them in your worktree, then finish your turn with a summary of what you changed.`,
      );
      return;
    }
    this.log(now, verdict.verdict === 'changes' ? 'review_limit' : 'approved', {
      agentId: reviewer.agentId,
      notes: verdict.notes.slice(0, 4000),
      ...(verdict.verdict ? {} : { reason: 'the reviewer gave no verdict' }),
    });
    this.enqueue(now);
  }

  // --- the operator as reviewer (Phase 6.1)

  /**
   * The operator's verdict on a card's branch, from the web UI or VS Code. Approve sends it to the merge queue without
   * an agent review. Request changes sends the notes (and any comments on lines) back to the card's author.
   */
  humanVerdict(cardId: string, verdict: 'approve' | 'changes', notes: string, by = 'user:local'): Card {
    const { store } = this.deps;
    const card = store.getCard(cardId);
    if (!card) throw new Error(`card ${cardId} not found`);
    if (card.role !== 'worker') throw new Error('only worker cards are reviewed');
    if (!['review', 'merging'].includes(card.status)) throw new Error(`the card is ${card.status}; it can be reviewed once its agent has finished (Review)`);
    if (card.pipeline.bestOf?.state === 'running') throw new Error('this card is still racing its best-of-N candidates; review the winner');
    if (verdict === 'approve') {
      const next = this.setPipeline(card, { humanReview: { verdict, notes, sha: null, at: new Date().toISOString(), by } });
      this.log(next, 'approved', { by, notes: notes.slice(0, 4000), human: true });
      if (next.status === 'review') this.enqueue(next);
      return store.getCard(cardId)!;
    }
    if (!notes.trim()) throw new Error('say what should change');
    this.log(card, 'changes_requested', { by, notes: notes.slice(0, 4000), human: true });
    const next = this.setPipeline(card, { humanReview: undefined, reviewedSha: undefined, changesRequested: (card.pipeline.changesRequested ?? 0) + 1 });
    this.queuedAt.delete(card.id);
    this.deferred.delete(card.id);
    this.noted.delete(card.id);
    this.toAuthor(next, `The operator reviewed your branch and asked for changes:\n\n${notes.trim()}\n\nAddress them in your worktree, then finish your turn with a summary of what you changed.`);
    return store.getCard(cardId)!;
  }

  /** "Land now": skips the review and goes to the front of the queue. Cards it depends on must still have landed. */
  landNow(cardId: string, by = 'user:local'): Card {
    const { store } = this.deps;
    const card = store.getCard(cardId);
    if (!card) throw new Error(`card ${cardId} not found`);
    if (card.role !== 'worker' || !['review', 'merging'].includes(card.status)) throw new Error('only a worker card in Review or in the queue can be landed now');
    if (card.pipeline.bestOf?.state === 'running') throw new Error('this card is still racing its best-of-N candidates');
    let now = card;
    if (!now.pipeline.humanReview || now.pipeline.humanReview.verdict !== 'approve') {
      now = this.setPipeline(now, { humanReview: { verdict: 'approve', notes: 'landed now', sha: null, at: new Date().toISOString(), by } });
    }
    this.log(now, 'land_now', { by });
    if (now.status === 'review') this.enqueue(now);
    this.queuedAt.set(card.id, 0);
    this.deferred.delete(card.id);
    this.kick();
    return store.getCard(cardId)!;
  }

  // --- landing

  private async mode(board: Board, settings: Settings): Promise<'local' | 'pr'> {
    if (settings.landMode !== 'auto') return settings.landMode;
    return this.github && isGitHubRemote(await originUrl(board.repoPath)) ? 'pr' : 'local';
  }

  private async base(board: Board, settings: Settings): Promise<string> {
    return (await this.mode(board, settings)) === 'pr' ? `origin/${board.defaultBranch}` : board.defaultBranch;
  }

  /** First queued card whose blockers have landed and that isn't deferred. */
  private nextToLand(cards: Card[], now: number): Card | undefined {
    const status = new Map(cards.map((c) => [c.id, c.status]));
    const queued = cards
      .filter((c) => c.status === 'merging')
      .sort((a, b) => (this.queuedAt.get(a.id) ?? Date.parse(a.updatedAt)) - (this.queuedAt.get(b.id) ?? Date.parse(b.updatedAt)));
    for (const card of queued) {
      if ((this.deferred.get(card.id) ?? 0) > now) continue;
      const waiting = this.deps.store.blockers(card.id).filter((b) => status.get(b.id) !== 'done');
      if (waiting.length) {
        if (this.noted.get(card.id) !== 'deps') {
          this.noted.set(card.id, 'deps');
          this.log(card, 'waiting', { reason: `waits for ${waiting.map((b) => `"${b.title}"`).join(', ')} to land` });
        }
        continue;
      }
      return card;
    }
    return undefined;
  }

  private async land(board: Board, card: Card, settings: Settings) {
    const { store, fastLane } = this.deps;
    this.landing.add(board.id);
    const repo = board.repoPath;
    const dir = card.worktree!;
    const branch = card.branch!;
    try {
      const mode = await this.mode(board, settings);
      if (mode === 'pr' && !this.github) throw new Error('landing mode is "pr" but the gh CLI is not installed');
      if (mode === 'pr') await git(repo, ['fetch', '-q', 'origin', board.defaultBranch]);
      const base = await this.base(board, settings);

      const held = heldByOthers(store, board.id, card.id, await changedFiles(repo, base, branch));
      if (held.length) return this.wait(card, `${held.map((h) => `${h.path} is leased by ${h.heldBy}`).join('; ')}`);

      this.log(card, 'updating', { base, mode });
      const merged = await mergeBase(dir, base);
      if (!merged.ok) {
        this.log(card, 'conflict', { base, files: merged.conflicts });
        return this.fail(
          card,
          settings,
          base,
          'conflict',
          `Your branch ${branch} conflicts with ${base} in: ${merged.conflicts.join(', ')}. In your worktree run \`git merge ${base}\`, resolve the conflicts so both sides' changes survive, commit, and finish your turn with a summary.`,
        );
      }
      const changed = await changedFiles(repo, base, branch);
      if (!changed.length) {
        this.log(card, 'landed', { reason: `no changes left against ${base}` });
        return this.finish(card, {});
      }

      if (settings.testCommand.trim()) {
        this.log(card, 'testing', { command: settings.testCommand });
        const result = await runTests(dir, settings.testCommand, settings.testTimeoutSec);
        if (!result.ok) {
          const tail = result.output.slice(-6000);
          const triage = fastLane?.available ? await fastLane.run(triageJob(settings.testCommand, tail)) : null;
          const t = triage ? readTriage(triage.text) : null;
          this.log(card, 'tests_failed', { timedOut: result.timedOut, triage: t, tail: tail.slice(-2000) });
          return this.fail(
            card,
            settings,
            base,
            'tests',
            [
              `The board's tests failed on your branch after it was brought up to date with ${base}${result.timedOut ? ` (timed out after ${settings.testTimeoutSec}s)` : ''}.`,
              `Command: ${settings.testCommand}`,
              t ? `Likely cause: ${t.cause}${t.file ? ` (look at ${t.file})` : ''}${t.flaky ? ' — possibly flaky' : ''}` : '',
              `Output (tail):\n${tail.slice(-3000)}`,
              'Fix it in your worktree, run the command yourself, and finish your turn with a summary.',
            ]
              .filter(Boolean)
              .join('\n\n'),
          );
        }
      }

      const diff = await branchDiff(repo, base, branch);
      const written = fastLane?.available ? await fastLane.run(commitMessageJob(card.title, card.description, diff)) : null;
      const msg = (written && readCommitMessage(written.text)) ?? { title: card.title, body: card.description };
      const trailer = `Card: ${card.id}\nAgent: ${card.agentId ?? card.poolId ?? 'unknown'}`;
      const body = `${msg.body ? `${msg.body}\n\n` : ''}${trailer}`;

      if (mode === 'local') {
        const sha = await landingCommit(repo, join(this.deps.config.worktreesDir, board.id, '_refinery'), base, branch, `${msg.title}\n\n${body}`);
        const advanced = await advanceBranch(repo, board.defaultBranch, sha);
        if (!advanced.ok) return this.wait(card, `can't move ${board.defaultBranch}: ${advanced.reason}`);
        this.log(card, 'landed', { sha, title: msg.title, mode });
        this.finish(card, { landedSha: sha });
        void this.learn(card, diff, settings);
        return;
      }

      await pushBranch(dir, branch);
      const url = await this.github!.openPr(repo, { branch, base: board.defaultBranch, title: msg.title, body });
      this.setPipeline(card, { prUrl: url });
      this.log(card, 'pr', { url, title: msg.title });
      await this.github!.mergePr(repo, url, { subject: msg.title, body });
      await git(repo, ['fetch', '-q', 'origin', board.defaultBranch]);
      const sha = (await revParse(repo, `origin/${board.defaultBranch}`))!;
      // The local default branch follows when its checkout is clean; it is a convenience, not a requirement.
      const advanced = await advanceBranch(repo, board.defaultBranch, sha);
      await git(repo, ['push', '-q', 'origin', '--delete', branch]).catch(() => {});
      this.log(card, 'landed', { sha, url, title: msg.title, mode, ...(advanced.ok ? {} : { note: `local ${board.defaultBranch} not moved: ${advanced.reason}` }) });
      this.finish(card, { landedSha: sha, prUrl: url });
      void this.learn(card, diff, settings);
    } catch (err) {
      this.log(card, 'error', { message: (err as Error).message });
      // Not the agent's doing (git, gh, the network): no outcome is recorded against it.
      this.escalate(store.getCard(card.id) ?? card, `landing failed: ${(err as Error).message.split('\n')[0]}`, false);
    } finally {
      this.landing.delete(board.id);
      this.kick();
    }
  }

  private finish(card: Card, patch: Partial<Pipeline>) {
    const { runner, store } = this.deps;
    this.queuedAt.delete(card.id);
    this.noted.delete(card.id);
    this.setPipeline(card, patch, 'done');
    store.releaseLeases(card.id);
    if (runner.sessionState(card.id) === 'idle') void runner.cancel(card.id);
  }

  /** A landing failure: the 1st goes back to the author, the 2nd to another agent (the merge agent), then a human. */
  private fail(card: Card, settings: Settings, base: string, kind: 'conflict' | 'tests', message: string) {
    const attempts = (card.pipeline.mergeAttempts ?? 0) + 1;
    const now = this.setPipeline(card, { mergeAttempts: attempts });
    this.queuedAt.delete(card.id);
    if (attempts >= settings.mergeAttempts) {
      this.recordFailure(now, 'failed_landing', kind);
      return this.escalate(now, `landing failed ${attempts} times (${kind === 'conflict' ? 'merge conflicts' : 'failing tests'})`, false);
    }
    if (attempts === 1) return this.toAuthor(now, message);
    this.recordFailure(now, 'failed_landing', kind);
    this.reassign(now, kind === 'conflict' ? 'its branch conflicts with the base branch' : "the board's tests fail on it", message, base);
  }

  /** Sends a note to the card's own agent: wakes its idle session, or runs the card again on the same agent. */
  private toAuthor(card: Card, body: string) {
    const { store, runner } = this.deps;
    store.postMessage({ boardId: card.boardId, fromActor: 'daemon:refinery', toCard: card.id, body, urgent: false });
    if (runner.sessionState(card.id) === 'idle') runner.deliver(card.id);
    else store.updateCard(card.id, { status: 'ready' }, 'refinery');
  }

  /**
   * Hands the card to a different agent with a handoff (reassign-on-failure, master plan §5.4 step 8). The handoff is
   * required: it is saved as an artifact (superseding the card's previous one) and sent as the new agent's first message.
   */
  private reassign(card: Card, reason: string, detail: string, base: string) {
    const { store, runner, context } = this.deps;
    const avoid = [...new Set([...(card.pipeline.avoid ?? []), ...(card.agentId ? [card.agentId] : [])])];
    const { body } = buildHandoff(store, card, reason, detail, base);
    let saved = '';
    if (context) {
      const a = context.put({
        boardId: card.boardId,
        cardId: card.id,
        kind: 'handoff',
        title: `Handoff: ${card.title}`,
        body,
        author: 'daemon:handoff',
        supersedes: currentArtifact(store, card, 'handoff')?.id,
      });
      saved = `\n\n(Saved as artifact ${a.id}. search_context finds the decisions and contracts of this card and its siblings.)`;
    }
    store.postMessage({ boardId: card.boardId, fromActor: 'daemon:handoff', toCard: card.id, body: `Handoff: this card was reassigned to you because ${reason}.\n\n${body}${saved}`, urgent: false });
    if (runner.sessionState(card.id) === 'idle') void runner.cancel(card.id);
    store.updateCard(card.id, { status: 'ready', agentId: null, poolId: null, pipeline: { ...card.pipeline, avoid } }, 'refinery');
    this.log(card, 'reassigned', { reason, from: card.agentId });
  }

  /** `blame`: the card's agent failed it (an outcome is recorded); false when the cause was elsewhere or already counted. */
  private escalate(card: Card, reason: string, blame = true) {
    const { store } = this.deps;
    if (blame) this.recordFailure(card, 'escalated');
    this.queuedAt.delete(card.id);
    this.setPipeline(card, { escalated: true }, 'blocked');
    this.log(card, 'escalated', { reason });
    store.postMessage({ boardId: card.boardId, fromActor: 'daemon:refinery', toCard: null, body: `Card "${card.title}" (${card.id}) needs a human: ${reason}.`, urgent: false });
    // Answering the approval resumes the card with the human's note (Phase 6.4).
    void this.deps.approvals
      ?.request({ boardId: card.boardId, cardId: card.id, kind: 'escalation', payload: { reason }, requestedBy: 'daemon:refinery', summary: `"${card.title}" needs a human: ${reason}`, facts: [`Reason: ${reason}`], announce: false })
      .catch((err: Error) => this.log(card, 'error', { message: `approval: ${err.message}` }));
  }

  /** A failed run: hand it to another agent with a handoff, up to `maxRetries`, then ask a human. */
  private retry(card: Card) {
    const { store } = this.deps;
    if (card.pipeline.escalated) return;
    const settings = store.getSettings(card.boardId);
    const retries = card.pipeline.retries ?? 0;
    const lastError = [...store.eventsFor(card.id)]
      .reverse()
      .map((e) => (e.type === 'session.event' ? (e.payload as { event: HarnessEvent }).event : null))
      .find((h): h is Extract<HarnessEvent, { type: 'error' }> => h?.type === 'error')?.message;
    // The runner logs a report_blocked as "Blocked: <reason>"; a human weighs those instead of counting a failure.
    const blocked = lastError?.startsWith('Blocked: ') ? lastError.slice(9) : null;
    if (blocked) this.recordBlocked(card, blocked);
    // A provider that could not be reached says nothing about the model, any more than a quota lockout does.
    const providerDown = !blocked && !!lastError && PROVIDER_DOWN_PATTERN.test(lastError);
    if (retries >= settings.maxRetries) return this.escalate(card, `the run failed ${retries + 1} time(s)${lastError ? `: ${lastError.slice(0, 200)}` : ''}`, !blocked && !providerDown);
    // A quota or rate-limit lockout says nothing about the model's ability.
    if (!blocked && !providerDown && !(lastError && LOCKOUT_PATTERN.test(lastError))) this.recordFailure(card, 'failed_run');
    const board = store.getBoard(card.boardId)!;
    this.reassign({ ...card, pipeline: { ...card.pipeline, retries: retries + 1 } }, 'the previous run failed', lastError ? `Last error: ${lastError.slice(0, 1000)}` : '', board.defaultBranch);
  }

  // --- outcomes (master plan §5.4 step 7)

  /** Who ran the card, for its outcome: the agent's pool and the model its last session ran. */
  private author(card: Card): { agentId: string; poolId: string; model: string } | null {
    if (card.role !== 'worker' || !card.poolId) return null;
    const session = this.deps.store.listSessions(card.id).filter((s) => s.poolId === card.poolId).at(-1);
    if (!session) return null;
    return { agentId: card.agentId ?? card.poolId, poolId: card.poolId, model: session.model };
  }

  private record(
    card: Card,
    result: OutcomeResult,
    extra: { quality?: number | null; inScope?: number | null; testsPassed?: boolean | null; kind?: 'conflict' | 'tests'; review?: 'pending'; note?: string } = {},
  ) {
    const who = this.author(card);
    if (!who) return;
    const base = {
      result,
      quality: extra.quality ?? null,
      inScope: extra.inScope ?? null,
      changesRequested: card.pipeline.changesRequested ?? 0,
    };
    this.deps.store.recordOutcome(
      {
        cardId: card.id,
        boardId: card.boardId,
        ...who,
        workType: card.classification?.workType ?? card.workType ?? 'feature',
        complexity: card.classification?.complexity ?? 2,
        ...base,
        testsPassed: extra.testsPassed ?? null,
        value: outcomeValue({ ...base, kind: extra.kind }),
        review: extra.review ?? null,
        note: extra.note ?? null,
      },
      'refinery',
    );
  }

  /**
   * An agent reported itself blocked: it may be right (missing keys, a wrong spec), so the daemon doesn't judge it.
   * The outcome waits for a human to weigh it (pass / fail / ignore) and doesn't count until then.
   */
  private recordBlocked(card: Card, reason: string) {
    try {
      this.record(card, 'blocked', { review: 'pending', note: reason.slice(0, 1000) });
      this.deps.store.postMessage({
        boardId: card.boardId,
        fromActor: 'daemon:outcomes',
        toCard: null,
        body: `${card.agentId ?? card.poolId} reported "${card.title}" (${card.id}) blocked: ${reason.slice(0, 300)}. Weigh it for routing (pass / fail / ignore) under "Blocks to weigh".`,
        urgent: false,
      });
    } catch (err) {
      this.log(card, 'error', { message: `outcome: ${(err as Error).message}` });
    }
  }

  private recordFailure(card: Card, result: OutcomeResult, kind?: 'conflict' | 'tests') {
    try {
      this.record(card, result, { kind, testsPassed: kind === 'tests' ? false : null });
    } catch (err) {
      this.log(card, 'error', { message: `outcome: ${(err as Error).message}` });
    }
  }

  /** A landed card: Kev scores the change against the card (when enabled), and the author's outcome is recorded. */
  private async learn(card: Card, diff: string, settings: Settings) {
    const { kev, store } = this.deps;
    const now = store.getCard(card.id) ?? card;
    let scored: { quality: number; inScope: number } | null = null;
    if (kev && settings.kevOutcomeScoring) {
      try {
        scored = await kev.scoreOutcome({ title: now.title, description: now.description, diff: trimInput(diff, 9000), summary: currentArtifact(store, now, 'summary')?.body });
      } catch (err) {
        this.log(now, 'error', { message: `kev outcome scoring: ${(err as Error).message}` });
      }
    }
    try {
      this.record(now, 'landed', { quality: scored?.quality ?? null, inScope: scored?.inScope ?? null, testsPassed: settings.testCommand.trim() ? true : null });
    } catch (err) {
      this.log(now, 'error', { message: `outcome: ${(err as Error).message}` });
    }
  }
}
