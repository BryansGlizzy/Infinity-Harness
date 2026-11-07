import type { PoolSample, Store } from '@mh/db';
import type { RateLimiter } from '@mh/gateway';
import { isBudgetScope } from './budgets.ts';

// Pool usage history (master plan Phase 6.3, from 5.6): a sample of each pool's state and windows, kept for a week.
// Samples are written when something changed (state, a window moving a point, sessions) or every few minutes.

const KEEP_MS = 7 * 86_400_000;
const FORCE_EVERY_MS = 5 * 60_000;

export interface HistoryDeps {
  store: Store;
  limiter: RateLimiter;
  poolIds: () => string[];
  running: (poolId: string) => number;
  intervalMs?: number;
  now?: () => number;
}

export class PoolHistory {
  private deps: HistoryDeps;
  private last = new Map<string, { at: number; key: string }>();
  private timer: NodeJS.Timeout | null = null;
  private prunedAt = 0;

  constructor(deps: HistoryDeps) {
    this.deps = deps;
  }

  start() {
    this.sample();
    this.timer = setInterval(() => this.sample(), this.deps.intervalMs ?? 60_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Stores a sample for every pool whose picture changed. Returns how many were stored. */
  sample(): number {
    const { store, limiter } = this.deps;
    const now = this.deps.now?.() ?? Date.now();
    const samples: PoolSample[] = [];
    for (const poolId of this.deps.poolIds()) {
      if (isBudgetScope(poolId)) continue;
      const status = limiter.status(poolId);
      const windows = status.windows.map((w) => ({ window: w.window, pct: Math.round(w.pct) }));
      const running = this.deps.running(poolId);
      const key = `${status.state}|${running}|${windows.map((w) => `${w.window}:${w.pct}`).join(',')}`;
      const before = this.last.get(poolId);
      if (before && before.key === key && now - before.at < FORCE_EVERY_MS) continue;
      this.last.set(poolId, { at: now, key });
      samples.push({ ts: new Date(now).toISOString(), poolId, state: status.state, topPct: Math.max(0, ...windows.map((w) => w.pct)), windows, running });
    }
    store.recordPoolSamples(samples);
    if (now - this.prunedAt > 3_600_000) {
      this.prunedAt = now;
      store.prunePoolSamples(new Date(now - KEEP_MS).toISOString());
    }
    return samples.length;
  }
}

/** Stretches of time a pool was locked or halted, from its samples (for the history chart). */
export function outages(samples: PoolSample[], until = new Date().toISOString()): { from: string; to: string; state: string }[] {
  const out: { from: string; to: string; state: string }[] = [];
  let open: { from: string; state: string } | null = null;
  for (const s of samples) {
    const bad = s.state === 'locked' || s.state === 'halted';
    if (bad && !open) open = { from: s.ts, state: s.state };
    else if (!bad && open) {
      out.push({ ...open, to: s.ts });
      open = null;
    }
  }
  if (open) out.push({ ...open, to: until });
  return out;
}
