import type { Board, Card } from '@ih/core';
import type { PoolSummary, UsageSummary } from './client.ts';

// Pure helpers behind the status bar and the chat view (no vscode import, so they can be tested directly).

const WINDOW: Record<string, string> = { '5h': '5-hour', '7d': 'weekly', rpm: 'req/min', tpm: 'tok/min', rpd: 'req/day', concurrency: 'in flight', forced: 'forced', budget: 'budget' };

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

const POOL_ICON = { open: '$(circle-filled)', warn: '$(warning)', halted: '$(error)', locked: '$(lock)' } as const;

/** One line per pool: its state and its fullest window. */
export function poolLines(pools: PoolSummary[]): string[] {
  return pools.map((p) => {
    const top = p.status.windows.reduce<{ window: string; pct: number } | null>((a, w) => (!a || w.pct > a.pct ? w : a), null);
    const used = top ? ` · ${WINDOW[top.window] ?? top.window} ${Math.round(top.pct)}%` : '';
    const h = p.health;
    // Out of rotation or not answering outranks the quota state: nothing will be routed there.
    const answering = h?.ejected ? ' · **out of rotation**' : h?.reachable === 'offline' ? ' · no response' : h?.reachable === 'online' && h.latencyMs !== null ? ` · online ${h.latencyMs} ms` : '';
    return `${h?.ejected ? '$(circle-slash)' : POOL_ICON[p.status.state]} **${p.label}** ${p.status.state}${used}${answering}${p.running ? ` · ${p.running} working` : ''}`;
  });
}

/** Recent usage, and any budget that is warning or used up. */
export function usageLines(usage: UsageSummary | null): string[] {
  if (!usage) return [];
  const t = usage.totals;
  const lines = [`Last ${usage.hours}h: ${compact(t.tokens)} tokens${t.costUsd ? ` · $${t.costUsd.toFixed(2)}` : ''}`];
  for (const b of usage.budgets.filter((x) => x.state === 'warn' || x.state === 'halted')) {
    lines.push(`${b.state === 'halted' ? '$(error)' : '$(warning)'} Budget ${b.scope === 'board' ? 'for the board' : b.scope} at ${Math.round(b.pct)}%`);
  }
  return lines;
}

/** The status bar tooltip (markdown with theme icons). */
export function boardTooltip(board: Board, cards: Card[], need: number, pools: PoolSummary[], usage: UsageSummary | null): string {
  const working = cards.filter((c) => c.status === 'in_progress').length;
  const review = cards.filter((c) => c.status === 'review' || c.status === 'merging').length;
  return [
    `**${board.name}**: ${working} working, ${review} in review, ${need} need you.`,
    ...(pools.length ? ['', ...poolLines(pools)] : []),
    ...(usage ? ['', ...usageLines(usage)] : []),
    '',
    'Click to open the board.',
  ].join('\n\n');
}

/** Top-level goals (orchestrator cards with no parent), newest first. */
export function goalsOf(cards: Card[]): Card[] {
  return cards.filter((c) => c.role === 'orchestrator' && !c.parentId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** A card and everything under it. */
export function subtreeOf(cards: Card[], rootId: string): Card[] {
  const out: Card[] = [];
  const stack = cards.filter((c) => c.id === rootId);
  while (stack.length) {
    const c = stack.pop()!;
    out.push(c);
    stack.push(...cards.filter((k) => k.parentId === c.id));
  }
  return out;
}
