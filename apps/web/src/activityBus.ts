import type { DaemonEvent } from '@ih/core';

// The page's one live event stream, shared: the App publishes every event and anything that shows a card's activity
// (the card panel, the boxes in the tree) listens for its own card's.
const listeners = new Set<(e: DaemonEvent) => void>();

export function publishEvent(e: DaemonEvent) {
  for (const fn of listeners) fn(e);
}

export function subscribeEvents(fn: (e: DaemonEvent) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
