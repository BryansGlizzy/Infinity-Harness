import { useEffect, useRef, useState } from 'react';
import type { Approval, Card, Lease, Message, Outcome } from '@ih/core';
import type { PoolWithStatus } from './api.ts';
import { ApprovalsPanel } from './ApprovalsPanel.tsx';
import { WeighButtons } from './CardPanel.tsx';
import { messageTarget, type MessageTarget } from './messageTarget.ts';

const WINDOW_LABEL: Record<string, string> = {
  rpm: 'req/min',
  tpm: 'tok/min',
  rpd: 'req/day',
  concurrency: 'in flight',
  '5h': '5-hour',
  '7d': 'weekly',
  forced: 'forced',
};

function PoolChip({ pool }: { pool: PoolWithStatus }) {
  const { status } = pool;
  const top = status.windows.reduce((a, w) => (w.pct > (a?.pct ?? -1) ? w : a), status.windows[0]);
  const title = [
    `${pool.label} · ${pool.model} · ${status.state}`,
    `${pool.running} session(s) working`,
    ...status.windows.map((w) =>
      w.limit === 100 && w.window !== 'concurrency' ? `${WINDOW_LABEL[w.window] ?? w.window}: ${w.pct}%` : `${WINDOW_LABEL[w.window] ?? w.window}: ${w.used}/${w.limit} (${w.pct}%)`,
    ),
    status.queued ? `${status.queued} request(s) queued` : '',
    status.lockedUntil ? `locked until ${new Date(status.lockedUntil).toLocaleTimeString()}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const out = pool.health?.ejected;
  return (
    <span className={`chip pool ${out ? 'halted offline' : status.state}`} title={out ? `${title}\nOut of rotation since ${new Date(out.since).toLocaleTimeString()}: ${out.reason}\nTurn it back on in Agents.` : title}>
      <span className="dot" />
      {pool.label}
      {out && <span className="muted">out</span>}
      {top && (
        <span className="gauge" aria-label={`${top.pct}% of ${WINDOW_LABEL[top.window] ?? top.window}`}>
          <span style={{ width: `${Math.min(100, top.pct)}%` }} />
        </span>
      )}
      {top && <span className="muted">{WINDOW_LABEL[top.window] ?? top.window} {Math.round(top.pct)}%</span>}
      {pool.running > 0 && <span className="running" title={`${pool.running} working`}>{pool.running}▸</span>}
      {status.queued > 0 && <span className="muted">+{status.queued}</span>}
    </span>
  );
}

export function StatusStrip(props: {
  pools: PoolWithStatus[];
  leases: Lease[];
  cards: Card[];
  humanMessages: Message[];
  /** Agents' blocks waiting for a human to weigh them for routing. */
  pendingOutcomes: Outcome[];
  /** Requests waiting for a decision (Phase 6.4). */
  approvals: Approval[];
  /** Swarms knocking and peer requests waiting for a decision (Phase 7). */
  swarmWaiting?: number;
  onOpenSwarms?: () => void;
  onOpenAgents?: () => void;
  /** Opens a settings tab (a message about a setting goes straight there). */
  onOpenSettings?: (tab: string) => void;
  /** Clears messages for the humans: the given ids, or all of them. */
  onDismiss: (ids?: string[]) => void;
  onSelect: (cardId: string) => void;
  onError: (m: string) => void;
}) {
  const [openMenu, setOpenMenu] = useState<'inbox' | 'weigh' | 'approvals' | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const inboxOpen = openMenu === 'inbox';
  const weighOpen = openMenu === 'weigh';
  const approvalsOpen = openMenu === 'approvals';
  const toggleMenu = (m: 'inbox' | 'weigh' | 'approvals') => setOpenMenu((cur) => (cur === m ? null : m));

  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent) => {
      if (stripRef.current && !stripRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [openMenu]);

  const pending = props.pendingOutcomes;
  const title = (id: string) => props.cards.find((c) => c.id === id)?.title ?? id;
  const unread = props.humanMessages.length;
  /** Takes the person to what a message is about, and clears it from the list (they have looked at it). */
  const go = (target: MessageTarget) => {
    if (target.kind === 'none') return;
    setOpenMenu(null);
    if (target.kind === 'card') props.onSelect(target.cardId);
    else if (target.kind === 'swarms') props.onOpenSwarms?.();
    else if (target.kind === 'agents') props.onOpenAgents?.();
    else if (target.kind === 'settings') props.onOpenSettings?.(target.tab);
    else setOpenMenu('approvals');
  };

  return (
    <div className="strip" ref={stripRef}>
      <span className="label">Pools</span>
      {props.pools.map((p) => <PoolChip key={p.id} pool={p} />)}
      <span className="label">Leases</span>
      {props.leases.length === 0 && <span className="muted">none</span>}
      {props.leases.map((l) => (
        <button key={l.id} className="chip lease" onClick={() => props.onSelect(l.cardId)} title={`expires ${new Date(l.expiresAt).toLocaleTimeString()}`}>
          <code>{l.glob}</code> · {title(l.cardId)}
        </button>
      ))}
      <span className="spacer" />
      {!!props.swarmWaiting && (
        <button className="ghost attention" onClick={props.onOpenSwarms} title="Another swarm wants to connect, or sent a request">
          Swarms ({props.swarmWaiting})
        </button>
      )}
      {props.approvals.length > 0 && (
        <button className={`ghost attention ${approvalsOpen ? 'on' : ''}`} onClick={() => toggleMenu('approvals')} aria-expanded={approvalsOpen}>
          Approvals ({props.approvals.length})
        </button>
      )}
      {approvalsOpen && props.approvals.length > 0 && <ApprovalsPanel approvals={props.approvals} cards={props.cards} onSelect={props.onSelect} onError={props.onError} />}
      {pending.length > 0 && (
        <button className={`ghost attention ${weighOpen ? 'on' : ''}`} onClick={() => toggleMenu('weigh')} aria-expanded={weighOpen}>
          Blocks to weigh ({pending.length})
        </button>
      )}
      {weighOpen && pending.length > 0 && (
        <div className="inbox" role="dialog" aria-label="Blocks to weigh">
          <div className="inbox-head">
            <strong>Blocks to weigh ({pending.length})</strong>
          </div>
          <p className="muted small">
            These agents reported their card blocked. Routing ignores them until you decide: <strong>Pass</strong> if the block was justified (counts as a
            success for that model), <strong>Fail</strong> if it should have done the work, <strong>Ignore</strong> to leave it out.
          </p>
          {pending.map((o) => (
            <div key={o.id} className="inbox-item">
              <div className="muted">
                <button className="link" onClick={() => props.onSelect(o.cardId)}>{title(o.cardId)}</button>
                {' · '}
                {o.agentId} ({o.model.split('/').pop()}) · {o.workType} · {new Date(o.createdAt).toLocaleTimeString()}
              </div>
              {o.note && <div>{o.note}</div>}
              <WeighButtons outcome={o} onError={props.onError} />
            </div>
          ))}
        </div>
      )}
      <button className={`ghost ${unread > 0 ? 'has-unread' : ''} ${inboxOpen ? 'on' : ''}`} onClick={() => toggleMenu('inbox')} aria-expanded={inboxOpen}>
        Messages for you{unread ? ` (${unread})` : ''}
      </button>
      {inboxOpen && (
        <div className="inbox" role="dialog" aria-label="Messages for the humans">
          <div className="inbox-head">
            <strong>Messages for you</strong>
            {unread > 0 && (
              <button className="ghost small" onClick={() => props.onDismiss()} title="Clear every message from this list. They stay in each card's activity.">
                Clear all ({unread})
              </button>
            )}
          </div>
          {unread === 0 && <p className="muted">Nothing waiting. Messages from agents appear here.</p>}
          {[...props.humanMessages].reverse().map((m) => {
            const target = messageTarget(m, props.cards);
            const from = m.fromActor.startsWith('card:') ? m.fromActor.slice(5) : null;
            const open = target.kind !== 'none';
            return (
              <div
                key={m.id}
                className={`inbox-item ${open ? 'clickable' : ''}`}
                role={open ? 'button' : undefined}
                tabIndex={open ? 0 : undefined}
                title={open ? target.label : undefined}
                onClick={open ? () => go(target) : undefined}
                onKeyDown={open ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), go(target)) : undefined}
              >
                <div className="inbox-meta muted">
                  <span>
                    {from ? title(from) : m.fromActor}
                    {' · '}
                    {new Date(m.createdAt).toLocaleTimeString()}
                  </span>
                  <button
                    className="ghost icon-btn small"
                    aria-label="Clear this message"
                    title="Clear"
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onDismiss([m.id]);
                    }}
                  >
                    ✕
                  </button>
                </div>
                <div>{m.body}</div>
                {open && <div className="inbox-go">{target.label} →</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
