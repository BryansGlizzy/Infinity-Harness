import { useState } from 'react';
import type { Approval, Card, Lease, Message, Outcome } from '@mh/core';
import type { PoolWithStatus } from './api.ts';
import { ApprovalsPanel } from './ApprovalsPanel.tsx';
import { WeighButtons } from './CardPanel.tsx';

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
  return (
    <span className={`chip pool ${status.state}`} title={title}>
      <span className="dot" />
      {pool.label}
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
  onSelect: (cardId: string) => void;
  onError: (m: string) => void;
}) {
  const [inboxOpen, setInboxOpen] = useState(false);
  const [weighOpen, setWeighOpen] = useState(false);
  const [approvalsOpen, setApprovalsOpen] = useState(false);
  const pending = props.pendingOutcomes;
  const title = (id: string) => props.cards.find((c) => c.id === id)?.title ?? id;
  const unread = props.humanMessages.length;

  return (
    <div className="strip">
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
      {props.approvals.length > 0 && (
        <button className="ghost attention" onClick={() => setApprovalsOpen((o) => !o)} aria-expanded={approvalsOpen}>
          Approvals ({props.approvals.length})
        </button>
      )}
      {approvalsOpen && props.approvals.length > 0 && <ApprovalsPanel approvals={props.approvals} cards={props.cards} onSelect={props.onSelect} onError={props.onError} />}
      {pending.length > 0 && (
        <button className="ghost" onClick={() => setWeighOpen((o) => !o)} aria-expanded={weighOpen}>
          Blocks to weigh ({pending.length})
        </button>
      )}
      {weighOpen && pending.length > 0 && (
        <div className="inbox" role="dialog" aria-label="Blocks to weigh">
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
      <button className="ghost" onClick={() => setInboxOpen((o) => !o)} aria-expanded={inboxOpen}>
        Messages for you{unread ? ` (${unread})` : ''}
      </button>
      {inboxOpen && (
        <div className="inbox" role="dialog" aria-label="Messages for the humans">
          {unread === 0 && <p className="muted">No messages from agents yet.</p>}
          {[...props.humanMessages].reverse().map((m) => {
            const from = m.fromActor.startsWith('card:') ? m.fromActor.slice(5) : null;
            return (
              <div key={m.id} className="inbox-item">
                <div className="muted">
                  {from ? <button className="link" onClick={() => props.onSelect(from)}>{title(from)}</button> : m.fromActor}
                  {' · '}
                  {new Date(m.createdAt).toLocaleTimeString()}
                </div>
                <div>{m.body}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
