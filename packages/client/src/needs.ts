// "Needs you": everything on a board that is waiting for a person. One definition for the CLI and the TUI (VS Code
// and the web UI show the same things in their own layouts).
import type { Approval, ApprovalKind, Card, Message, Outcome } from '@mh/core';
import type { DaemonApi } from './api.ts';

export type NeedKind = 'approval' | 'review' | 'blocked' | 'outcome' | 'message';

export interface Need {
  kind: NeedKind;
  /** Approval id, card id, outcome id or message id (what `id` means depends on `kind`). */
  id: string;
  cardId: string | null;
  /** The one line a person reads. */
  title: string;
  detail: string;
  at: string;
  /** For an approval: what it is (an answer to give, an install to allow, ...). */
  approvalKind?: ApprovalKind;
}

export interface NeedsInput {
  approvals: Approval[];
  cards: Card[];
  messages: Message[];
  outcomes: Outcome[];
  /** Settings → Tools & review → "Hold cards in Review for me". */
  humanReview: boolean;
}

const cardTitle = (cards: Card[], id: string | null) => cards.find((c) => c.id === id)?.title ?? id ?? '';
const newest = (a: Need, b: Need) => b.at.localeCompare(a.at);

/** Approvals, then cards held for a human review, blocked cards, results to weigh, and agents' messages; newest first within each. */
export function needsFrom(input: NeedsInput): Need[] {
  const asked = new Set(input.approvals.filter((a) => a.kind === 'escalation').map((a) => a.cardId));
  const approvals: Need[] = input.approvals.map((a) => ({
    kind: 'approval',
    id: a.id,
    cardId: a.cardId,
    title: a.summary,
    detail: a.cardId ? `card: ${cardTitle(input.cards, a.cardId)}` : '',
    at: a.createdAt,
    approvalKind: a.kind,
  }));
  const review: Need[] = input.humanReview
    ? input.cards
        .filter((c) => c.status === 'review' && c.branch && !c.pipeline.humanReview && !c.pipeline.bestOf?.group)
        .map((c) => ({ kind: 'review', id: c.id, cardId: c.id, title: `Review: ${c.title}`, detail: 'finished; waiting for your verdict', at: c.updatedAt }))
    : [];
  const blocked: Need[] = input.cards
    .filter((c) => c.status === 'blocked' && !asked.has(c.id))
    .map((c) => ({ kind: 'blocked', id: c.id, cardId: c.id, title: `Blocked: ${c.title}`, detail: c.narration ?? '', at: c.updatedAt }));
  const outcomes: Need[] = input.outcomes.map((o) => ({
    kind: 'outcome',
    id: String(o.id),
    cardId: o.cardId,
    title: `Weigh a result: ${cardTitle(input.cards, o.cardId)}`,
    detail: `${o.agentId} · ${o.result}`,
    at: o.createdAt,
  }));
  const messages: Need[] = input.messages
    .filter((m) => m.toCard === null && !m.fromActor.startsWith('user:'))
    .map((m) => ({ kind: 'message', id: m.id, cardId: m.fromActor.startsWith('card:') ? m.fromActor.slice(5) : null, title: m.body.split('\n')[0]!.slice(0, 200), detail: m.fromActor, at: m.createdAt }));
  return [approvals, review, blocked, outcomes, messages].flatMap((list) => list.sort(newest));
}

/** Loads what `needsFrom` needs. Parts a daemon cannot supply count as empty. */
export async function loadNeeds(api: DaemonApi, boardId: string): Promise<Need[]> {
  const [approvals, cards, messages, outcomes, settings] = await Promise.all([
    api.approvals(boardId).catch(() => []),
    api.cards(boardId),
    api.messages(boardId).catch(() => []),
    api.pendingOutcomes(boardId).catch(() => []),
    api.settings(boardId).catch(() => null),
  ]);
  return needsFrom({ approvals, cards, messages, outcomes, humanReview: settings?.humanReview ?? false });
}
