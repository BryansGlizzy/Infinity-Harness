import { boardNotes, effectiveAgents, type AgentProfile, type Card, type DaemonEvent, type HarnessEvent, type Pool, type Settings } from '@ih/core';
import type { Store } from '@ih/db';
import type { RateLimiter } from '@ih/gateway';
import { cleanNarration, narratorJob, readLint, specLintJob, type FastLane } from '@ih/fast-lane';
import { fallbackClassification, historyKey, rankPools, type Candidate, type KevClient, type PoolView } from '@ih/router';
import type { Runner } from './runner.ts';
import type { Budgets } from './budgets.ts';
import type { Approvals } from './approvals.ts';

/** A blocked-by dependency is satisfied once the blocker's work is committed for review (or further along). */
const FINISHED = new Set(['review', 'merging', 'done']);
const TICK_MS = 2000;
const KEV_WARM_MS = 4 * 60_000;
/** Narrate after this many new events, at most this often per card. */
const NARRATE_EVERY = 3;
const NARRATE_MIN_MS = 15_000;
const DEFAULT_LOCKOUT_MS = 15 * 60_000;

/** When an observed lockout ends: "try again in 2 hours" / "resets in 30 minutes", else a default. */
export function lockoutUntil(message: string, now = Date.now()): number {
  const m = /(\d+(?:\.\d+)?)\s*(s|sec|second|m|min|minute|h|hr|hour|d|day)s?\b/i.exec(message);
  if (!m) return now + DEFAULT_LOCKOUT_MS;
  const unit = m[2]!.toLowerCase()[0]!;
  const ms = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 60_000;
  return now + Math.min(Number(m[1]) * ms, 7 * 86_400_000);
}

/** One line of recent activity for the narrator. */
function activityLine(e: DaemonEvent): string | null {
  if (e.type === 'message.posted') return `message: ${String((e.payload as { body: string }).body).slice(0, 120)}`;
  if (e.type !== 'session.event') return null;
  const ev = (e.payload as { event: HarnessEvent }).event;
  switch (ev.type) {
    case 'tool_call':
      return `tool ${ev.kind}: ${ev.title.slice(0, 120)}`;
    case 'message':
      return ev.role === 'agent' ? `agent: ${ev.text.replace(/\s+/g, ' ').slice(0, 200)}` : null;
    case 'plan':
      return `plan: ${ev.entries.map((p) => `[${p.status}] ${p.content}`).join('; ').slice(0, 200)}`;
    case 'permission':
      return ev.decision === 'rejected' ? `refused: ${ev.title.slice(0, 80)} (${ev.reason.slice(0, 80)})` : null;
    case 'error':
      return `error: ${ev.message.slice(0, 120)}`;
    default:
      return null;
  }
}

export interface SchedulerDeps {
  store: Store;
  runner: Runner;
  limiter: RateLimiter;
  pools: Pool[];
  kev: KevClient | null;
  fastLane: FastLane | null;
  /** Spending budgets (Phase 6.3): a halted agent or board gets no new cards. */
  budgets?: Budgets | null;
  /** A card holding a grant whose tool isn't installed waits while the humans decide to install it. */
  approvals?: Approvals | null;
  /** Best-of-N (Phase 6.5): given a ready worker card first; returns true when it took the card over. */
  bestOf?: { intercept(card: Card): boolean; siblingAgents(card: Card): string[] } | null;
  /** Why a ready card must not start now (it waits for another swarm, or a request's budget is used up), or null. */
  hold?: (card: Card) => string | null;
  /** A worker card that needs an add-on whose outside half is down (Studio not connected): held, and the person told once. */
  gate?: (card: Card) => string | null;
  /** Pools taken out of rotation because their endpoint stopped answering. */
  health?: { ejection(poolId: string): { since: string; reason: string } | null } | null;
  tickMs?: number;
}

/**
 * Deterministic routing loop (master plan §5.4): classifies new worker cards with Kev, lints agent-written
 * specs on the fast lane, and starts ready, unblocked cards on the best eligible pool. No LLM decides routing.
 */
export class Scheduler {
  private deps: SchedulerDeps;
  private timer: NodeJS.Timeout | null = null;
  private warmTimer: NodeJS.Timeout | null = null;
  private soon: NodeJS.Timeout | null = null;
  private off: (() => void)[] = [];
  private classifying = new Set<string>();
  private linting = new Set<string>();
  /** Card id → the title+description that passed lint; a changed spec is linted again. */
  private linted = new Map<string, string>();
  private launching = new Map<string, string>();
  /** Card id → when it started waiting for its previous pool. */
  private waitingSince = new Map<string, number>();
  private narration = new Map<string, { pending: number; lastAt: number; busy: boolean }>();

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  /** Best-of-N needs the scheduler to rank, and the scheduler needs it to take cards over: wired after both exist. */
  setBestOf(bestOf: SchedulerDeps['bestOf']) {
    this.deps.bestOf = bestOf;
  }

  start() {
    const { store, limiter, kev } = this.deps;
    this.off.push(
      store.onEvent((e) => this.onEvent(e)),
      limiter.onChange(() => this.kick()),
    );
    this.timer = setInterval(() => this.tick(), this.deps.tickMs ?? TICK_MS);
    this.timer.unref?.();
    if (kev) {
      void kev.warm();
      this.warmTimer = setInterval(() => void kev.warm(), KEV_WARM_MS);
      this.warmTimer.unref?.();
    }
    this.kick();
  }

  stop() {
    for (const off of this.off) off();
    if (this.timer) clearInterval(this.timer);
    if (this.warmTimer) clearInterval(this.warmTimer);
    if (this.soon) clearTimeout(this.soon);
  }

  /** Runs a tick shortly, coalescing bursts of events. */
  kick() {
    if (this.soon) return;
    this.soon = setTimeout(() => {
      this.soon = null;
      this.tick();
    }, 100);
    this.soon.unref?.();
  }

  private onEvent(e: DaemonEvent) {
    if (e.type === 'card.created') {
      const card = e.payload as Card;
      if (card.role !== 'orchestrator') void this.classify(card.id);
    }
    if (['card.created', 'card.updated', 'session.ended', 'dependency.added', 'settings.updated'].includes(e.type)) this.kick();
    if (e.type === 'session.event' || e.type === 'message.posted') this.noteActivity(e.subject);
    if (e.type === 'card.updated') {
      const { patch, card } = e.payload as { patch: Partial<Card>; card: Card };
      // A finished card gets a closing narration from its last activity.
      if (patch.status && patch.status !== 'in_progress' && this.narration.has(card.id)) this.narrate(card.id, true);
    }
  }

  // --- pools and agents

  /** The board's enabled agents, each with its pool's live state (agents on one pool share its slots and windows). */
  agentViews(settings: Settings, boardId?: string): PoolView[] {
    const pools = new Map(this.poolViews().map((v) => [v.pool.id, v]));
    return effectiveAgents(settings, this.deps.pools)
      .filter((a) => a.enabled)
      .map((agent) => ({ ...pools.get(agent.poolId)!, agent, budget: boardId ? this.deps.budgets?.agent(boardId, agent.id) : null }));
  }

  poolViews(): PoolView[] {
    return this.deps.pools.map((pool) => {
      const status = this.deps.limiter.status(pool.id);
      const launching = [...this.launching.values()].filter((p) => p === pool.id).length;
      return {
        pool,
        state: status.state,
        topPct: Math.max(0, ...status.windows.map((w) => w.pct)),
        fiveHourPct: status.windows.find((w) => w.window === '5h')?.pct,
        running: this.deps.runner.runningOn(pool.id) + launching,
        offline: this.deps.health?.ejection(pool.id)?.reason ?? null,
      };
    });
  }

  // --- classification (Kev)

  async classify(cardId: string): Promise<void> {
    const { store, kev } = this.deps;
    if (this.classifying.has(cardId)) return;
    const card = store.getCard(cardId);
    if (!card || card.classification) return;
    this.classifying.add(cardId);
    const parent = card.parentId ? store.getCard(card.parentId) : undefined;
    const input = {
      title: card.title,
      description: card.description,
      workType: card.workType,
      parentTitle: parent?.title,
      notes: boardNotes(effectiveAgents(store.getSettings(card.boardId), this.deps.pools)),
    };
    try {
      let classification = fallbackClassification(input);
      if (kev) {
        try {
          classification = await kev.classify(input);
        } catch {
          // Kev unreachable: route on the defaults rather than stall the board.
        }
      }
      if (store.getCard(cardId)) store.updateCard(cardId, { classification, workType: classification.workType }, 'kev');
    } finally {
      this.classifying.delete(cardId);
      this.kick();
    }
  }

  // --- spec lint (fast lane job #7)

  private lintKey(card: Card) {
    return `${card.title}\n${card.description}`;
  }

  private needsLint(card: Card, settings: Settings): boolean {
    return settings.specLint && !!this.deps.fastLane?.available && card.createdBy.startsWith('card:') && this.linted.get(card.id) !== this.lintKey(card);
  }

  private async lint(card: Card): Promise<void> {
    const { store, runner, fastLane } = this.deps;
    if (this.linting.has(card.id) || !fastLane) return;
    this.linting.add(card.id);
    try {
      const result = await fastLane.run(specLintJob(card.title, card.description));
      const verdict = result ? readLint(result.text) : { ok: true, problem: '' };
      const now = store.getCard(card.id);
      if (!now || this.lintKey(now) !== this.lintKey(card)) return; // edited meanwhile: lint again next tick
      if (verdict.ok) {
        this.linted.set(card.id, this.lintKey(card));
        return;
      }
      store.updateCard(card.id, { status: 'backlog' }, 'fast-lane');
      store.setNarration(card.id, `Spec sent back: ${verdict.problem}`);
      const creator = card.createdBy.slice(5);
      if (store.getCard(creator)) {
        store.postMessage({
          boardId: card.boardId,
          fromActor: 'daemon:spec-lint',
          toCard: creator,
          body: `Card ${card.id} "${card.title}" was sent back before assignment: ${verdict.problem} Fix it with update_subtask (it returns to Ready).`,
          urgent: false,
        });
        runner.deliver(creator);
      }
    } finally {
      this.linting.delete(card.id);
      this.kick();
    }
  }

  // --- routing

  /** Observed success per agent (pool + model) for a work type near a complexity (master plan §5.4 step 7). */
  history(settings: Settings, workType: string, complexity: number): Record<string, { rate: number; n: number }> | undefined {
    if (!settings.learnFromOutcomes) return undefined;
    return Object.fromEntries(this.deps.store.outcomeStats(workType, complexity).map((s) => [historyKey(s.poolId, s.model), { rate: s.rate, n: s.n }]));
  }

  /** Ranks agents for a card without starting it (also used by the API to explain routing). */
  rank(card: Card): Candidate[] {
    const { store } = this.deps;
    const settings = store.getSettings(card.boardId);
    const classification = card.classification ?? fallbackClassification(card);
    return rankPools({
      classification,
      history: card.role === 'worker' ? this.history(settings, classification.workType, classification.complexity) : undefined,
      routing: store.effectiveRouting(card.id),
      role: card.role,
      preferredPool: card.agentId ?? card.poolId,
      failedAgents: [...(card.pipeline.avoid ?? []), ...(this.deps.bestOf?.siblingAgents(card) ?? [])],
      pools: this.agentViews(settings, card.boardId),
      settings,
    });
  }

  /**
   * Ranks reviewers for a card: any worker agent on a different pool (provider) than the author's. The card's
   * routing rules are about who writes it, not who reads it, so they don't apply.
   */
  rankReviewers(card: Card): Candidate[] {
    const settings = this.deps.store.getSettings(card.boardId);
    return rankPools({
      classification: card.classification ?? fallbackClassification(card),
      routing: card.poolId ? { avoid: [card.poolId] } : null,
      skill: 'review',
      pools: this.agentViews(settings, card.boardId),
      settings,
    });
  }

  /** Cards held by an add-on gate, and what they were told, so each hold is said once. */
  private gated = new Map<string, string>();

  private noteGate(card: Card, reason: string) {
    if (this.gated.get(card.id) === reason) return;
    this.gated.set(card.id, reason);
    this.deps.store.postMessage({ boardId: card.boardId, fromActor: 'daemon:gate', toCard: null, body: `"${card.title}" (${card.id}) is waiting, not started: ${reason} It starts by itself once that is fixed.`, urgent: false });
  }

  tick() {
    const { store, runner } = this.deps;
    for (const board of store.listBoards()) {
      const settings = store.getSettings(board.id);
      if (!settings.autoRoute) continue;
      // A board past its budget starts nothing new; turns already running finish.
      if (this.deps.budgets?.boardHalted(board.id)) continue;
      const cards = store.listCards(board.id);
      const byId = new Map(cards.map((c) => [c.id, c]));
      // Cards waiting for a human to approve a tool grant don't start yet (Phase 6.5).
      const grantHeld = new Set(store.listApprovals(board.id, { status: 'pending' }).filter((a) => a.kind === 'grant' && a.cardId).map((a) => a.cardId!));
      for (const card of cards) {
        if (grantHeld.has(card.id)) continue;
        if (card.role === 'worker' && card.status === 'ready' && card.grants.length && this.deps.approvals?.installGate(card)) continue;
        if (card.role === 'orchestrator' || card.status !== 'ready') {
          this.waitingSince.delete(card.id);
          continue;
        }
        if (runner.isActive(card.id) || this.launching.has(card.id)) continue;
        // Waiting for another swarm's answer, or for a request's budget to be raised (federation, Phase 7).
        if (this.deps.hold?.(card)) continue;
        const gated = this.deps.gate?.(card) ?? null;
        if (gated) {
          this.noteGate(card, gated);
          continue;
        }
        this.gated.delete(card.id);
        if (store.blockers(card.id).some((b) => !this.settled(byId.get(b.id) ?? b, cards))) continue;
        if (!card.classification) {
          void this.classify(card.id);
          continue;
        }
        if (this.needsLint(card, settings)) {
          void this.lint(card);
          continue;
        }
        // Direct boards share one folder: cap the workers editing it at once (Kimi and Codex don't ask before edits).
        if (board.mode === 'direct' && card.role === 'worker') {
          const working = cards.filter((c) => c.role === 'worker' && (c.status === 'in_progress' || this.launching.has(c.id))).length;
          if (working >= Math.max(1, settings.directParallel)) continue;
        }
        // Best-of-N takes a big worker card over: it clones it and the candidates are routed one by one.
        if (card.role === 'worker' && board.mode !== 'direct' && this.deps.bestOf?.intercept(card)) continue;
        this.route(card, settings);
      }
    }
  }

  /**
   * A blocker is satisfied once its work is committed for review. A planning card (lead or orchestrator) is done
   * planning long before its work exists, so it counts only once every card below it is finished too.
   */
  private settled(card: Card, cards: Card[]): boolean {
    if (!FINISHED.has(card.status)) return false;
    // A best-of-N candidate isn't a result until the judgement picks it.
    if (card.pipeline.bestOf?.state === 'running') return false;
    return card.role === 'worker' || cards.filter((c) => c.parentId === card.id).every((c) => this.settled(c, cards));
  }

  private route(card: Card, settings: Settings) {
    const ranked = this.rank(card);
    const best = ranked.find((c) => c.eligible);
    const previous = card.agentId ?? card.poolId;
    const preferred = previous ? (ranked.find((c) => c.agentId === previous) ?? ranked.find((c) => c.poolId === previous)) : undefined;
    let rerouted = false;
    // A card that ran before waits a while for its previous pool (session continuity), then moves on.
    if (preferred && !preferred.eligible && best) {
      const since = this.waitingSince.get(card.id) ?? Date.now();
      this.waitingSince.set(card.id, since);
      if (Date.now() - since < settings.rerouteAfterSec * 1000) return;
      rerouted = true;
    }
    if (!best) {
      if (!this.waitingSince.has(card.id)) this.waitingSince.set(card.id, Date.now());
      return;
    }
    this.waitingSince.delete(card.id);
    this.launching.set(card.id, best.poolId);
    this.deps.store.append(
      'card.routed',
      card.id,
      { poolId: best.poolId, agentId: best.agentId, rerouted, from: rerouted ? previous : undefined, candidates: ranked },
      'scheduler',
    );
    this.deps.runner
      .run(card.id, best.poolId, { model: best.model, agentId: best.agentId })
      .catch((err: Error) => {
        this.deps.store.append('session.event', card.id, { sessionId: null, event: { type: 'error', message: `routing failed: ${err.message}` } }, 'scheduler');
        this.deps.store.updateCard(card.id, { status: 'blocked' }, 'scheduler');
      })
      .finally(() => {
        this.launching.delete(card.id);
        this.kick();
      });
  }

  // --- orchestrator

  /**
   * Picks the orchestrator: the first enabled orchestrator agent whose pool isn't halted, then a lead, then any
   * subscription pool on its default model (planning must go on when the configured pool is out of quota).
   */
  orchestratorAgent(settings: Settings, boardId?: string): { poolId: string; model?: string; agentId?: string } {
    const views = this.agentViews(settings, boardId);
    const usable = (v: PoolView) => v.state !== 'halted' && v.state !== 'locked' && v.budget?.state !== 'halted' && !v.offline;
    const pick = (v: PoolView & { agent?: AgentProfile }) => ({ poolId: v.pool.id, model: v.agent?.model || undefined, agentId: v.agent?.id });
    for (const role of ['orchestrator', 'lead'] as const) {
      const found = views.find((v) => v.agent?.role === role && usable(v));
      if (found) return pick(found);
    }
    const pools = this.poolViews();
    const fallback = pools.find((v) => v.pool.kind === 'subscription' && usable(v)) ?? pools.find(usable);
    if (fallback) return { poolId: fallback.pool.id };
    const configured = views.find((v) => v.agent?.role === 'orchestrator');
    if (configured) return pick(configured);
    if (!pools[0]) throw new Error('no agent pools configured');
    return { poolId: pools[0].pool.id };
  }

  /** "Type a goal": creates an orchestrator card for it and starts the planning session. */
  async startGoal(boardId: string, goal: string, description = ''): Promise<Card> {
    const { store, runner } = this.deps;
    const settings = store.getSettings(boardId);
    if (this.deps.budgets?.boardHalted(boardId)) throw new Error("this board's budget is used up (Settings → Budgets); raise it to plan more work");
    const card = store.createCard({ boardId, title: goal, description, role: 'orchestrator', status: 'ready' });
    const { poolId, model, agentId } = this.orchestratorAgent(settings, boardId);
    await runner.run(card.id, poolId, { model, agentId });
    return store.getCard(card.id)!;
  }

  /** A one-off job for the orchestrator agent with its own prompt (not a goal to split into cards), e.g. writing a project card. */
  async startTask(boardId: string, title: string, description: string, prompt: string): Promise<Card> {
    const { store, runner } = this.deps;
    const settings = store.getSettings(boardId);
    if (this.deps.budgets?.boardHalted(boardId)) throw new Error("this board's budget is used up (Settings → Budgets)");
    const card = store.createCard({ boardId, title, description, role: 'orchestrator', status: 'ready' });
    const { poolId, model, agentId } = this.orchestratorAgent(settings, boardId);
    await runner.run(card.id, poolId, { model, agentId, prompt });
    return store.getCard(card.id)!;
  }

  // --- narrator (fast lane job #1)

  private noteActivity(cardId: string) {
    const state = this.narration.get(cardId) ?? { pending: 0, lastAt: 0, busy: false };
    state.pending++;
    this.narration.set(cardId, state);
    if (state.pending >= NARRATE_EVERY && Date.now() - state.lastAt >= NARRATE_MIN_MS) this.narrate(cardId);
  }

  private narrate(cardId: string, final = false) {
    const { store, fastLane } = this.deps;
    const state = this.narration.get(cardId);
    const card = store.getCard(cardId);
    if (!state || state.busy || !card || !fastLane?.available || !store.getSettings(card.boardId).narrator) return;
    const lines = store
      .eventsFor(cardId)
      .slice(-60)
      .map(activityLine)
      .filter((l): l is string => !!l)
      .slice(-12);
    if (!lines.length) return;
    if (final) lines.push(`(card is now ${card.status})`);
    state.busy = true;
    state.pending = 0;
    state.lastAt = Date.now();
    void fastLane
      .run(narratorJob(card.title, lines))
      .then((r) => {
        if (r && store.getCard(cardId)) store.setNarration(cardId, cleanNarration(r.text));
      })
      .finally(() => {
        state.busy = false;
        if (final) this.narration.delete(cardId);
      });
  }
}
