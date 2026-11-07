export type WindowKind = 'rpm' | 'tpm' | 'rpd' | 'concurrency' | '5h' | '7d' | 'forced' | 'budget';

export interface PoolLimits {
  rpm?: number;
  tpm?: number;
  rpd?: number;
  concurrency?: number;
}

export type PoolState = 'open' | 'warn' | 'halted' | 'locked';

export interface WindowUsage {
  window: WindowKind;
  limit: number;
  used: number;
  pct: number;
  /** Epoch ms when the window resets, for windows reported by the provider. */
  resetsAt?: number;
}

export interface PoolStatus {
  poolId: string;
  state: PoolState;
  windows: WindowUsage[];
  lockedUntil: number | null;
  queued: number;
}

export interface LimiterOptions {
  warnPct?: number;
  haltPct?: number;
  /** Length of the "minute" window; tests shrink it. */
  minuteMs?: number;
  dayMs?: number;
  now?: () => number;
}

export type Release = (actualTokens?: number) => void;

interface Entry {
  ts: number;
  tokens: number;
}

interface PoolTrack {
  limits: PoolLimits;
  requests: Entry[];
  inFlight: number;
  lockedUntil: number | null;
  queue: { tokens: number; resolve: (release: Release) => void }[];
  /** Windows the provider reports as percentages (subscription 5h / weekly), not counted here. */
  external: WindowUsage[];
  /** Operator override (UI "force"), shown as its own window; null when not forced. */
  forcedPct: number | null;
}

/**
 * Rolling-window limiter shared by every API pool (master plan §5.10). A pool is `warn` at warnPct of
 * any window and `halted` at haltPct; while halted, `acquire` waits instead of letting the request through.
 */
export class RateLimiter {
  private pools = new Map<string, PoolTrack>();
  private warnPct: number;
  private haltPct: number;
  private minuteMs: number;
  private dayMs: number;
  private now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private listeners = new Set<(s: PoolStatus) => void>();
  private lastState = new Map<string, string>();

  constructor(opts: LimiterOptions = {}) {
    this.warnPct = opts.warnPct ?? 80;
    this.haltPct = opts.haltPct ?? 95;
    this.minuteMs = opts.minuteMs ?? 60_000;
    this.dayMs = opts.dayMs ?? 86_400_000;
    this.now = opts.now ?? Date.now;
  }

  configure(poolId: string, limits: PoolLimits) {
    const existing = this.pools.get(poolId);
    if (existing) existing.limits = limits;
    else this.pools.set(poolId, { limits, requests: [], inFlight: 0, lockedUntil: null, queue: [], external: [], forcedPct: null });
  }

  onChange(fn: (s: PoolStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Halt threshold for a window: e.g. 95% of 40 RPM allows 38 requests per minute. */
  private cap(limit: number): number {
    return Math.max(1, Math.floor((limit * this.haltPct) / 100));
  }

  private prune(p: PoolTrack) {
    const cutoff = this.now() - this.dayMs;
    while (p.requests.length && p.requests[0]!.ts <= cutoff) p.requests.shift();
  }

  private counts(p: PoolTrack) {
    this.prune(p);
    const minuteAgo = this.now() - this.minuteMs;
    let rpm = 0;
    let tpm = 0;
    for (const e of p.requests) {
      if (e.ts > minuteAgo) {
        rpm++;
        tpm += e.tokens;
      }
    }
    return { rpm, tpm, rpd: p.requests.length, concurrency: p.inFlight };
  }

  status(poolId: string): PoolStatus {
    const p = this.pools.get(poolId);
    if (!p) return { poolId, state: 'open', windows: [], lockedUntil: null, queued: 0 };
    const counts = this.counts(p);
    const windows: WindowUsage[] = [];
    for (const kind of ['rpm', 'tpm', 'rpd', 'concurrency'] as const) {
      const limit = p.limits[kind];
      if (!limit) continue;
      windows.push({ window: kind, limit, used: counts[kind], pct: Math.round((counts[kind] / limit) * 1000) / 10 });
    }
    const now = this.now();
    windows.push(...p.external.filter((w) => !w.resetsAt || w.resetsAt > now));
    if (p.forcedPct !== null) windows.push({ window: 'forced', limit: 100, used: p.forcedPct, pct: p.forcedPct });
    const locked = p.lockedUntil !== null && p.lockedUntil > now;
    if (!locked) p.lockedUntil = null;
    const top = Math.max(0, ...windows.map((w) => w.pct));
    const state: PoolState = locked ? 'locked' : top >= this.haltPct ? 'halted' : top >= this.warnPct ? 'warn' : 'open';
    return { poolId, state, windows, lockedUntil: p.lockedUntil, queued: p.queue.length };
  }

  statuses(): PoolStatus[] {
    return [...this.pools.keys()].map((id) => this.status(id));
  }

  /** True when one more request (of `tokens` estimated tokens) stays under every halt threshold. */
  private fits(p: PoolTrack, tokens: number): boolean {
    if (p.lockedUntil !== null && p.lockedUntil > this.now()) return false;
    const c = this.counts(p);
    const { rpm, tpm, rpd, concurrency } = p.limits;
    if (rpm && c.rpm + 1 > this.cap(rpm)) return false;
    if (tpm && c.tpm + tokens > this.cap(tpm) && c.tpm > 0) return false;
    if (rpd && c.rpd + 1 > this.cap(rpd)) return false;
    if (concurrency && c.concurrency + 1 > concurrency) return false;
    return true;
  }

  /**
   * Waits until the pool has room, then records the request. Call the returned function when the
   * response is done, with the tokens it actually used.
   */
  acquire(poolId: string, estimatedTokens = 0): Promise<Release> {
    const p = this.pools.get(poolId);
    if (!p) return Promise.reject(new Error(`unknown pool ${poolId}`));
    if (!p.queue.length && this.fits(p, estimatedTokens)) return Promise.resolve(this.admit(poolId, p, estimatedTokens));
    return new Promise<Release>((resolve) => {
      p.queue.push({ tokens: estimatedTokens, resolve });
      this.notify(poolId);
      this.schedule();
    });
  }

  /** Records an admitted request synchronously, so no other caller can take its slot in between. */
  private admit(poolId: string, p: PoolTrack, tokens: number): Release {
    const entry: Entry = { ts: this.now(), tokens };
    p.requests.push(entry);
    p.inFlight++;
    this.notify(poolId);
    let released = false;
    return (actualTokens?: number) => {
      if (released) return;
      released = true;
      if (actualTokens !== undefined) entry.tokens = actualTokens;
      p.inFlight--;
      this.drain();
      this.notify(poolId);
    };
  }

  /** Records provider-reported usage (e.g. Claude's 5h / weekly percentages from its status line). */
  report(poolId: string, windows: { window: WindowKind; pct: number; resetsAt?: number }[]) {
    if (!this.pools.has(poolId)) this.configure(poolId, {});
    this.pools.get(poolId)!.external = windows.map((w) => ({ window: w.window, limit: 100, used: w.pct, pct: w.pct, resetsAt: w.resetsAt }));
    this.notify(poolId);
  }

  /** Forces a pool's usage to `pct` percent (null clears it), e.g. to see work flow to other pools at 95%. */
  force(poolId: string, pct: number | null) {
    if (!this.pools.has(poolId)) this.configure(poolId, {});
    this.pools.get(poolId)!.forcedPct = pct;
    this.notify(poolId);
    this.drain();
  }

  /** Marks the pool locked (e.g. after a 429) until `until`; queued requests wait for it. */
  lock(poolId: string, until: number) {
    if (!this.pools.has(poolId)) this.configure(poolId, {}); // subscription pools have no counted limits
    const p = this.pools.get(poolId)!;
    p.lockedUntil = Math.max(p.lockedUntil ?? 0, until);
    this.notify(poolId);
    this.schedule();
  }

  private drain() {
    for (const [poolId, p] of this.pools) {
      while (p.queue.length && this.fits(p, p.queue[0]!.tokens)) {
        const next = p.queue.shift()!;
        next.resolve(this.admit(poolId, p, next.tokens));
      }
      if (p.queue.length) this.schedule();
    }
  }

  /** Re-checks queues periodically while anything waits; windows free up as time passes. */
  private schedule() {
    if (this.timer) return;
    const tick = Math.max(10, Math.min(1000, Math.floor(this.minuteMs / 60)));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drain();
    }, tick);
    this.timer.unref?.();
  }

  /** Tells listeners when a pool's state or queue length changes (not on every request). */
  private notify(poolId: string) {
    const status = this.status(poolId);
    const key = `${status.state}:${status.queued}`;
    if (this.lastState.get(poolId) === key) return;
    this.lastState.set(poolId, key);
    for (const fn of this.listeners) fn(status);
  }
}
