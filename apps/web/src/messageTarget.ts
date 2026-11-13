import type { Message } from '@ih/core';

/** Where a message for the humans points: the thing the person has to look at. */
export type MessageTarget =
  | { kind: 'card'; cardId: string; label: string }
  | { kind: 'approvals'; label: string }
  | { kind: 'swarms'; label: string }
  | { kind: 'agents'; label: string }
  | { kind: 'settings'; tab: string; label: string }
  | { kind: 'none' };

const CARD_ID = /\bc_[0-9a-f]{6,}\b/g;

/**
 * Finds the issue a message is about. An agent's message points at its own card; a message from the daemon names the
 * card it concerns in its text, or belongs to a place (approvals, swarms, a settings tab) by who sent it.
 */
export function messageTarget(m: Pick<Message, 'fromActor' | 'body'>, cards: { id: string }[]): MessageTarget {
  const known = new Set(cards.map((c) => c.id));
  if (m.fromActor.startsWith('card:')) {
    const id = m.fromActor.slice(5);
    if (known.has(id)) return { kind: 'card', cardId: id, label: 'Open the card' };
  }
  for (const id of m.body.match(CARD_ID) ?? []) if (known.has(id)) return { kind: 'card', cardId: id, label: 'Open the card' };
  switch (m.fromActor) {
    case 'daemon:setup':
      return { kind: 'settings', tab: 'refinery', label: 'Open Settings → Refinery' };
    case 'daemon:budget':
      return { kind: 'settings', tab: 'budgets', label: 'Open Settings → Budgets' };
    case 'daemon:approvals':
    case 'daemon:grants':
      return { kind: 'approvals', label: 'Open Approvals' };
    case 'daemon:health':
      return { kind: 'agents', label: 'Open Agents' };
    case 'daemon:federation':
      return { kind: 'swarms', label: 'Open Swarms' };
    default:
      return { kind: 'none' };
  }
}
