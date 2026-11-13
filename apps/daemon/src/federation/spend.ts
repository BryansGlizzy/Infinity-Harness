// What a request from another swarm has cost, against the limits that apply to it (master plan Phase 7, F4):
// the request's own budget (set by the sender, lowered or raised by the receiving operator) and the daily cap of the
// peer that sent it. Usage is attributed to cards, and a request's cards are the goal it became and everything below.
import type { Card, FedRequest, RequestBudget, Spend } from '@ih/core';
import type { Store } from '@ih/db';
import { subtree } from '../chat.ts';

export interface Spent {
  usd: number;
  tokens: number;
}

export const WARN_PCT = 80;
export const HALT_PCT = 95;

/** The top card of the tree a card belongs to. */
export function rootOf(store: Store, cardId: string): Card | undefined {
  let c = store.getCard(cardId);
  while (c?.parentId) c = store.getCard(c.parentId);
  return c;
}

/** The ids of the cards an approved request became (its goal and everything below). */
export function requestCards(store: Store, r: FedRequest): string[] {
  return r.cardId ? subtree(store, r.cardId).map((c) => c.id) : [];
}

export function spentBy(store: Store, r: FedRequest, sinceIso = ''): Spent {
  const t = store.usageForCards(requestCards(store, r), sinceIso);
  return { usd: t.costUsd, tokens: t.inputTokens + t.outputTokens };
}

/** What every approved request of a peer has used since `sinceIso`. */
export function peerSpent(store: Store, requests: FedRequest[], sinceIso: string): Spent {
  const ids = [...new Set(requests.flatMap((r) => requestCards(store, r)))];
  const t = store.usageForCards(ids, sinceIso);
  return { usd: t.costUsd, tokens: t.inputTokens + t.outputTokens };
}

const pct = (used: number, limit: number | undefined) => (limit && limit > 0 ? Math.round((used / limit) * 1000) / 10 : null);

/** The fullest of the limits that are set, as a percentage; null when none is set. */
export function spendPct(limit: { usd?: number; tokens?: number } | undefined | null, spent: Spent): number | null {
  if (!limit) return null;
  const parts = [pct(spent.usd, limit.usd), pct(spent.tokens, limit.tokens)].filter((p): p is number => p !== null);
  return parts.length ? Math.max(...parts) : null;
}

export const budgetAsSpend = (b: RequestBudget | null): Spend | undefined => (b ? { usd: b.maxUsd, tokens: b.maxTokens } : undefined);

/** True when every limit the request names is covered by the cap and within it. A request with no budget fits (the cap fills it in). */
export function budgetFits(budget: RequestBudget | null, cap: Spend | undefined): boolean {
  if (!cap || (cap.usd === undefined && cap.tokens === undefined)) return false;
  if (budget?.maxUsd !== undefined && (cap.usd === undefined || budget.maxUsd > cap.usd)) return false;
  if (budget?.maxTokens !== undefined && (cap.tokens === undefined || budget.maxTokens > cap.tokens)) return false;
  return true;
}

/** The request's budget with the cap filled in where the sender named none (and never above it). */
export function applyCap(budget: RequestBudget | null, cap: Spend): RequestBudget {
  const out: RequestBudget = {};
  const usd = budget?.maxUsd !== undefined ? Math.min(budget.maxUsd, cap.usd ?? Infinity) : cap.usd;
  const tokens = budget?.maxTokens !== undefined ? Math.min(budget.maxTokens, cap.tokens ?? Infinity) : cap.tokens;
  if (usd !== undefined && Number.isFinite(usd)) out.maxUsd = usd;
  if (tokens !== undefined && Number.isFinite(tokens)) out.maxTokens = tokens;
  return out;
}

export const hasLimit = (s: Spend | undefined): s is Spend => !!s && (s.usd !== undefined || s.tokens !== undefined);

export function describeSpend(s: { usd?: number; tokens?: number } | null | undefined): string {
  if (!s) return 'no limit';
  const parts = [s.usd !== undefined ? `$${s.usd.toFixed(2)}` : '', s.tokens !== undefined ? `${s.tokens >= 10_000 ? `${Math.round(s.tokens / 1000)}k` : s.tokens} tokens` : ''].filter(Boolean);
  return parts.join(' and ') || 'no limit';
}
