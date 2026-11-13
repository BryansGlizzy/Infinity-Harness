import { useEffect, useRef, useState, type FormEvent } from 'react';
import { remember, saved } from './storage.ts';
import { useFollowBottom } from './useFollowBottom.ts';
import {
  CARD_STATUSES,
  effectiveAgents,
  type Artifact,
  type Card,
  type CardStatus,
  type DaemonEvent,
  type Dependency,
  type HarnessEvent,
  type Lease,
  type Message,
  type Outcome,
  type RoutingRules,
  type Settings,
} from '@ih/core';
import { api, type ActiveSession, type Candidate, type CardChanges, type ModelCatalog, type PoolWithStatus, type SearchHit } from './api.ts';
import { MentionInput } from './Mentions.tsx';
import { ModelSelect } from './AgentsView.tsx';
import { ROLE_LABEL, cardAgent } from './agentInfo.ts';
import { STATUS_LABEL } from './BoardView.tsx';
import { TerminalView } from './TerminalView.tsx';
import { ReviewControls } from './ReviewControls.tsx';
import { complexityLabel } from './labels.ts';

const ROLE_TEXT = { orchestrator: 'Orchestrator (plans, does not code)', lead: 'Lead (breaks its chunk into cards, does not code)', worker: 'Worker' };

/**
 * The card's routing rules: its own, or the nearest ancestor's (shown with where they come from). Each agent or
 * pool can be required ("only") or avoided; editing an inherited rule set makes it the card's own.
 */
function RulesEditor(props: { card: Card; cards: Card[]; entries: string[]; onSelect: (id: string) => void; onError: (m: string) => void }) {
  const { card } = props;
  let from: Card | undefined;
  for (let c: Card | undefined = card; c; c = c.parentId ? props.cards.find((x) => x.id === c!.parentId) : undefined) {
    if (c.routing) {
      from = c;
      break;
    }
  }
  const rules: RoutingRules = from?.routing ?? {};
  const own = from?.id === card.id;
  const entries = [...new Set([...props.entries, ...(rules.pools ?? []), ...(rules.avoid ?? [])])];
  const stateOf = (e: string) => (rules.pools?.includes(e) ? 'only' : rules.avoid?.includes(e) ? 'avoid' : '');
  const save = (routing: RoutingRules | null) => api.setRouting(card.id, routing).catch((err: Error) => props.onError(err.message));
  const set = (entry: string, state: string) => {
    const pools = (rules.pools ?? []).filter((e) => e !== entry);
    const avoid = (rules.avoid ?? []).filter((e) => e !== entry);
    if (state === 'only') pools.push(entry);
    if (state === 'avoid') avoid.push(entry);
    void save(pools.length || avoid.length ? { ...(pools.length ? { pools } : {}), ...(avoid.length ? { avoid } : {}) } : null);
  };
  return (
    <div className="rules">
      <div className="row small">
        <span className="muted">Rules:</span>
        {!from && <span className="muted">none (any agent)</span>}
        {from && !own && (
          <span className="muted">
            inherited from <button className="link" onClick={() => props.onSelect(from!.id)}>{from.title}</button>
          </span>
        )}
        {own && <span className="muted">set on this card</span>}
        {own && <button className="ghost small-btn" onClick={() => void save(null)}>Inherit</button>}
      </div>
      <div className="rule-grid">
        {entries.map((e) => (
          <label key={e} className={`rule ${stateOf(e)}`}>
            {e}
            <select value={stateOf(e)} onChange={(ev) => set(e, ev.target.value)} aria-label={`Rule for ${e}`} disabled={card.status === 'in_progress'}>
              <option value="">any</option>
              <option value="only">only</option>
              <option value="avoid">avoid</option>
            </select>
          </label>
        ))}
      </div>
    </div>
  );
}

/** Kev's classification, the latest routing decision with per-agent reasons, the routing rules and dependencies. */
function Routing(props: {
  card: Card;
  events: DaemonEvent[];
  dependencies: Dependency[];
  cards: Card[];
  ruleEntries: string[];
  onSelect: (id: string) => void;
  onError: (m: string) => void;
}) {
  const { card } = props;
  const [preview, setPreview] = useState<Candidate[] | null>(null);
  const routed = [...props.events].reverse().find((e) => e.type === 'card.routed')?.payload as
    | { poolId: string; agentId?: string; rerouted: boolean; candidates: Candidate[] }
    | undefined;
  const chosen = (cand: Candidate) => !!routed && (cand.agentId ?? cand.poolId) === (routed.agentId ?? routed.poolId);
  const candidates = routed?.candidates ?? preview;
  const title = (id: string) => props.cards.find((c) => c.id === id)?.title ?? id;
  const statusOf = (id: string) => props.cards.find((c) => c.id === id)?.status;
  const waitsFor = props.dependencies.filter((d) => d.cardId === card.id).map((d) => d.blockedBy);
  const blocks = props.dependencies.filter((d) => d.blockedBy === card.id).map((d) => d.cardId);
  const c = card.classification;

  useEffect(() => setPreview(null), [card.id]);

  return (
    <details className="routing" open={card.role !== 'orchestrator'}>
      <summary>Routing</summary>
      <dl className="facts">
        <dt>Role</dt><dd>{ROLE_TEXT[card.role]}</dd>
        {card.agentId && <><dt>Agent</dt><dd>{card.agentId}{card.poolId && card.poolId !== card.agentId ? <span className="muted"> on {card.poolId}</span> : ''}</dd></>}
        {c && (
          <>
            <dt>Work type</dt>
            <dd>
              {c.workType}
              {Object.keys(c.workTypeProbs).length > 0 && (
                <span className="muted"> · {Object.entries(c.workTypeProbs).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(', ')}</span>
              )}
            </dd>
            <dt>Complexity</dt>
            <dd>{complexityLabel(c.complexity)} <span className="muted">({c.complexity.toFixed(2)} of 4{c.source === 'fallback' ? ', Kev unreachable: default' : ''})</span></dd>
            <dt>Needs review</dt>
            <dd>{Math.round(c.needsReview * 100)}%</dd>
            {c.frontend !== undefined && c.frontend >= 0.2 && <><dt>Front-end</dt><dd>{Math.round(c.frontend * 100)}%</dd></>}
          </>
        )}
        {card.role !== 'orchestrator' && !c && <><dt>Kev</dt><dd className="muted">classifying…</dd></>}
        {waitsFor.length > 0 && (
          <>
            <dt>Waits for</dt>
            <dd>{waitsFor.map((id) => <button key={id} className="link dep-link" onClick={() => props.onSelect(id)}>{title(id)} ({STATUS_LABEL[statusOf(id) ?? 'backlog']})</button>)}</dd>
          </>
        )}
        {blocks.length > 0 && (
          <>
            <dt>Blocks</dt>
            <dd>{blocks.map((id) => <button key={id} className="link dep-link" onClick={() => props.onSelect(id)}>{title(id)}</button>)}</dd>
          </>
        )}
      </dl>
      {card.role !== 'orchestrator' && <RulesEditor card={card} cards={props.cards} entries={props.ruleEntries} onSelect={props.onSelect} onError={props.onError} />}
      {card.role !== 'orchestrator' && !routed && (
        <button className="ghost small-btn" onClick={() => api.route(card.id).then(setPreview, () => {})}>How would it route now?</button>
      )}
      {candidates && (
        <table className="cands">
          <tbody>
            {candidates.map((cand) => (
              <tr key={cand.agentId ?? cand.poolId} className={cand.eligible ? (chosen(cand) ? 'chosen' : '') : 'ineligible'}>
                <td title={cand.model}>
                  {cand.agentId ?? cand.poolId}
                  {chosen(cand) ? (routed!.rerouted ? ' ↻' : ' ✓') : ''}
                  {cand.agentId && cand.agentId !== cand.poolId && <div className="muted">{cand.poolId}</div>}
                </td>
                <td>{cand.eligible ? cand.score.toFixed(3) : '—'}</td>
                <td className="muted">{cand.reasons.join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}

/** One step of review and landing, as the refinery logs it. */
type RefineryStep = { step: string; [key: string]: any };

function refineryLine(r: RefineryStep): { text: string; tone?: 'ok' | 'bad' } | null {
  const by = r.agentId ? ` by ${r.agentId}${r.model ? ` (${r.model})` : ''}` : '';
  switch (r.step) {
    case 'review':
      return { text: `Review round ${r.round}${by}` };
    case 'changes_requested':
      return { text: `Changes requested${r.human ? ' by you' : by}: ${String(r.notes ?? '').slice(0, 300)}`, tone: 'bad' };
    case 'approved':
      return { text: r.human ? `Approved by you${r.notes ? `: ${String(r.notes).slice(0, 300)}` : ''}` : `Approved${by}${r.reason ? ` (${r.reason})` : ''}`, tone: 'ok' };
    case 'land_now':
      return { text: 'Land now: skips the review, front of the queue' };
    case 'best_of':
      return { text: `Best-of-N: ${r.detail}` };
    case 'best_of_judged':
      return { text: `Best-of-N judged: winner ${r.winner}; scores ${Object.entries(r.scores ?? {}).map(([k, v]) => `${k} ${v}`).join(', ')}`, tone: 'ok' };
    case 'review_limit':
      return { text: `Review still asks for changes after the last round; landing anyway (tests still gate it)` };
    case 'review_skipped':
      return { text: `Review skipped: ${r.reason}` };
    case 'review_failed':
      return { text: `Review failed${by}: ${r.message}; landing without it`, tone: 'bad' };
    case 'queued':
      return { text: 'Queued to land' };
    case 'waiting':
      return { text: `Waiting: ${r.reason}` };
    case 'updating':
      return { text: `Bringing up to date with ${r.base} (${r.mode === 'pr' ? 'GitHub PR' : 'local'})` };
    case 'conflict':
      return { text: `Conflicts with ${r.base}: ${(r.files ?? []).join(', ')}`, tone: 'bad' };
    case 'testing':
      return { text: `Running tests: ${r.command}` };
    case 'tests_failed':
      return { text: `Tests failed${r.timedOut ? ' (timed out)' : ''}${r.triage?.cause ? `: ${r.triage.cause}` : ''}`, tone: 'bad' };
    case 'pr':
      return { text: `PR opened: ${r.url}` };
    case 'landed':
      return { text: r.sha ? `Landed ${String(r.sha).slice(0, 8)}${r.note ? ` (${r.note})` : ''}` : `Done: ${r.reason}`, tone: 'ok' };
    case 'reassigned':
      return { text: `Reassigned from ${r.from ?? '?'}: ${r.reason}` };
    case 'escalated':
      return { text: `Needs a human: ${r.reason}`, tone: 'bad' };
    case 'error':
      return { text: `Refinery error: ${r.message}`, tone: 'bad' };
    default:
      return null;
  }
}

const RESULT_TEXT: Record<Outcome['result'], string> = {
  landed: 'landed',
  failed_run: 'run failed',
  failed_landing: 'landing failed',
  escalated: 'escalated',
  blocked: 'reported blocked',
};
const REVIEW_TEXT = { pending: 'waiting for you to weigh it', pass: 'weighed: pass', fail: 'weighed: fail', ignore: 'weighed: ignored' };

export function outcomeText(o: Outcome): string {
  return [
    RESULT_TEXT[o.result],
    o.review ? REVIEW_TEXT[o.review] : '',
    o.review === 'pending' || o.review === 'ignore' ? '' : `value ${o.value.toFixed(2)}`,
    o.note ? `“${o.note.slice(0, 160)}”` : '',
    o.quality !== null ? `Kev quality ${Math.round(o.quality * 100)}%` : '',
    o.inScope !== null ? `in scope ${Math.round(o.inScope * 100)}%` : '',
    o.changesRequested ? `${o.changesRequested} change request(s)` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

const KIND_ORDER: Artifact['kind'][] = ['handoff', 'decision', 'contract', 'finding', 'note', 'summary', 'spec'];

const STATUS_NAME: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed' };

/** A unified diff with added and removed lines coloured. */
function DiffText({ text }: { text: string }) {
  if (!text.trim()) return <p className="muted small">No textual changes.</p>;
  return (
    <pre className="diff">
      {text.split('\n').map((line, i) => {
        const cls = line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') ? 'meta' : line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : '';
        return <div key={i} className={cls}>{line || ' '}</div>;
      })}
    </pre>
  );
}

/**
 * What the card's work changed: for a landed card, its merge into the default branch; otherwise its branch against
 * where it forked. Files with line counts, the commits, and per file the diff or the whole file at that version.
 */
function ChangesView({ card, events, onError }: { card: Card; events: DaemonEvent[]; onError: (m: string) => void }) {
  const [changes, setChanges] = useState<CardChanges | null>(null);
  const [open, setOpen] = useState<{ path: string; mode: 'diff' | 'file'; text: string } | null>(null);
  // Work is committed when a turn ends, and lands later: refresh on those.
  const marks = events.filter((e) => e.type === 'session.ended' || e.type === 'card.refinery' || (e.type === 'session.event' && /Committed |Direct mode: the edits/.test(JSON.stringify(e.payload)))).length;

  useEffect(() => {
    let alive = true;
    api.changes(card.id).then((c) => alive && setChanges(c), (e: Error) => onError(e.message));
    return () => {
      alive = false;
    };
  }, [card.id, marks]);
  useEffect(() => setOpen(null), [card.id]);

  async function show(path: string, mode: 'diff' | 'file') {
    try {
      const text = mode === 'diff' ? (await api.diff(card.id, path)).diff : (await api.file(card.id, path)).content;
      setOpen({ path, mode, text });
    } catch (err) {
      onError((err as Error).message);
    }
  }

  if (!changes) return <p className="muted">Loading…</p>;
  if (changes.direct) {
    return (
      <div className="changes">
        <p className="muted small">
          Direct mode: edits go straight into the folder, so there is no diff or history. {changes.files.length ? 'Files this card’s agent edited (edits made through shell commands aren’t listed):' : 'The agent hasn’t edited files with its edit tools.'}
        </p>
        <ul className="files">
          {changes.files.map((f) => (
            <li key={f.path}>
              <code>{f.path}</code>
              {f.status === 'D' ? <span className="muted small"> deleted</span> : (
                <button className="ghost small-btn" onClick={() => void show(f.path, 'file')}>File</button>
              )}
            </li>
          ))}
        </ul>
        {open && <pre className="diff">{open.text}</pre>}
      </div>
    );
  }
  if (!changes.to) return <p className="muted">No commits yet. An agent's edits are committed when its turn ends.</p>;
  const total = changes.files.reduce((n, f) => [n[0]! + (f.additions ?? 0), n[1]! + (f.deletions ?? 0)], [0, 0]);
  return (
    <div className="changes">
      <p className="muted small">
        {changes.landed ? `Landed in ${changes.base} as ${changes.to.slice(0, 8)}` : `Branch ${changes.branch} against ${changes.base}`} · {changes.files.length} file(s){' '}
        <span className="add">+{total[0]}</span> <span className="del">−{total[1]}</span>
        {card.status === 'in_progress' ? ' · edits in the current turn appear when it ends' : ''}
      </p>
      {changes.files.length === 0 && <p className="muted">No file changes.</p>}
      <ul className="files">
        {changes.files.map((f) => (
          <li key={f.path} className={open?.path === f.path ? 'on' : ''}>
            <span className={`fstatus s-${f.status}`} title={STATUS_NAME[f.status] ?? f.status}>{f.status}</span>
            <button className="link" onClick={() => show(f.path, 'diff')} title="Show the diff">{f.path}</button>
            {f.from && <span className="muted"> ← {f.from}</span>}
            <span className="spacer" />
            {f.additions !== null ? <><span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span></> : <span className="muted">binary</span>}
            {f.status !== 'D' && <button className="ghost small-btn" onClick={() => show(f.path, 'file')}>File</button>}
          </li>
        ))}
      </ul>
      {open && (
        <div className="file-view">
          <div className="row">
            <strong>{open.path}</strong>
            <span className="muted small">{open.mode === 'diff' ? 'diff' : `whole file at ${changes.to.slice(0, 8)}`}</span>
            <span className="spacer" />
            <button className="ghost small-btn" onClick={() => show(open.path, open.mode === 'diff' ? 'file' : 'diff')}>{open.mode === 'diff' ? 'Whole file' : 'Diff'}</button>
            <button className="ghost small-btn" onClick={() => setOpen(null)}>Close</button>
          </div>
          {open.mode === 'diff' ? <DiffText text={open.text} /> : <pre className="diff">{open.text}</pre>}
        </div>
      )}
      {changes.commits.length > 0 && (
        <details>
          <summary className="muted small">{changes.commits.length} commit(s)</summary>
          <ul className="commits">{changes.commits.map((c) => <li key={c.sha}><code>{c.sha.slice(0, 8)}</code> {c.subject}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

/** Pass / fail / ignore for an outcome a human weighs (an agent's block). */
export function WeighButtons({ outcome, onError }: { outcome: Outcome; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const weigh = (verdict: 'pass' | 'fail' | 'ignore') => {
    setBusy(true);
    api.reviewOutcome(outcome.id, verdict).catch((e: Error) => onError(e.message)).finally(() => setBusy(false));
  };
  return (
    <span className="weigh">
      <button className="ghost small-btn" disabled={busy} title="The block was justified: counts as a success for this model" onClick={() => weigh('pass')}>Pass</button>
      <button className="ghost small-btn" disabled={busy} title="It should have done the work: counts as a failure" onClick={() => weigh('fail')}>Fail</button>
      <button className="ghost small-btn" disabled={busy} title="Leave it out of routing" onClick={() => weigh('ignore')}>Ignore</button>
    </span>
  );
}

/** The card's notes (master plan §5.7): its artifacts, a board-wide search, and a form to add a note. */
function ContextView({ card, events, onError }: { card: Card; events: DaemonEvent[]; onError: (m: string) => void }) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [showOld, setShowOld] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ kind: 'note' as Artifact['kind'], title: '', body: '' });
  const saves = events.filter((e) => e.type === 'artifact.saved').length;

  useEffect(() => {
    let alive = true;
    api.artifacts(card.id, showOld).then((a) => alive && setArtifacts(a), () => {});
    return () => {
      alive = false;
    };
  }, [card.id, saves, showOld]);
  useEffect(() => setHits(null), [card.id]);

  const sorted = [...artifacts].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.createdAt.localeCompare(a.createdAt));

  async function search(e: FormEvent) {
    e.preventDefault();
    if (!query.trim()) return setHits(null);
    try {
      setHits(await api.searchContext(card.boardId, query.trim(), { card: card.id, scope: 'board' }));
    } catch (err) {
      onError((err as Error).message);
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    try {
      await api.addArtifact(card.id, draft.kind, draft.title.trim(), draft.body.trim());
      setDraft({ kind: 'note', title: '', body: '' });
      setAdding(false);
    } catch (err) {
      onError((err as Error).message);
    }
  }

  return (
    <div className="context">
      <form className="row" onSubmit={search}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the board's notes…" aria-label="Search notes" />
        <button type="submit" className="ghost">Search</button>
      </form>
      {hits && (
        <>
          <p className="muted small">{hits.length ? `${hits.length} match(es) across the board` : 'No matches.'} <button className="link" onClick={() => setHits(null)}>clear</button></p>
          <ul className="notes">{hits.map((h) => <Note key={h.artifact.id} a={h.artifact} meta={`${h.via.join('+')}${h.similarity !== undefined ? ` ${h.similarity.toFixed(2)}` : ''}${h.artifact.cardId !== card.id ? ' · other card' : ''}`} />)}</ul>
        </>
      )}
      {!hits && (
        <>
          <ul className="notes">
            {sorted.length === 0 && <li className="muted">No notes on this card yet.</li>}
            {sorted.map((a) => <Note key={a.id} a={a} />)}
          </ul>
          <div className="row">
            <label className="muted small"><input type="checkbox" checked={showOld} onChange={(e) => setShowOld(e.target.checked)} /> older versions</label>
            {!adding && <button className="ghost small-btn" onClick={() => setAdding(true)}>Add a note</button>}
          </div>
        </>
      )}
      {adding && (
        <form className="note-form" onSubmit={add}>
          <div className="row">
            <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as Artifact['kind'] })} aria-label="Kind">
              {(['note', 'decision', 'contract', 'finding'] as const).map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Title" aria-label="Title" required />
          </div>
          <textarea value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} placeholder="What agents should know" rows={4} required />
          <div className="row">
            <button type="submit">Save</button>
            <button type="button" className="ghost" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}

function Note({ a, meta }: { a: Artifact; meta?: string }) {
  return (
    <li className={`note ${a.supersededBy ? 'old' : ''}`}>
      <details>
        <summary>
          <span className={`badge kind-${a.kind}`}>{a.kind}</span> <strong>{a.title}</strong>
          {a.version > 1 && <span className="muted"> v{a.version}</span>}
          {a.supersededBy && <span className="muted"> (replaced)</span>}
          {meta && <span className="muted"> · {meta}</span>}
          {a.summary && <div className="muted small">{a.summary}</div>}
        </summary>
        <pre>{a.body}</pre>
        <p className="muted small">
          {a.id} · {a.author} · {new Date(a.createdAt).toLocaleString()}
          {a.commitSha ? ` · at ${a.commitSha.slice(0, 8)}` : ''}
          {a.tags.length ? ` · ${a.tags.join(', ')}` : ''}
        </p>
      </details>
    </li>
  );
}

/** One council step on the goal card's log (council.ts). */
function councilLine(r: { step: string; [k: string]: any }): { text: string; tone?: 'ok' | 'bad' } | null {
  switch (r.step) {
    case 'proposing':
      return { text: `Council of ${(r.members ?? []).join(', ')}: each member proposes a split` };
    case 'decided':
      return { text: `Kev chose ${r.winner}'s split (${Object.entries(r.scores ?? {}).map(([k, v]) => `${k} ${v}`).join(', ') || r.via}); members plan their shares`, tone: 'ok' };
    case 'working':
      return { text: `Shares planned (${r.cards}); cards are running` };
    case 'verifying':
      return { text: `Verification round ${r.round}: each member checks another member's share` };
    case 'verified':
      return { text: `Round ${r.round}: ${Object.entries(r.verdicts ?? {}).map(([k, v]) => `${k} ${v}`).join(', ')}${r.fixups ? ` · ${r.fixups} fix-up card(s)` : ''}`, tone: r.fixups ? undefined : 'ok' };
    case 'done':
      return { text: `Council done: ${r.reason}`, tone: 'ok' };
    case 'failed':
      return { text: `Council failed: ${r.reason}`, tone: 'bad' };
    case 'error':
      return { text: `Council error: ${r.message}`, tone: 'bad' };
    default:
      return null;
  }
}

const PHASE_TEXT: Record<string, string> = {
  proposing: 'members are proposing splits',
  planning: 'members are planning their shares',
  working: 'cards are running',
  verifying: 'members are cross-checking shares',
  fixing: 'fix-up cards are running',
  done: 'done',
  failed: 'failed (no proposals)',
};

/** A tool call as shown: the call, its latest status, and what it printed. */
type ToolCallView = Extract<HarnessEvent, { type: 'tool_call' }> & { output?: string; exitCode?: number };

type LogItem =
  | { key: string; kind: 'event'; actor: string; ts: string; event: HarnessEvent }
  | { key: string; kind: 'lifecycle'; ts: string; text: string; tone?: 'ok' | 'bad' }
  | { key: string; kind: 'mail'; ts: string; message: Message; outgoing: boolean };

/** Turns the card's event log into display rows, folding tool updates into their tool call. */
export function toLog(events: DaemonEvent[], cardId: string, name: (actor: string) => string): LogItem[] {
  const items: LogItem[] = [];
  const tools = new Map<string, ToolCallView>();
  for (const e of events) {
    if (e.type === 'session.started') {
      const s = e.payload as { model: string };
      items.push({ key: `${e.seq}`, kind: 'lifecycle', ts: e.ts, text: `Session started · ${s.model}` });
    } else if (e.type === 'session.ended') {
      const s = e.payload as { state: string };
      items.push({ key: `${e.seq}`, kind: 'lifecycle', ts: e.ts, text: `Session ${s.state}` });
    } else if (e.type === 'message.posted') {
      const m = e.payload as Message;
      items.push({ key: `${e.seq}`, kind: 'mail', ts: e.ts, message: m, outgoing: m.fromActor === `card:${cardId}` });
    } else if (e.type === 'message.delivered') {
      const m = e.payload as Message;
      items.push({ key: `${e.seq}`, kind: 'lifecycle', ts: e.ts, text: `Delivered message from ${name(m.fromActor)}` });
    } else if (e.type === 'lease.acquired' || e.type === 'lease.released') {
      const l = e.payload as Lease;
      items.push({ key: `${e.seq}`, kind: 'lifecycle', ts: e.ts, text: `${e.type === 'lease.acquired' ? 'Reserved' : 'Released'} ${l.glob}` });
    } else if (e.type === 'card.updated') {
      const { patch } = e.payload as { patch: Partial<Card> };
      if (patch.status) items.push({ key: `${e.seq}`, kind: 'lifecycle', ts: e.ts, text: `Moved to ${STATUS_LABEL[patch.status]}` });
      if (patch.classification) {
        const c = patch.classification;
        items.push({
          key: `${e.seq}c`,
          kind: 'lifecycle',
          ts: e.ts,
          text: `${c.source === 'kev' ? 'Kev' : 'Default'} classification: ${c.workType}, ${complexityLabel(c.complexity)} (${c.complexity.toFixed(2)}), review ${Math.round(c.needsReview * 100)}%`,
        });
      }
    } else if (e.type === 'card.routed') {
      const r = e.payload as { poolId: string; agentId?: string; rerouted: boolean; from?: string };
      const to = r.agentId && r.agentId !== r.poolId ? `${r.agentId} (${r.poolId})` : r.poolId;
      items.push({ key: `${e.seq}`, kind: 'lifecycle', ts: e.ts, text: r.rerouted ? `Re-routed from ${r.from} to ${to}` : `Routed to ${to}` });
    } else if (e.type === 'card.setup') {
      const s = e.payload as { command: string; ok: boolean; ms: number; timedOut: boolean };
      items.push({ key: `${e.seq}`, kind: 'lifecycle', ts: e.ts, text: `Worktree setup ${s.ok ? 'finished' : s.timedOut ? 'ran out of time' : 'failed'} in ${(s.ms / 1000).toFixed(1)}s: ${s.command}`, tone: s.ok ? 'ok' : 'bad' });
    } else if (e.type === 'card.refinery') {
      const line = refineryLine(e.payload as RefineryStep);
      if (line) items.push({ key: `${e.seq}`, kind: 'lifecycle', ts: e.ts, ...line });
    } else if (e.type === 'artifact.saved') {
      const { artifact: a, supersedes } = e.payload as { artifact: Artifact; supersedes: string | null };
      if (a.kind !== 'spec' && a.kind !== 'summary') {
        items.push({ key: `${e.seq}`, kind: 'lifecycle', ts: e.ts, text: `Saved ${a.kind} “${a.title}”${supersedes ? ` (v${a.version})` : ''} · ${a.id}` });
      }
    } else if (e.type === 'card.council') {
      const line = councilLine(e.payload as { step: string; [k: string]: any });
      if (line) items.push({ key: `${e.seq}`, kind: 'lifecycle', ts: e.ts, ...line });
    } else if (e.type === 'card.outcome') {
      const o = e.payload as Outcome;
      items.push({ key: `${e.seq}`, kind: 'lifecycle', ts: e.ts, text: `Outcome for ${o.agentId}: ${outcomeText(o)}`, tone: o.review === 'pending' ? undefined : o.value >= 0.6 ? 'ok' : 'bad' });
    } else if (e.type === 'outcome.reviewed') {
      const o = e.payload as Outcome;
      items.push({ key: `${e.seq}`, kind: 'lifecycle', ts: e.ts, text: `You weighed ${o.agentId}'s block: ${o.review}` });
    } else if (e.type === 'dependency.added') {
      const d = e.payload as Dependency;
      items.push({ key: `${e.seq}`, kind: 'lifecycle', ts: e.ts, text: `Waits for ${name(`card:${d.blockedBy}`)}` });
    } else if (e.type === 'session.event') {
      const { event } = e.payload as { event: HarnessEvent };
      if (event.type === 'tool_update') {
        const call = tools.get(event.id);
        if (call) {
          call.status = event.status;
          if (event.title) call.title = event.title;
          if (event.locations) call.locations = event.locations;
        }
        continue;
      }
      if (event.type === 'tool_output') {
        const call = tools.get(event.id);
        if (call) {
          call.output = (call.output ?? '') + event.text;
          if (event.exitCode !== undefined) call.exitCode = event.exitCode;
        }
        continue;
      }
      if (event.type === 'tool_call') {
        const copy: ToolCallView = { ...event };
        tools.set(event.id, copy);
        items.push({ key: `${e.seq}`, kind: 'event', actor: e.actor, ts: e.ts, event: copy });
        continue;
      }
      items.push({ key: `${e.seq}`, kind: 'event', actor: e.actor, ts: e.ts, event });
    }
  }
  return items;
}

const time = (ts: string) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function Row({ item, name }: { item: LogItem; name: (actor: string) => string }) {
  if (item.kind === 'lifecycle') return <li className={`log lifecycle ${item.tone ?? ''}`}><span className="ts">{time(item.ts)}</span>{item.text}</li>;
  if (item.kind === 'mail') {
    const m = item.message;
    return (
      <li className={`log mail ${item.outgoing ? 'out' : 'in'}`}>
        <span className="ts">{time(item.ts)}</span>
        <span className="who">{item.outgoing ? `to ${m.toCard ? name(`card:${m.toCard}`) : 'humans'}` : `from ${name(m.fromActor)}`}</span>
        {m.urgent && <span className="badge rejected">urgent</span>}
        <pre>{m.body}</pre>
      </li>
    );
  }
  const e = item.event;
  switch (e.type) {
    case 'message':
      return (
        <li className={`log message ${e.role}`}>
          <span className="ts">{time(item.ts)}</span>
          <span className="who">{e.role === 'user' ? 'prompt' : item.actor}</span>
          <pre>{e.text}</pre>
        </li>
      );
    case 'thought':
      return (
        <li className="log thought">
          <details>
            <summary><span className="ts">{time(item.ts)}</span>thinking</summary>
            <pre>{e.text}</pre>
          </details>
        </li>
      );
    case 'tool_call': {
      const call = e as ToolCallView;
      const out = call.output?.replace(/\n+$/, '') ?? '';
      const lines = out ? out.split('\n').length : 0;
      const failed = call.exitCode !== undefined && call.exitCode !== 0;
      return (
        <li className="log tool">
          <span className="ts">{time(item.ts)}</span>
          <span className={`badge ${call.status}`}>{call.status}</span> <strong>{call.kind}</strong> {call.title}
          {call.exitCode !== undefined && <span className={`badge ${failed ? 'rejected' : 'allowed'}`}>exit {call.exitCode}</span>}
          {call.locations.length > 0 && <span className="muted"> · {call.locations.join(', ')}</span>}
          {out && (
            <details className="tool-out" open={lines <= 8 || call.status === 'in_progress'}>
              <summary className="muted">output · {lines} line{lines === 1 ? '' : 's'}</summary>
              <pre>{out}</pre>
            </details>
          )}
        </li>
      );
    }
    case 'permission':
      return (
        <li className="log permission">
          <span className="ts">{time(item.ts)}</span>
          <span className={`badge ${e.decision}`}>{e.decision}</span> {e.title} <span className="muted">· {e.reason}</span>
        </li>
      );
    case 'plan':
      return (
        <li className="log plan">
          <span className="ts">{time(item.ts)}</span>plan
          <ul>{e.entries.map((p, i) => <li key={i} className={p.status}>{p.content}</li>)}</ul>
        </li>
      );
    case 'notice':
      return <li className="log lifecycle warn"><span className="ts">{time(item.ts)}</span>{e.text}</li>;
    case 'turn_end':
      return <li className="log lifecycle"><span className="ts">{time(item.ts)}</span>Turn ended · {e.stopReason}</li>;
    case 'error':
      return <li className="log error"><span className="ts">{time(item.ts)}</span>{e.message}</li>;
    default:
      return null;
  }
}

function Composer({ card, onError }: { card: Card; onError: (m: string) => void }) {
  const [body, setBody] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    try {
      await api.sendMessage(card.id, body, urgent);
      setBody('');
      setUrgent(false);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="composer" onSubmit={submit}>
      <MentionInput
        multiline
        value={body}
        onChange={setBody}
        ariaLabel="Message to this card's agent"
        placeholder="Message this card's agent (delivered at its next turn; start with !urgent to interrupt; @ names another swarm's project)"
        rows={2}
        onSubmit={() => void submit({ preventDefault() {} } as FormEvent)}
      />
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} /> Urgent (interrupts)
        </label>
        <span className="spacer" />
        <button type="submit" disabled={busy || !body.trim()}>Send</button>
      </div>
    </form>
  );
}

/** One line of facts that apply: role, status, agent with pool, model and reasoning level, branch. */
function CardSummary({ card, agent }: { card: Card; agent: ReturnType<typeof cardAgent> }) {
  return (
    <div className="card-summary">
      <span className={`role-tag ${card.role}`}>{ROLE_LABEL[card.role]}</span>
      <span className={`tstatus status-${card.status}`}>{STATUS_LABEL[card.status]}</span>
      {agent && (
        <span title={agent.live ? 'From the live session' : 'From the agent settings'}>
          <strong>{agent.agentId ?? agent.poolId}</strong> <span className="muted">on {agent.poolLabel}</span> · <span className="model">{agent.model}</span>
          {agent.reasoning && <span className="muted"> · reasoning {agent.reasoning}</span>}
        </span>
      )}
      {card.branch && <code className="muted small">{card.branch}</code>}
    </div>
  );
}

export function CardPanel(props: {
  card: Card;
  cards: Card[];
  pools: PoolWithStatus[];
  sessions: ActiveSession[];
  settings: Settings | null;
  models: ModelCatalog;
  events: DaemonEvent[];
  dependencies: Dependency[];
  onSelect: (id: string) => void;
  onClose: () => void;
  onError: (m: string) => void;
}) {
  const { card } = props;
  const agents = props.settings ? effectiveAgents(props.settings, props.pools) : [];
  const ruleEntries = [...new Set([...agents.map((a) => a.id), ...props.pools.map((p) => p.id)])];
  const name = (actor: string) => {
    if (actor.startsWith('card:')) return props.cards.find((c) => c.id === actor.slice(5))?.title ?? actor.slice(5);
    if (actor.startsWith('user:')) return 'you';
    return actor;
  };
  // Run by hand: an agent (pool + model) and, optionally, a different model on its pool.
  const defaultAgent = () =>
    agents.find((a) => a.id === card.agentId) ?? agents.find((a) => a.role === card.role && a.enabled) ?? agents.find((a) => a.poolId === card.poolId) ?? agents[0];
  const [agentId, setAgentId] = useState(defaultAgent()?.id ?? '');
  const agent = agents.find((a) => a.id === agentId);
  const pool = props.pools.find((p) => p.id === agent?.poolId);
  const [model, setModel] = useState(agent?.model ?? '');
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'activity' | 'changes' | 'context' | 'terminal'>('activity');
  const [hasTerminal, setHasTerminal] = useState(false);
  // Facts and routing are long; folded by default they leave the room to the activity list (open by choice, remembered).
  const [detailsOpen, setDetailsOpen] = useState(() => saved('ih.card.details') === '1');
  const rememberDetails = (open: boolean) => {
    setDetailsOpen(open);
    remember('ih.card.details', open ? '1' : '0');
  };
  const running = card.status === 'in_progress';
  const items = toLog(props.events, card.id, name);
  // Follows new output only while you are at the bottom of the list (see useFollowBottom).
  const follow = useFollowBottom<HTMLOListElement>(props.events.length, `${card.id}:${view}`);
  // The latest state of each outcome: recorded, then possibly weighed by a human.
  const outcomeById = new Map<number, Outcome>();
  for (const e of props.events) if (e.type === 'card.outcome' || e.type === 'outcome.reviewed') outcomeById.set((e.payload as Outcome).id, e.payload as Outcome);
  const outcomes = [...outcomeById.values()];

  // Block bodies on purpose: an effect must return a cleanup function or nothing, and
  // scrollIntoView returns a Promise in current browsers, which React would treat as a cleanup.
  useEffect(() => {
    const a = defaultAgent();
    setAgentId(a?.id ?? '');
    setModel(a?.model ?? '');
  }, [card.id, card.agentId, agents.length]);
  // Re-check for a live terminal whenever a session starts or ends.
  const sessionMarks = props.events.filter((e) => e.type === 'session.started' || e.type === 'session.ended').length;
  useEffect(() => {
    let alive = true;
    api.terminal(card.id).then(
      (t) => {
        if (!alive) return;
        setHasTerminal(t.available);
        if (!t.available) setView('activity');
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [card.id, sessionMarks]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      props.onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="panel">
      <div className="panel-head">
        <h2>{card.title}</h2>
        <button className="ghost icon-btn" onClick={props.onClose} aria-label="Close">✕</button>
      </div>
      <CardSummary card={card} agent={cardAgent(card, agents, props.pools, props.sessions)} />
      {card.narration && <p className="narration">{card.narration}</p>}
      {card.description && <p className="desc">{card.description}</p>}

      <details className="card-details" open={detailsOpen} onToggle={(e) => rememberDetails((e.currentTarget as HTMLDetailsElement).open)}>
        <summary>Details, routing and rules</summary>
      <dl className="facts">
        <dt>Status</dt>
        <dd>
          <select
            value={card.status}
            disabled={running || busy}
            onChange={(e) => act(() => api.moveCard(card.id, e.target.value as CardStatus))}
          >
            {CARD_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </dd>
        {card.branch && <><dt>Branch</dt><dd><code>{card.branch}</code></dd></>}
        {card.worktree && <><dt>Worktree</dt><dd><code className="path">{card.worktree}</code></dd></>}
        {card.pipeline.prUrl && <><dt>Pull request</dt><dd><a href={card.pipeline.prUrl} target="_blank" rel="noreferrer">{card.pipeline.prUrl.replace(/^https?:\/\/(www\.)?github\.com\//, '')}</a></dd></>}
        {card.pipeline.landedSha && <><dt>Landed</dt><dd><code>{card.pipeline.landedSha.slice(0, 10)}</code></dd></>}
        {(card.pipeline.reviewRounds || card.pipeline.mergeAttempts || card.pipeline.retries) ? (
          <>
            <dt>Attempts</dt>
            <dd className="muted">
              {[
                card.pipeline.reviewRounds ? `${card.pipeline.reviewRounds} review round(s)` : '',
                card.pipeline.mergeAttempts ? `${card.pipeline.mergeAttempts} failed landing(s)` : '',
                card.pipeline.retries ? `${card.pipeline.retries} reassignment(s)` : '',
                card.pipeline.escalated ? 'escalated to a human' : '',
              ].filter(Boolean).join(' · ')}
            </dd>
          </>
        ) : null}
        {card.pipeline.council && (
          <>
            <dt>Council</dt>
            <dd>
              {PHASE_TEXT[card.pipeline.council.phase] ?? card.pipeline.council.phase}
              {card.pipeline.council.round ? <span className="muted"> · round {card.pipeline.council.round}</span> : null}
              {card.pipeline.council.members.map((m) => (
                <div key={m.cardId}>
                  <button className="link" onClick={() => props.onSelect(m.cardId)}>{m.agentId}</button>{' '}
                  <span className="muted">({m.model})</span>
                  {card.pipeline.council!.winner === m.agentId && <span className="badge allowed">chosen split</span>}
                  {card.pipeline.council!.scores?.[m.agentId] !== undefined && <span className="muted"> Kev {card.pipeline.council!.scores[m.agentId]}</span>}
                  {card.pipeline.council!.verdicts?.[m.agentId] && <span className="muted"> · {card.pipeline.council!.verdicts[m.agentId]}</span>}
                </div>
              ))}
            </dd>
          </>
        )}
        {outcomes.length > 0 && (
          <>
            <dt>Outcomes</dt>
            <dd>
              {outcomes.map((o) => (
                <div key={o.id}>
                  {o.agentId} <span className="muted">({o.model})</span>: {outcomeText(o)}
                  {o.review === 'pending' && <WeighButtons outcome={o} onError={props.onError} />}
                </div>
              ))}
            </dd>
          </>
        )}
        {card.pipeline.bestOf && (
          <>
            <dt>Best-of-N</dt>
            <dd>
              Candidate {card.pipeline.bestOf.candidate} of {card.pipeline.bestOf.of}:{' '}
              {card.pipeline.bestOf.state === 'running' ? 'racing' : card.pipeline.bestOf.state === 'won' ? 'won' : 'lost'}
              {card.pipeline.bestOf.score !== undefined && <span className="muted"> · Kev scored it {card.pipeline.bestOf.score}</span>}
            </dd>
          </>
        )}
        {(card.grants.length > 0 || card.routing?.needsNetwork) && (
          <>
            <dt>Tools</dt>
            <dd>
              {card.grants.map((g) => <span key={g} className="badge" title="A tool grant: an extra MCP server for this card">{g}</span>)}{' '}
              {card.routing?.needsNetwork && <span className="badge" title="Agents whose shell has no network (Codex) are skipped">needs network</span>}
            </dd>
          </>
        )}
        {card.pipeline.finalSummary && (
          <>
            <dt>Final summary</dt>
            <dd><button className="link" onClick={() => props.onSelect(card.pipeline.finalSummary!.cardId)}>Open the report</button></dd>
          </>
        )}
        {card.pipeline.summaryOf && (
          <>
            <dt>Summarizes</dt>
            <dd><button className="link" onClick={() => props.onSelect(card.pipeline.summaryOf!)}>{props.cards.find((c) => c.id === card.pipeline.summaryOf)?.title ?? card.pipeline.summaryOf}</button></dd>
          </>
        )}
        {card.parentId && (
          <>
            <dt>Parent</dt>
            <dd><button className="link" onClick={() => props.onSelect(card.parentId!)}>{props.cards.find((c) => c.id === card.parentId)?.title ?? card.parentId}</button></dd>
          </>
        )}
      </dl>
      <Routing
        card={card}
        events={props.events}
        dependencies={props.dependencies}
        cards={props.cards}
        ruleEntries={ruleEntries}
        onSelect={props.onSelect}
        onError={props.onError}
      />

      </details>

      <ReviewControls card={card} settings={props.settings} onError={props.onError} />

      <div className="run row">
        {running ? (
          <button className="danger" disabled={busy} onClick={() => act(() => api.cancel(card.id))}>Cancel run</button>
        ) : (
          <>
            <select
              value={agentId}
              onChange={(e) => {
                setAgentId(e.target.value);
                setModel(agents.find((a) => a.id === e.target.value)?.model ?? '');
              }}
              aria-label="Agent"
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.id} · {props.pools.find((p) => p.id === a.poolId)?.label ?? a.poolId}{a.role !== 'worker' ? ` (${a.role})` : ''}
                </option>
              ))}
            </select>
            <ModelSelect pool={pool} models={props.models} value={model} onChange={setModel} />
            <button disabled={busy || !agent} onClick={() => act(() => api.run(card.id, agent!.poolId, model || undefined, agent!.id))}>
              {card.branch ? 'Run again' : 'Run'}
            </button>
          </>
        )}
      </div>

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={view === 'activity'} className={view === 'activity' ? 'tab on' : 'tab'} onClick={() => setView('activity')}>
          Activity
        </button>
        <button role="tab" aria-selected={view === 'changes'} className={view === 'changes' ? 'tab on' : 'tab'} onClick={() => setView('changes')}>
          Changes
        </button>
        <button role="tab" aria-selected={view === 'context'} className={view === 'context' ? 'tab on' : 'tab'} onClick={() => setView('context')}>
          Context
        </button>
        {hasTerminal && (
          <button role="tab" aria-selected={view === 'terminal'} className={view === 'terminal' ? 'tab on' : 'tab'} onClick={() => setView('terminal')}>
            Terminal
          </button>
        )}
      </div>
      {view === 'terminal' && hasTerminal ? (
        <>
          <p className="muted small">Live session. Typing here goes straight to the agent.</p>
          <TerminalView cardId={card.id} />
        </>
      ) : view === 'changes' ? (
        <ChangesView card={card} events={props.events} onError={props.onError} />
      ) : view === 'context' ? (
        <ContextView card={card} events={props.events} onError={props.onError} />
      ) : (
      <div className="activity-wrap">
        <ol className="activity" ref={follow.ref} onScroll={follow.onScroll}>
          {items.length === 0 && <li className="muted">No activity yet.</li>}
          {items.map((item) => <Row key={item.key} item={item} name={name} />)}
        </ol>
        {follow.behind && <button className="jump-latest" onClick={follow.jump}>↓ New activity</button>}
      </div>
      )}
      <Composer card={card} onError={props.onError} />
    </aside>
  );
}
