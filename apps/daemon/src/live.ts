import type { LiveMessage } from '@mh/core';

/** Ephemeral updates (pool gauges, lease changes) pushed to UI clients but not written to the event log. */
export class Live {
  private listeners = new Set<(m: LiveMessage) => void>();

  publish(type: LiveMessage['type'], subject: string, payload: unknown) {
    const message: LiveMessage = { live: true, type, subject, payload, ts: new Date().toISOString() };
    for (const fn of this.listeners) fn(message);
  }

  subscribe(fn: (m: LiveMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
