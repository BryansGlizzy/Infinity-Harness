import { loadNeeds, type DaemonApi, type Need, type PoolWithStatus, type UsageSummary } from '@ih/client';
import type { Board, Card } from '@ih/core';

/** Everything one machine's screens show, as last loaded. Kept across a lost connection (and then shown dimmed). */
export interface Snapshot {
  boards: Board[];
  board: Board | null;
  cards: Card[];
  needs: Need[];
  pools: PoolWithStatus[];
  usage: UsageSummary | null;
  loadedAt: number;
  error: string | null;
}

export const EMPTY: Snapshot = { boards: [], board: null, cards: [], needs: [], pools: [], usage: null, loadedAt: 0, error: null };

export async function loadSnapshot(api: DaemonApi, wantBoard: string | null, now: number): Promise<Snapshot> {
  const boards = await api.boards();
  const board = boards.find((b) => b.id === wantBoard) ?? boards[0] ?? null;
  const pools = await api.pools().catch(() => []);
  if (!board) return { ...EMPTY, boards, pools, loadedAt: now };
  const [cards, needs, usage] = await Promise.all([api.cards(board.id), loadNeeds(api, board.id), api.usage(board.id, 24).catch(() => null)]);
  return { boards, board, cards, needs, pools, usage, loadedAt: now, error: null };
}

/** The key a need is remembered under once seen; it changes when the thing changes, so a card that blocks again is new again. */
export const needKey = (n: Need) => `${n.kind}:${n.id}@${n.at}`;
