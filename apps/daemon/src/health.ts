import type { Pool } from '@ih/core';
import type { Store } from '@ih/db';

// Is a pool's model actually answering? An API or local endpoint is checked with a quick request; a subscription harness
// by starting it and asking what it offers. A pool whose endpoint stops answering while it works is taken out of rotation
// (not marked down as a bad model) and stays out until a person puts it back.

export interface PoolHealthView {
  /** `online`: answered; `offline`: no answer; `unknown`: not checked yet. */
  reachable: 'online' | 'offline' | 'unknown';
  /** What was checked: the model endpoint itself, or the agent harness (started, signed in, offering models). */
  checked: 'endpoint' | 'harness';
  latencyMs: number | null;
  checkedAt: string | null;
  detail: string | null;
  /** Taken out of rotation after failing work; null while it is in rotation. */
  ejected: { since: string; reason: string } | null;
}

export interface HealthDeps {
  store: Store;
  pools: Pool[];
  /** API endpoints behind the gateway (NIM, the local model), by pool id. */
  upstreams: { id: string; baseUrl: string; apiKey?: string }[];
  /** Starts the pool's harness and lists its models (the same probe the model pickers use). */
  probeHarness: (poolId: string) => Promise<unknown>;
  fetch?: typeof fetch;
  endpointTimeoutMs?: number;
  harnessTimeoutMs?: number;
  /** Where a person is told a pool was taken out of rotation. */
  notify?: (poolId: string, reason: string) => void;
}

/** Messages that mean "could not reach the provider" rather than "the model did badly". */
export const PROVIDER_DOWN_PATTERN =
  /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|socket hang up|upstream error|gateway_error|bad gateway|service unavailable|gateway time-?out|\b50[234]\b|connection (refused|reset|error)|network (error|is unreachable)/i;

export class PoolHealth {
  private seen = new Map<string, Omit<PoolHealthView, 'ejected'>>();
  private inflight = new Map<string, Promise<PoolHealthView>>();
  private timer: NodeJS.Timeout | null = null;
  private deps: HealthDeps;

  constructor(deps: HealthDeps) {
    this.deps = deps;
  }

  private upstream(poolId: string) {
    return this.deps.upstreams.find((u) => u.id === poolId);
  }

  ejection(poolId: string): { since: string; reason: string } | null {
    const e = this.deps.store.poolEjections().find((x) => x.poolId === poolId);
    return e ? { since: e.since, reason: e.reason } : null;
  }

  view(poolId: string): PoolHealthView {
    const seen = this.seen.get(poolId) ?? {
      reachable: 'unknown' as const,
      checked: this.upstream(poolId) ? ('endpoint' as const) : ('harness' as const),
      latencyMs: null,
      checkedAt: null,
      detail: null,
    };
    return { ...seen, ejected: this.ejection(poolId) };
  }

  /** Checks the pool now. Concurrent checks of one pool share a single request. */
  check(poolId: string): Promise<PoolHealthView> {
    const running = this.inflight.get(poolId);
    if (running) return running;
    const p = this.run(poolId).finally(() => this.inflight.delete(poolId));
    this.inflight.set(poolId, p);
    return p;
  }

  private async run(poolId: string): Promise<PoolHealthView> {
    const up = this.upstream(poolId);
    const started = Date.now();
    let result: Omit<PoolHealthView, 'ejected'>;
    try {
      let detail: string | null = null;
      if (up) {
        const doFetch = this.deps.fetch ?? fetch;
        const res = await doFetch(`${up.baseUrl.replace(/\/+$/, '')}/models`, {
          headers: up.apiKey ? { authorization: `Bearer ${up.apiKey}` } : {},
          signal: AbortSignal.timeout(this.deps.endpointTimeoutMs ?? 8000),
        });
        // Any answer below 500 means the server is up; a rejected key is worth saying but is not an outage.
        if (res.status >= 500) throw new Error(`the endpoint answered ${res.status}`);
        detail = res.status === 401 || res.status === 403 ? `reachable, but it rejected the key (${res.status})` : null;
      } else {
        const timeout = this.deps.harnessTimeoutMs ?? 45_000;
        await Promise.race([
          this.deps.probeHarness(poolId),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`the harness did not answer within ${Math.round(timeout / 1000)} s`)), timeout).unref?.()),
        ]);
      }
      result = { reachable: 'online', checked: up ? 'endpoint' : 'harness', latencyMs: Date.now() - started, checkedAt: new Date().toISOString(), detail };
    } catch (err) {
      const e = err as Error & { cause?: { code?: string; message?: string } };
      // fetch's own message is just "fetch failed"; the reason is in its cause.
      const limit = Math.round((this.deps.endpointTimeoutMs ?? 8000) / 1000);
      const why =
        e.name === 'TimeoutError' || e.name === 'AbortError'
          ? `no answer within ${limit} s`
          : e.cause?.code || e.cause?.message
            ? `${e.message} (${e.cause.code ?? e.cause.message})`
            : e.message;
      result = { reachable: 'offline', checked: up ? 'endpoint' : 'harness', latencyMs: null, checkedAt: new Date().toISOString(), detail: why.slice(0, 300) };
    }
    this.seen.set(poolId, result);
    return this.view(poolId);
  }

  /**
   * A run on this pool failed with a message that looks like an unreachable provider. API and local endpoints are
   * checked right away; when they really are down the pool is taken out of rotation. Subscription harnesses are left
   * to the stall watchdog and the lockouts. True when the pool was ejected by this call.
   */
  async suspect(poolId: string, message: string): Promise<boolean> {
    const pool = this.deps.pools.find((p) => p.id === poolId);
    if (!pool || pool.kind === 'subscription' || !this.upstream(poolId)) return false;
    if (this.ejection(poolId)) return false;
    const now = await this.check(poolId);
    if (now.reachable !== 'offline') return false;
    return this.eject(poolId, now.detail ?? message);
  }

  eject(poolId: string, reason: string): boolean {
    const reasonText = reason.replace(/\s+/g, ' ').slice(0, 300);
    const done = this.deps.store.ejectPool(poolId, reasonText);
    if (done) this.deps.notify?.(poolId, reasonText);
    return done;
  }

  /** A person puts the pool back in rotation. */
  restore(poolId: string): boolean {
    return this.deps.store.restorePool(poolId);
  }

  /** Checks every endpoint pool now and then, so the Agents view shows who is up. Harnesses are checked on request only. */
  start(everyMs = 60_000) {
    const sweep = () => {
      for (const u of this.deps.upstreams) if (this.deps.pools.some((p) => p.id === u.id)) void this.check(u.id).catch(() => {});
    };
    sweep();
    this.timer = setInterval(sweep, everyMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
