import type { Card, ChatItem, HarnessEvent, Message } from '@ih/core';
import type { Store } from '@ih/db';

// A conversation view of a goal (master plan Phase 6.1): what the agents said, what the humans said back, and the
// questions agents asked the human, across the goal's whole card tree, in time order. The VS Code chat view renders it.

const STATUS_TEXT: Partial<Record<Card['status'], string>> = {
  in_progress: 'started working',
  review: 'finished and is ready for review',
  merging: 'is in the merge queue',
  done: 'is done',
  blocked: 'is blocked',
};

/** The card and everything below it. */
export function subtree(store: Store, rootId: string): Card[] {
  const out: Card[] = [];
  const stack = [store.getCard(rootId)].filter((c): c is Card => !!c);
  while (stack.length) {
    const c = stack.pop()!;
    out.push(c);
    stack.push(...store.children(c.id));
  }
  return out;
}

export function buildChat(store: Store, rootId: string, afterSeq = 0, limit = 400): ChatItem[] {
  const cards = subtree(store, rootId);
  const title = new Map(cards.map((c) => [c.id, c.title]));
  const items: ChatItem[] = [];
  const seen = new Set<string>();
  const boardId = cards[0]?.boardId;
  const subjects = [...cards.map((c) => c.id), ...(boardId ? [boardId] : [])];
  for (const subject of subjects) {
    for (const e of store.eventsFor(subject, afterSeq)) {
      if (e.type === 'session.event') {
        const ev = (e.payload as { event?: HarnessEvent }).event;
        if (ev?.type !== 'message' || ev.role !== 'agent' || !ev.text.trim() || e.actor === 'daemon') continue;
        items.push({ seq: e.seq, ts: e.ts, kind: 'agent', cardId: subject, cardTitle: title.get(subject) ?? subject, text: ev.text.trim() });
      } else if (e.type === 'message.posted') {
        const m = e.payload as Message;
        if (seen.has(m.id)) continue;
        const fromCard = m.fromActor.startsWith('card:') ? m.fromActor.slice(5) : null;
        const inTree = (id: string | null) => !!id && title.has(id);
        if (m.fromActor.startsWith('user:') && inTree(m.toCard)) {
          seen.add(m.id);
          items.push({ seq: e.seq, ts: m.createdAt, kind: 'you', cardId: m.toCard!, cardTitle: title.get(m.toCard!)!, text: m.body, messageId: m.id });
        } else if (m.toCard === null && fromCard && inTree(fromCard)) {
          seen.add(m.id);
          items.push({ seq: e.seq, ts: m.createdAt, kind: 'ask', cardId: fromCard, cardTitle: title.get(fromCard)!, text: m.body, messageId: m.id });
        } else if (m.toCard === null && !fromCard && !m.fromActor.startsWith('user:') && subject === boardId) {
          seen.add(m.id);
          // Board notices name their card in parentheses ("Title (c_abc, Pool)"); keep those that name one of this goal's.
          const named = cards.find((c) => m.body.includes(`(${c.id}`));
          if (named) items.push({ seq: e.seq, ts: m.createdAt, kind: 'note', cardId: named.id, cardTitle: named.title, text: m.body, messageId: m.id });
        }
      } else if (e.type === 'card.updated' && title.has(subject)) {
        const patch = (e.payload as { patch?: Partial<Card> }).patch;
        const text = patch?.status ? STATUS_TEXT[patch.status] : undefined;
        if (text) items.push({ seq: e.seq, ts: e.ts, kind: 'status', cardId: subject, cardTitle: title.get(subject)!, text });
      }
    }
  }
  items.sort((a, b) => a.seq - b.seq);
  // A question is answered once a human wrote to that card after it.
  for (const q of items.filter((i) => i.kind === 'ask')) q.answered = items.some((i) => i.kind === 'you' && i.cardId === q.cardId && i.seq > q.seq);
  return items.slice(-limit);
}
