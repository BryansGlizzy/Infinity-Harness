import { useEffect, useMemo, useState } from 'react';
import type { DaemonEvent } from '@ih/core';
import { api } from './api.ts';
import { subscribeEvents } from './activityBus.ts';
import { Row, toLog } from './CardPanel.tsx';
import { remember, saved } from './storage.ts';
import { useFollowBottom } from './useFollowBottom.ts';

/** How much history a box keeps and shows; the card panel has the rest. */
const KEEP = 1500;
const SHOW = 80;
const SIZE_KEY = 'ih.tree.activity.size';

const bySeq = (a: DaemonEvent, b: DaemonEvent) => a.seq - b.seq;

/** A card's recent events: loaded once, then kept up to date from the live stream (batched, so a chatty agent costs little). */
function useCardEvents(cardId: string): DaemonEvent[] {
  const [events, setEvents] = useState<DaemonEvent[]>([]);
  useEffect(() => {
    let alive = true;
    let loaded = false;
    let pending: DaemonEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const merge = (prev: DaemonEvent[], add: DaemonEvent[]) => {
      const seen = new Set(prev.map((e) => e.seq));
      const fresh = add.filter((e) => !seen.has(e.seq));
      if (!fresh.length) return prev;
      return [...prev, ...fresh].sort(bySeq).slice(-KEEP);
    };
    const flush = () => {
      timer = undefined;
      const add = pending;
      pending = [];
      if (alive && loaded && add.length) setEvents((prev) => merge(prev, add));
    };
    const off = subscribeEvents((e) => {
      if (e.subject !== cardId) return;
      pending.push(e);
      if (loaded && !timer) timer = setTimeout(flush, 250);
    });
    api.events(cardId).then(
      (list) => {
        if (!alive) return;
        loaded = true;
        const add = pending;
        pending = [];
        setEvents(merge(list, add));
      },
      () => {},
    );
    return () => {
      alive = false;
      off();
      if (timer) clearTimeout(timer);
    };
  }, [cardId]);
  return events;
}

function savedSize(): { width: number; height: number } {
  try {
    const s = JSON.parse(saved(SIZE_KEY) ?? 'null') as { width?: number; height?: number } | null;
    if (s && s.width && s.height) return { width: s.width, height: s.height };
  } catch {
    // fall through to the default
  }
  return { width: 360, height: 200 };
}

/**
 * The live activity of one card, in a box that hangs under its node in the tree. Drag its corner to resize (the size is
 * remembered); it follows the latest activity until you scroll up to read.
 */
export function NodeActivity({ cardId, titleOf, onOpen }: { cardId: string; titleOf: (cardId: string) => string; onOpen: () => void }) {
  const events = useCardEvents(cardId);
  const name = (actor: string) => (actor.startsWith('card:') ? titleOf(actor.slice(5)) : actor.startsWith('user:') ? 'you' : actor);
  const items = useMemo(() => toLog(events, cardId, name), [events, cardId]);
  const { ref, onScroll, behind, jump } = useFollowBottom<HTMLDivElement>(events.length, cardId) // events, not rows: a command's output grows its row;
  const [size] = useState(savedSize);

  return (
    // nodrag / nowheel / nopan: the canvas must not move or zoom while you drag the corner or scroll the list.
    <div
      className="tnode-activity nodrag nowheel nopan"
      style={{ width: size.width, height: size.height }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseUp={(e) => {
        const el = e.currentTarget;
        if (el.offsetWidth !== size.width || el.offsetHeight !== size.height) remember(SIZE_KEY, JSON.stringify({ width: el.offsetWidth, height: el.offsetHeight }));
      }}
    >
      <div className="tnode-activity-body" ref={ref} onScroll={onScroll}>
        {items.length === 0 ? (
          <p className="muted small">No activity yet.</p>
        ) : (
          <ol className="activity">
            {items.slice(-SHOW).map((item) => <Row key={item.key} item={item} name={name} />)}
          </ol>
        )}
      </div>
      <div className="tnode-activity-bar">
        {behind && <button className="jump-latest-inline" onClick={jump}>↓ latest</button>}
        <span className="spacer" />
        <button className="link small" onClick={onOpen}>Open card</button>
      </div>
    </div>
  );
}
