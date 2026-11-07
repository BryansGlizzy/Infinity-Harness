// Context capture and handoffs (master plan §5.7). Cards' specs and agents' end-of-turn summaries are saved as
// artifacts automatically (Memorix-style autopilot capture), so search_context finds them without agents writing
// anything; agents add decisions, contracts, findings and handoffs themselves through the board MCP.
import { renderHandoff, type Artifact, type Card, type DaemonEvent, type Handoff, type HarnessEvent } from '@mh/core';
import type { Store } from '@mh/db';
import type { ContextService } from '@mh/context';

const harness = (e: DaemonEvent) => (e.payload as { event: HarnessEvent }).event;

/** The agent's last message on a card (its summary of the turn), if any. */
export function lastAgentMessage(store: Store, cardId: string): string | null {
  const events = store.eventsFor(cardId).filter((e) => e.type === 'session.event' && e.actor.startsWith('agent:'));
  for (let i = events.length - 1; i >= 0; i--) {
    const h = harness(events[i]!);
    if (h.type === 'message' && h.role === 'agent' && h.text.trim()) return h.text.trim();
  }
  return null;
}

/** The current artifact of one kind on a card (the one not superseded yet). */
export function currentArtifact(store: Store, card: Pick<Card, 'id' | 'boardId'>, kind: Artifact['kind']): Artifact | undefined {
  return store.listArtifacts(card.boardId, { cardIds: [card.id], kinds: [kind], limit: 1 })[0];
}

/** Saves specs when cards are created or rewritten, and a summary whenever an agent's turn ends in Review. */
export function startCapture(store: Store, context: ContextService): () => void {
  return store.onEvent((e) => {
    try {
      if (e.type === 'card.created') {
        const card = e.payload as Card;
        context.put({ boardId: card.boardId, cardId: card.id, kind: 'spec', title: card.title, body: card.description || card.title, author: card.createdBy });
      }
      if (e.type === 'card.updated') {
        const { patch, card } = e.payload as { patch: Partial<Card>; card: Card };
        if (patch.title !== undefined || patch.description !== undefined) {
          const old = currentArtifact(store, card, 'spec');
          if (!old || old.title !== card.title || old.body !== (card.description || card.title)) {
            context.put({ boardId: card.boardId, cardId: card.id, kind: 'spec', title: card.title, body: card.description || card.title, author: e.actor, supersedes: old?.id });
          }
        }
        // The runner (actor "daemon") moves a card to Review when its agent finishes a turn.
        if (patch.status === 'review' && e.actor === 'daemon') {
          const text = lastAgentMessage(store, card.id);
          const old = currentArtifact(store, card, 'summary');
          if (text && old?.body !== text) {
            context.put({
              boardId: card.boardId,
              cardId: card.id,
              kind: 'summary',
              title: `Summary: ${card.title}`,
              body: text.slice(0, 8000),
              author: `agent:${card.agentId ?? card.poolId ?? 'unknown'}`,
              supersedes: old?.id,
            });
          }
        }
      }
    } catch (err) {
      console.warn(`context capture: ${(err as Error).message}`);
    }
  });
}

/** Files the card's agents edited, from their tool calls (repo-relative when inside the worktree). */
export function editedFiles(store: Store, card: Card): string[] {
  const files = new Set<string>();
  for (const e of store.eventsFor(card.id)) {
    if (e.type !== 'session.event') continue;
    const h = harness(e);
    if (h.type !== 'tool_call' || !['edit', 'delete', 'move'].includes(h.kind)) continue;
    for (const loc of h.locations) {
      const rel = card.worktree && loc.startsWith(`${card.worktree}/`) ? loc.slice(card.worktree.length + 1) : loc;
      files.add(rel);
    }
  }
  return [...files].slice(0, 40);
}

/**
 * The handoff required whenever a card moves to another agent (master plan §5.7): the daemon writes it from what
 * the card's log and artifacts show, and keeps the previous agent's own write_handoff note inside it.
 */
export function buildHandoff(store: Store, card: Card, reason: string, detail: string, base: string): { handoff: Handoff; body: string; own?: Artifact } {
  const lastSession = store.listSessions(card.id).at(-1);
  const current = currentArtifact(store, card, 'handoff');
  const own = current && current.author.startsWith('card:') && (!lastSession || current.createdAt >= lastSession.startedAt) ? current : undefined;
  const events = store.eventsFor(card.id).filter((e) => e.type === 'session.event');
  const errors = events
    .map(harness)
    .filter((h): h is Extract<HarnessEvent, { type: 'error' }> => h.type === 'error')
    .slice(-3)
    .map((e) => e.message.split('\n')[0]!.slice(0, 300));
  const summary = lastAgentMessage(store, card.id);
  const decisions = store
    .listArtifacts(card.boardId, { cardIds: [card.id], kinds: ['decision', 'contract', 'finding'] })
    .map((a) => `[${a.id}] ${a.kind}: ${a.title}${a.summary ? ` — ${a.summary}` : ''}`);
  const previous = card.agentId ?? card.poolId ?? 'unknown';
  const handoff: Handoff = {
    state: [
      `Reassigned because ${reason}. The previous agent was ${previous}.`,
      `Its work so far is committed on branch ${card.branch ?? '(none yet)'}.`,
      summary ? `Its last message:\n${summary.slice(-1500)}` : 'It left no closing message.',
    ].join('\n'),
    decisions,
    blockers: errors,
    files: editedFiles(store, card),
    nextSteps: [
      `Check \`git log ${base}..HEAD\` and \`git diff ${base}...HEAD\` to see the work so far.`,
      ...(decisions.length ? ['Read the decisions above (get_artifact) and keep to them unless they caused the failure.'] : []),
      'search_context finds decisions and contracts from this card and its sibling cards.',
      'Finish the task from where it stands.',
    ],
  };
  const body = [
    renderHandoff(handoff),
    detail ? `\n## Details\n${detail}` : '',
    own ? `\n## The previous agent's own handoff (${own.id})\n${own.body}` : '',
  ].join('\n');
  return { handoff, body, own };
}

/** Notes from earlier runs of this card, listed in a new run's prompt so its agent reads them first. */
export function priorNotes(store: Store, card: Card): Artifact[] {
  return store.listArtifacts(card.boardId, { cardIds: [card.id], kinds: ['handoff', 'decision', 'contract', 'finding'], limit: 12 });
}
