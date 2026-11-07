import { effectiveAgents, type Board, type Card, type Settings } from '@mh/core';
import { api, type ActiveSession, type PoolWithStatus } from './api.ts';
import { HARNESS_LABEL, ROLE_LABEL, shortModel } from './agentInfo.ts';
import { PoolHistory } from './PoolHistory.tsx';

export const WINDOW_LABEL: Record<string, string> = {
  rpm: 'Requests / min',
  tpm: 'Tokens / min',
  rpd: 'Requests / day',
  concurrency: 'In flight',
  '5h': '5-hour',
  '7d': 'Weekly',
  forced: 'Forced',
};

export function resetsIn(ms: number): string {
  const s = Math.max(0, Math.round((ms - Date.now()) / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.round(h / 24)} days`;
}

const KIND_LABEL = { subscription: 'subscription', api: 'API', local: 'local' } as const;

function PoolCard(props: { pool: PoolWithStatus; settings: Settings | null; pools: PoolWithStatus[]; sessions: ActiveSession[]; cards: Card[]; boardId: string; onSelect: (id: string) => void; onError: (m: string) => void }) {
  const { pool, settings } = props;
  const slots = settings?.poolSlots[pool.id] ?? 1;
  const mine = props.sessions.filter((s) => s.poolId === pool.id);
  const working = mine.filter((s) => s.state === 'working');
  const agents = settings ? effectiveAgents(settings, props.pools).filter((a) => a.poolId === pool.id) : [];
  const forced = pool.status.windows.find((w) => w.window === 'forced');
  const force = async (pct: number | null) => {
    try {
      await api.forcePool(pool.id, pct);
    } catch (err) {
      props.onError((err as Error).message);
    }
  };
  return (
    <article className={`pool-card ${pool.status.state}`}>
      <header className="row nowrap">
        <span className={`chip pool ${pool.status.state}`}><span className="dot" />{pool.status.state}</span>
        <h4>{pool.label}</h4>
        <span className="muted small ellipsis">{KIND_LABEL[pool.kind]} · default {shortModel(pool.model)}</span>
      </header>
      <div className="row nowrap">
        <div className="slots" aria-label={`${working.length} of ${slots} slots working`}>
          {Array.from({ length: Math.max(slots, working.length) }, (_, i) => (
            <span key={i} className={`slot ${i < working.length ? 'busy' : ''} ${i >= slots ? 'over' : ''}`} title={working[i] ? `working: ${working[i]!.boardName}` : 'free'} />
          ))}
          <span className="muted small">{working.length}/{slots} slots working{mine.length > working.length ? ` · ${mine.length - working.length} idle` : ''}</span>
        </div>
        <span className="spacer" />
        {forced ? (
          <button className="ghost small-btn" onClick={() => force(null)} title="Stop forcing this pool's usage">Clear forced {forced.pct}%</button>
        ) : (
          <button className="ghost small-btn" onClick={() => force(95)} title="Halt the pool so new cards flow elsewhere">Force 95%</button>
        )}
      </div>

      {pool.status.windows.length > 0 ? (
        <div className="windows">
          {pool.status.windows.map((w) => (
            <div key={w.window} className="window">
              <span className="muted small">{WINDOW_LABEL[w.window] ?? w.window}</span>
              <span className="gauge wide"><span style={{ width: `${Math.min(100, w.pct)}%` }} className={w.pct >= 95 ? 'bad' : w.pct >= 80 ? 'warn' : ''} /></span>
              <span className="small">
                {w.limit === 100 && w.window !== 'concurrency' ? `${Math.round(w.pct)}%` : `${w.used}/${w.limit}`}
                {w.resetsAt ? <span className="muted"> · resets in {resetsIn(w.resetsAt)}</span> : null}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted small">No usage windows reported yet.</p>
      )}
      {pool.status.lockedUntil && <p className="small error">Locked until {new Date(pool.status.lockedUntil).toLocaleTimeString()}</p>}

      <PoolHistory poolId={pool.id} />

      <div className="pool-section">
        <span className="muted small">Agents on this pool</span>
        {agents.length ? (
          <ul className="plain">
            {agents.map((a) => (
              <li key={a.id} className={a.enabled ? '' : 'muted'}>
                <span className={`role-tag ${a.role}`}>{ROLE_LABEL[a.role]}</span> <strong>{a.id}</strong> <span className="muted">{shortModel(a.model || pool.model)}{a.reasoning ? ` · ${a.reasoning}` : ''}{a.enabled ? '' : ' · off'}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">None.</p>
        )}
      </div>

      <div className="pool-section">
        <span className="muted small">Working on</span>
        {mine.length ? (
          <ul className="plain">
            {mine.map((s) => {
              const card = s.boardId === props.boardId ? props.cards.find((c) => c.id === s.cardId) : undefined;
              return (
                <li key={`${s.kind}-${s.cardId}`}>
                  <span className={`badge ${s.state === 'working' ? 'in_progress' : ''}`}>{s.kind === 'review' ? 'reviewing' : s.state}</span>{' '}
                  {card ? <button className="link" onClick={() => props.onSelect(card.id)}>{card.title}</button> : <span>{s.cardId}</span>}
                  <span className="muted small"> · {s.boardName}{s.model ? ` · ${shortModel(s.model)}` : ''}{s.reasoning ? ` · ${s.reasoning}` : ''}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted small">Nothing right now.</p>
        )}
      </div>
    </article>
  );
}

export function PoolsView(props: { boards: Board[]; boardId: string; settings: Settings | null; pools: PoolWithStatus[]; sessions: ActiveSession[]; cards: Card[]; onSelect: (id: string) => void; onError: (m: string) => void }) {
  const harnesses = [...new Set(props.pools.map((p) => p.harness))];
  return (
    <div className="page pools-page">
      <div className="page-head">
        <div>
          <h2>Pools</h2>
          <p className="muted small">
            Every pool the daemon found, grouped by harness: usage windows and when they reset, slots in use, the agents on it and what they're working on across all {props.boards.length} board(s).
            Pools at 95% of any window take no new cards.
          </p>
        </div>
      </div>
      {!props.pools.length && (
        <div className="empty-state">
          <h3>No pools found</h3>
          <p className="muted">Sign in to at least one agent CLI (Claude Code, Codex, Kimi, agy) or set API keys in <code>.env</code>, then restart the daemon. The README lists what each pool needs.</p>
        </div>
      )}
      <div className="harness-groups">
      {harnesses.map((h) => (
        <section key={h} className="harness-group">
          <h3>{HARNESS_LABEL[h] ?? h}</h3>
          <div className="pool-grid">
            {props.pools
              .filter((p) => p.harness === h)
              .map((p) => (
                <PoolCard key={p.id} pool={p} settings={props.settings} pools={props.pools} sessions={props.sessions} cards={props.cards} boardId={props.boardId} onSelect={props.onSelect} onError={props.onError} />
              ))}
          </div>
        </section>
      ))}
      </div>
    </div>
  );
}
