import type { Card } from '@mh/core';
import type { UsageRow, UsageTotals } from '@mh/db';

// Metrics for a board (master plan Phase 6.3): tokens and cost by agent, model, pool and card, rolled up the card tree so
// a goal shows what its whole sub-agent tree used.

const tokens = (r: Pick<UsageTotals, 'inputTokens' | 'outputTokens'>) => r.inputTokens + r.outputTokens;

export interface UsageSum {
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  /** What harnesses reported; 0 when none did. */
  costUsd: number;
  requests: number;
}

const zero = (): UsageSum => ({ tokens: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, costUsd: 0, requests: 0 });
function add(into: UsageSum, r: UsageRow) {
  into.inputTokens += r.inputTokens;
  into.outputTokens += r.outputTokens;
  into.cacheTokens += r.cacheTokens;
  into.tokens += tokens(r);
  into.costUsd += r.costUsd ?? 0;
  into.requests += r.requests;
}

export interface CardUsage {
  id: string;
  title: string;
  parentId: string | null;
  role: Card['role'];
  status: Card['status'];
  agentId: string | null;
  /** This card's own sessions. */
  own: UsageSum;
  /** The card and everything under it. */
  subtree: UsageSum;
}

export interface MetricsReport {
  since: string;
  totals: UsageSum;
  byAgent: ({ agentId: string; poolId: string } & UsageSum)[];
  byModel: ({ model: string; poolId: string } & UsageSum)[];
  byPool: ({ poolId: string } & UsageSum)[];
  cards: CardUsage[];
  series: { bucket: string; tokens: number; costUsd: number }[];
  /** Usage on the board that no card claims (e.g. the fast lane). */
  unattributed: UsageSum;
}

export function buildMetrics(opts: { rows: UsageRow[]; cards: Card[]; series: MetricsReport['series']; since: string }): MetricsReport {
  const totals = zero();
  const unattributed = zero();
  const agents = new Map<string, { agentId: string; poolId: string } & UsageSum>();
  const models = new Map<string, { model: string; poolId: string } & UsageSum>();
  const pools = new Map<string, { poolId: string } & UsageSum>();
  const own = new Map<string, UsageSum>();
  const byId = new Map(opts.cards.map((c) => [c.id, c]));
  for (const r of opts.rows) {
    add(totals, r);
    const card = r.cardId ? byId.get(r.cardId) : undefined;
    if (!card) add(unattributed, r);
    else add(own.get(card.id) ?? own.set(card.id, zero()).get(card.id)!, r);
    const agentId = r.agentId ?? card?.agentId ?? r.poolId;
    add(agents.get(`${agentId}|${r.poolId}`) ?? agents.set(`${agentId}|${r.poolId}`, { agentId, poolId: r.poolId, ...zero() }).get(`${agentId}|${r.poolId}`)!, r);
    const model = r.model ?? 'unknown';
    add(models.get(`${model}|${r.poolId}`) ?? models.set(`${model}|${r.poolId}`, { model, poolId: r.poolId, ...zero() }).get(`${model}|${r.poolId}`)!, r);
    add(pools.get(r.poolId) ?? pools.set(r.poolId, { poolId: r.poolId, ...zero() }).get(r.poolId)!, r);
  }
  // Roll each card's own usage up through its ancestors.
  const subtree = new Map<string, UsageSum>();
  for (const [id, u] of own) {
    for (let c = byId.get(id); c; c = c.parentId ? byId.get(c.parentId) : undefined) {
      const s = subtree.get(c.id) ?? subtree.set(c.id, zero()).get(c.id)!;
      s.inputTokens += u.inputTokens;
      s.outputTokens += u.outputTokens;
      s.cacheTokens += u.cacheTokens;
      s.tokens += u.tokens;
      s.costUsd += u.costUsd;
      s.requests += u.requests;
    }
  }
  const cards: CardUsage[] = opts.cards
    .filter((c) => subtree.has(c.id))
    .map((c) => ({ id: c.id, title: c.title, parentId: c.parentId, role: c.role, status: c.status, agentId: c.agentId, own: own.get(c.id) ?? zero(), subtree: subtree.get(c.id)! }));
  const bySpend = (a: UsageSum, b: UsageSum) => b.tokens - a.tokens || b.costUsd - a.costUsd;
  return {
    since: opts.since,
    totals,
    byAgent: [...agents.values()].sort(bySpend),
    byModel: [...models.values()].sort(bySpend),
    byPool: [...pools.values()].sort(bySpend),
    cards,
    series: opts.series,
    unattributed,
  };
}
