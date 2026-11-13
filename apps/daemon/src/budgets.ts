import type { Budget, Settings } from '@ih/core';
import type { Store } from '@ih/db';
import type { PoolState, RateLimiter } from '@ih/gateway';

// Budgets (master plan Phase 6.3): a cap on tokens or dollars per board and per agent. They live in the same limiter as
// the pools' rate limits, as scopes of their own, so they behave the same way: `warn` from 80% (the agent ranks lower),
// `halted` from 95% (no new cards for the agent, or for the whole board). Running turns finish; nothing is killed.

export interface BudgetStatus {
  /** `board`, or an agent id. */
  scope: string;
  budget: Budget;
  used: number;
  pct: number;
  state: PoolState;
}

const DAY = 86_400_000;

/** Start of a budget's window: a rolling day or week, or the beginning of time. */
export function periodStart(period: Budget['period'], now = Date.now()): string {
  return period === 'total' ? '' : new Date(now - (period === 'day' ? DAY : 7 * DAY)).toISOString();
}

export const budgetScopeId = (boardId: string, scope: string) => `budget:${boardId}:${scope}`;
export const isBudgetScope = (id: string) => id.startsWith('budget:');

export interface BudgetDeps {
  store: Store;
  limiter: RateLimiter;
  now?: () => number;
  /** Tells the humans when a budget warns or halts. */
  notify?: (boardId: string, status: BudgetStatus) => void;
}

/** Keeps the limiter's budget scopes current from the usage records. */
export class Budgets {
  private deps: BudgetDeps;
  private known = new Map<string, Set<string>>();
  private notified = new Map<string, PoolState>();
  private timer: NodeJS.Timeout | null = null;
  private soon = new Map<string, NodeJS.Timeout>();
  private off: (() => void)[] = [];

  constructor(deps: BudgetDeps) {
    this.deps = deps;
  }

  start() {
    const { store } = this.deps;
    this.off.push(
      store.onUsage((u) => u.boardId && this.schedule(u.boardId)),
      store.onEvent((e) => {
        if (e.type === 'settings.updated') this.schedule(e.subject);
      }),
    );
    this.timer = setInterval(() => store.listBoards().forEach((b) => this.evaluate(b.id)), 60_000);
    this.timer.unref?.();
    store.listBoards().forEach((b) => this.evaluate(b.id));
  }

  stop() {
    for (const off of this.off) off();
    if (this.timer) clearInterval(this.timer);
    for (const t of this.soon.values()) clearTimeout(t);
  }

  /** Coalesces a burst of usage records into one evaluation. */
  private schedule(boardId: string) {
    if (this.soon.has(boardId)) return;
    const t = setTimeout(() => {
      this.soon.delete(boardId);
      this.evaluate(boardId);
    }, 300);
    t.unref?.();
    this.soon.set(boardId, t);
  }

  private used(boardId: string, scope: string, b: Budget): number {
    const t = this.deps.store.usageTotals(boardId, { agentId: scope === 'board' ? undefined : scope, sinceIso: periodStart(b.period, this.deps.now?.()) });
    return b.unit === 'usd' ? t.costUsd : t.inputTokens + t.outputTokens;
  }

  /** Recomputes every budget of a board and reports it to the limiter. */
  evaluate(boardId: string): BudgetStatus[] {
    const { store, limiter } = this.deps;
    if (!store.getBoard(boardId)) return [];
    const settings: Settings = store.getSettings(boardId);
    const wanted: [string, Budget][] = [
      ...(settings.budgets.board ? ([['board', settings.budgets.board]] as [string, Budget][]) : []),
      ...Object.entries(settings.budgets.agents),
    ].filter(([, b]) => b && b.limit > 0);
    const out: BudgetStatus[] = [];
    const now = new Set<string>();
    for (const [scope, budget] of wanted) {
      const used = this.used(boardId, scope, budget);
      const pct = Math.round((used / budget.limit) * 1000) / 10;
      const id = budgetScopeId(boardId, scope);
      now.add(id);
      limiter.report(id, [{ window: 'budget', pct }]);
      const state = limiter.status(id).state;
      out.push({ scope, budget, used, pct, state });
      const before = this.notified.get(id) ?? 'open';
      this.notified.set(id, state);
      if ((state === 'warn' || state === 'halted') && before !== state && !(state === 'warn' && before === 'halted')) this.deps.notify?.(boardId, out[out.length - 1]!);
    }
    // A budget that was removed stops limiting.
    for (const id of this.known.get(boardId) ?? []) {
      if (!now.has(id)) {
        limiter.report(id, []);
        this.notified.delete(id);
      }
    }
    this.known.set(boardId, now);
    return out;
  }

  /** Every configured budget of the board with its current state. */
  status(boardId: string): BudgetStatus[] {
    return this.evaluate(boardId);
  }

  private stateOf(boardId: string, scope: string): { state: PoolState; pct: number } | null {
    const s = this.deps.limiter.status(budgetScopeId(boardId, scope));
    const w = s.windows[0];
    return w ? { state: s.state, pct: w.pct } : null;
  }

  /** The agent's budget state, or null when it has none. */
  agent(boardId: string, agentId: string) {
    return this.stateOf(boardId, agentId);
  }

  /** The board budget's state, or null when it has none. */
  board(boardId: string) {
    return this.stateOf(boardId, 'board');
  }

  boardHalted(boardId: string): boolean {
    return this.board(boardId)?.state === 'halted';
  }
}

const amount = (n: number, unit: Budget['unit']) => (unit === 'usd' ? '$' + n.toFixed(2) : n >= 10_000 ? `${Math.round(n / 1000)}k tokens` : `${Math.round(n)} tokens`);

/** The message humans get when a budget warns or halts. */
export function describeBudget(s: BudgetStatus): string {
  const who = s.scope === 'board' ? "The board's budget" : `Agent ${s.scope}'s budget`;
  const per = s.budget.period === 'total' ? 'in total' : `per ${s.budget.period}`;
  const used = `${amount(s.used, s.budget.unit)} of ${amount(s.budget.limit, s.budget.unit)} ${per}`;
  return s.state === 'halted'
    ? `${who} is used up: ${used} (${s.pct}%). ${s.scope === 'board' ? 'No new cards start on this board' : 'It gets no new cards'} until you raise the budget (Settings → Budgets) or the window rolls over. Turns already running finish.`
    : `${who} is at ${s.pct}%: ${used}. Work continues, but ${s.scope === 'board' ? 'new cards stop' : 'it ranks lower and then stops getting cards'} at 95%.`;
}
