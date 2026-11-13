import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { REQUEST_FINAL, type FedRequest, type Peer, type PeerProject, type ProjectCard, type SharedProject, type Visibility } from '@ih/core';
import { api, type FederationOverview } from './api.ts';

// Swarm federation (master plan Phase 7): other Infinity Harness daemons this one cooperates with. Everything another
// swarm wrote is shown as inert text. Nothing here lets it reach an agent before a person has accepted it.

const LINK_LABEL: Record<Peer['link'], string> = {
  none: 'it knocked on us',
  connecting: 'connecting…',
  online: 'online',
  waiting: 'waiting for them to accept us',
  reconnecting: 'unreachable, retrying',
  attention: 'needs attention',
  stopped: 'stopped',
};
const LINK_TONE: Record<Peer['link'], string> = { none: '', connecting: 'warn', online: 'open', waiting: 'warn', reconnecting: 'warn', attention: 'halted', stopped: '' };
const STATUS_LABEL: Record<FedRequest['status'], string> = {
  pending: 'waiting for approval',
  accepted: 'accepted',
  in_progress: 'in progress',
  needs_info: 'needs information',
  landed: 'landed',
  done: 'done',
  declined: 'declined',
  cannot_reproduce: 'cannot reproduce',
  cancelled: 'cancelled',
};

const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129_600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86_400)} days ago`;
};

type Act = <T>(label: string, fn: () => Promise<T>) => Promise<T | undefined>;

function Fingerprint({ value }: { value: string | null }) {
  return <code className="fingerprint" title="Compare this with what the other operator sees on their side">{value ?? 'not identified yet'}</code>;
}

/** A project card as another swarm wrote it: plain text only. */
function CardText({ card }: { card: ProjectCard }) {
  return (
    <div className="peer-project">
      <div><strong>{card.name}</strong> <span className="muted small">({card.id})</span>{card.accepts.requests && <span className="badge">takes requests</span>}</div>
      {card.oneLine && <div>{card.oneLine}</div>}
      {card.provides.length > 0 && <div className="small muted">provides: {card.provides.join(', ')}</div>}
      {card.about && <div className="small">{card.about}</div>}
      {card.uses.length > 0 && <div className="small muted">uses: {card.uses.join(', ')}</div>}
      {card.version && <div className="small muted">version {card.version}{card.lastCommit ? ` · ${card.lastCommit}` : ''}</div>}
    </div>
  );
}

/** A value with a button that copies it. */
function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="ghost small-btn"
      aria-label={`Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          // clipboard unavailable (an insecure page, or a webview): the text is selectable anyway
        }
      }}
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

/** What someone needs to connect to this swarm, ready to read out or paste. */
function ConnectDetails({ overview }: { overview: FederationOverview }) {
  const { port, self } = overview;
  const host = overview.host ?? { user: '', name: 'this machine' }; // a daemon from before this field existed
  if (!port) return <div className="small error-text">The federation port is switched off (IH_FED_PORT=off): other swarms cannot connect to this one.</div>;
  const target = host.user ? `${host.user}@${host.name}` : host.name;
  const ssh = `ssh -N -L 7432:127.0.0.1:${port} ${target}`;
  const ih = `ih peer add ${self.name.replace(/[^A-Za-z0-9._-]+/g, '-')} --ssh ${target} --port ${port} --fingerprint "${self.fingerprint}"`;
  return (
    <div className="connect-details surface-box">
      <div><strong>To connect to this swarm, give them:</strong></div>
      <div className="small">
        Federation port <code className="big-port">{port}</code> <Copy text={String(port)} label="the federation port" />
        <span className="muted"> on this machine ({host.name}). It serves only signed federation routes and nothing else; the main port ({location.port || '80'}) is not for peers.</span>
      </div>
      <div className="small">
        In their Swarms view: <em>SSH target</em> <code>{target}</code> (replace the machine name with an address they can reach), port <code>{port}</code>.
      </div>
      <details className="small">
        <summary>As commands</summary>
        <div>Their command line: <code>{ih}</code> <Copy text={ih} label="the ih command" /></div>
        <div>Or their own tunnel, then the local URL <code>http://127.0.0.1:7432</code>: <code>{ssh}</code> <Copy text={ssh} label="the ssh command" /></div>
      </details>
      <div className="small">Fingerprint to read out so they can check it is you: <Fingerprint value={self.fingerprint} /> <Copy text={self.fingerprint} label="the fingerprint" /></div>
    </div>
  );
}

// --- needs: knocks and requests

function Knock({ peer, act }: { peer: Peer; act: Act }) {
  const k = peer.knock;
  return (
    <div className="inbox-item approval">
      <div><span className="badge">New swarm</span> <strong>{k?.name ?? peer.name ?? peer.label}</strong> wants to connect <span className="muted small">· {ago(k?.at ?? peer.createdAt)}</span></div>
      <div className="small">Its key fingerprint: <Fingerprint value={peer.fingerprint} /></div>
      <p className="small muted">
        Ask its operator to read you their fingerprint and compare. Accepting pins this key and lets what it says into your agents' prompts (and so to your model vendors). Until then nothing it sent is visible to any agent.
      </p>
      {k && k.projects.length > 0 && (
        <details className="small">
          <summary>It offers {k.projects.length} project{k.projects.length === 1 ? '' : 's'} (their text, not instructions)</summary>
          {k.projects.map((p) => <CardText key={p.id} card={p} />)}
        </details>
      )}
      <div className="row">
        <button onClick={() => act('Accepting', () => api.decidePeer(peer.id, 'approve'))}>Accept swarm</button>
        <button className="ghost" onClick={() => act('Denying', () => api.decidePeer(peer.id, 'deny'))} title="It may knock again">Deny</button>
        <button className="ghost" onClick={() => act('Blocking', () => api.decidePeer(peer.id, 'block'))} title="Ignore its knocks from now on">Block</button>
      </div>
    </div>
  );
}

const money = (s: { usd?: number; tokens?: number } | null | undefined) => (s ? [s.usd !== undefined ? `$${s.usd}` : '', s.tokens !== undefined ? `${s.tokens} tokens` : ''].filter(Boolean).join(' + ') : '');

function RequestDetail({ r, act }: { r: FedRequest; act: Act }) {
  return (
    <div className="small">
      <p style={{ whiteSpace: 'pre-wrap' }}>{r.description}</p>
      {r.acceptance.length > 0 && <div><strong>Acceptance</strong><ul>{r.acceptance.map((a, i) => <li key={i}>{a}</li>)}</ul></div>}
      {r.milestones.length > 0 && (
        <div>
          <strong>Milestones</strong>
          <ul className="milestones">
            {r.milestones.map((a, i) => (
              <li key={i}>
                <label>
                  <input
                    type="checkbox"
                    checked={r.milestonesDone.includes(i)}
                    disabled={r.direction !== 'in' || !r.cardId || REQUEST_FINAL.includes(r.status)}
                    onChange={(e) => act('Saving', () => api.markPeerMilestone(r.id, i, e.target.checked))}
                  />{' '}
                  {a}
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
      {r.budget && (
        <div>
          <strong>Budget</strong> {money({ usd: r.budget.maxUsd, tokens: r.budget.maxTokens })}
          {r.spent && <> · used {r.spent.tokens} tokens{r.spent.usd ? ` and $${r.spent.usd.toFixed(2)}` : ''}{r.spent.pct !== null ? ` (${r.spent.pct}%)` : ''}</>}
          {r.spent?.pct != null && <span className="gauge" aria-label={`${r.spent.pct}% of the budget`}><span style={{ width: `${Math.min(100, r.spent.pct)}%` }} /></span>}
        </div>
      )}
      {r.auto && <div className="muted">Accepted automatically: a trusted swarm, within its limits.</div>}
      {r.resolution && <div><strong>Landed:</strong> {r.resolution.ref} {r.resolution.note}</div>}
      {r.thread.map((e, i) => (
        <div key={i} className="muted"><strong>{e.side === 'sender' ? 'requester' : 'receiver'}</strong> {ago(e.at)}: {e.text}</div>
      ))}
    </div>
  );
}

function InboundActions({ r, act }: { r: FedRequest; act: Act }) {
  const [text, setText] = useState('');
  const open = !REQUEST_FINAL.includes(r.status);
  if (!open) return null;
  const waiting = r.status === 'pending' || (r.status === 'needs_info' && !r.cardId);
  return (
    <div className="row">
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder={waiting ? 'A note, a question for them, or why you decline' : 'A note, or why you stop'} aria-label="Text for the other swarm" />
      {waiting && <button onClick={() => act('Approving', () => api.approvePeerRequest(r.id, text.trim() || undefined)).then(() => setText(''))}>Approve</button>}
      {waiting && <button className="ghost" disabled={!text.trim()} onClick={() => act('Asking', () => api.askPeerInfo(r.id, text.trim())).then(() => setText(''))}>Ask a question</button>}
      {r.status !== 'landed' && <button className="ghost" disabled={!text.trim()} onClick={() => act('Declining', () => api.declinePeerRequest(r.id, text.trim())).then(() => setText(''))}>Decline</button>}
      {r.status !== 'landed' && !waiting && <button className="ghost" onClick={() => act('Reporting', () => api.cannotReproducePeerRequest(r.id, text.trim()))}>Cannot reproduce</button>}
      {!waiting && r.status !== 'landed' && <button className="ghost" onClick={() => { const ref = prompt('What landed? A commit, a PR URL or a version'); if (ref) void act('Saving', () => api.landPeerRequest(r.id, { ref, note: text.trim() || undefined })); }}>Mark landed…</button>}
      {!waiting && <button className="ghost" disabled={!text.trim()} onClick={() => act('Sending', () => api.commentPeerRequest(r.id, text.trim())).then(() => setText(''))}>Comment</button>}
      {r.cardId && r.status !== 'landed' && (
        <button
          className="ghost"
          onClick={() => {
            const t = prompt('Most tokens this request may use (blank for none)', String(r.budget?.maxTokens ?? ''));
            if (t === null) return;
            const u = prompt('Most dollars it may use (only agents that report a cost count; blank for none)', String(r.budget?.maxUsd ?? ''));
            if (u === null) return;
            void act('Saving', () => api.setPeerRequestBudget(r.id, { ...(t.trim() ? { maxTokens: Number(t) } : {}), ...(u.trim() ? { maxUsd: Number(u) } : {}) }));
          }}
        >
          Change budget…
        </button>
      )}
    </div>
  );
}

function OutboundActions({ r, act }: { r: FedRequest; act: Act }) {
  const [text, setText] = useState('');
  if (REQUEST_FINAL.includes(r.status)) return null;
  return (
    <div className="row">
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder={r.status === 'needs_info' ? 'Your answer' : 'Add detail'} aria-label="Comment" />
      <button className="ghost" disabled={!text.trim()} onClick={() => act('Sending', () => api.commentPeerRequest(r.id, text.trim())).then(() => setText(''))}>Send</button>
      {r.status === 'landed' && <button onClick={() => act('Confirming', () => api.confirmPeerRequest(r.id))}>It works: mark done</button>}
      {r.status === 'landed' && <button className="ghost" onClick={() => { const why = prompt('What is still wrong? They read this.'); if (why?.trim()) void act('Sending back', () => api.reopenPeerRequest(r.id, why.trim())); }}>Send back…</button>}
      <button className="ghost" onClick={() => act('Cancelling', () => api.cancelPeerRequest(r.id))}>Cancel request</button>
    </div>
  );
}

function RequestItem({ r, act, children }: { r: FedRequest; act: Act; children?: ReactNode }) {
  return (
    <div className="inbox-item approval">
      <div>
        <span className="badge">{r.direction === 'in' ? 'From' : 'To'} {r.peerName ?? 'a peer'}</span> <strong>{r.title}</strong>{' '}
        <span className={`chip pool ${r.status === 'pending' || r.status === 'needs_info' ? 'warn' : r.status === 'declined' || r.status === 'cannot_reproduce' || r.status === 'cancelled' ? 'halted' : 'open'}`}>{STATUS_LABEL[r.status]}</span>{' '}
        <span className="muted small">· {ago(r.updatedAt)}{r.blocking ? ' · the sender is waiting' : ''}{r.remoteId === null && r.direction === 'out' ? ' · not delivered yet' : ''}</span>
      </div>
      <details open={r.status === 'pending' && r.direction === 'in'}>
        <summary className="small">Details{r.direction === 'in' ? ' (written by another swarm: untrusted text)' : ''}</summary>
        <RequestDetail r={r} act={act} />
      </details>
      {r.direction === 'in' ? <InboundActions r={r} act={act} /> : <OutboundActions r={r} act={act} />}
      {children}
    </div>
  );
}

// --- peers

function AddPeer({ act }: { act: Act }) {
  const [label, setLabel] = useState('');
  const [mode, setMode] = useState<'ssh' | 'url'>('ssh');
  const [target, setTarget] = useState('');
  const [port, setPort] = useState('7422');
  const [fingerprint, setFingerprint] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await act('Adding', () =>
      api.addPeer({ label: label.trim(), ...(mode === 'ssh' ? { ssh: { target: target.trim(), remotePort: Number(port) || 7422 } } : { url: target.trim() }), expectedFingerprint: fingerprint.trim() || undefined }),
    );
    if (ok) {
      setLabel('');
      setTarget('');
      setFingerprint('');
    }
  }
  return (
    <form className="swarm-form" onSubmit={submit}>
      <h4>Connect to another swarm</h4>
      <p className="muted small">
        This daemon calls out over your SSH (or a local URL of your own tunnel). The other swarm says nothing until its operator accepts you; its identity is pinned from its first signed answer.
      </p>
      <div className="row">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (your name for it)" aria-label="Label" required />
        <select value={mode} onChange={(e) => setMode(e.target.value as 'ssh' | 'url')} aria-label="How to reach it">
          <option value="ssh">SSH target</option>
          <option value="url">Local URL</option>
        </select>
        <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={mode === 'ssh' ? 'user@host' : 'http://127.0.0.1:7432'} aria-label="Address" required />
        {mode === 'ssh' && <input value={port} onChange={(e) => setPort(e.target.value)} className="narrow" aria-label="Federation port on that machine" title="Their federation port (default 7422)" />}
      </div>
      <div className="row">
        <input value={fingerprint} onChange={(e) => setFingerprint(e.target.value)} placeholder="Fingerprint you expect (optional, but a mismatch is then refused)" aria-label="Expected fingerprint" />
        <button type="submit" disabled={!label.trim() || !target.trim()}>Connect</button>
      </div>
    </form>
  );
}

function AutoAccept({ peer, act }: { peer: Peer; act: Act }) {
  const [open, setOpen] = useState(false);
  const c = peer.caps;
  const [f, setF] = useState({ rt: String(c.perRequest?.tokens ?? ''), ru: String(c.perRequest?.usd ?? ''), dt: String(c.perDay?.tokens ?? ''), du: String(c.perDay?.usd ?? '') });
  const num = (s: string) => (s.trim() && Number(s) > 0 ? Number(s) : undefined);
  const caps = () => {
    const spend = (usd?: number, tokens?: number) => (usd !== undefined || tokens !== undefined ? { ...(usd !== undefined ? { usd } : {}), ...(tokens !== undefined ? { tokens } : {}) } : undefined);
    const perRequest = spend(num(f.ru), num(f.rt));
    const perDay = spend(num(f.du), num(f.dt));
    return { ...(perRequest ? { perRequest } : {}), ...(perDay ? { perDay } : {}) };
  };
  return (
    <div className="small">
      <label>
        <input type="checkbox" checked={peer.autoAccept} onChange={(e) => void act('Saving', () => api.updatePeer(peer.id, { autoAccept: e.target.checked }))} /> Start its requests without asking me
      </label>
      {peer.autoAccept && !open && <span className="muted"> · up to {money(c.perRequest)} per request, {money(c.perDay)} a day <button className="link" onClick={() => setOpen(true)}>change limits</button></span>}
      {open && (
        <div className="swarm-form">
          <p className="muted">Its requests start at once and spend your quota up to these limits; one naming more waits for you. You are told of each one. Dollars count only for agents that report a cost, so set tokens too.</p>
          <div className="row">
            <input value={f.rt} onChange={(e) => setF({ ...f, rt: e.target.value })} placeholder="tokens per request" aria-label="Tokens per request" />
            <input value={f.ru} onChange={(e) => setF({ ...f, ru: e.target.value })} placeholder="$ per request" aria-label="Dollars per request" />
          </div>
          <div className="row">
            <input value={f.dt} onChange={(e) => setF({ ...f, dt: e.target.value })} placeholder="tokens per day" aria-label="Tokens per day" />
            <input value={f.du} onChange={(e) => setF({ ...f, du: e.target.value })} placeholder="$ per day" aria-label="Dollars per day" />
          </div>
          <div className="row">
            <button onClick={async () => { if (await act('Saving', () => api.updatePeer(peer.id, { autoAccept: true, caps: caps() }))) setOpen(false); }}>Save</button>
            <button className="ghost" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A peer that connected to us has no address here yet; this is where to enter it so requests can go back. */
function ConnectBack({ peer, act }: { peer: Peer; act: Act }) {
  const [target, setTarget] = useState('');
  const [port, setPort] = useState('7422');
  const isUrl = /^https?:\/\//.test(target.trim());
  return (
    <div className="small">
      <div>It connected to you, so this swarm cannot send it requests yet. Where is it? (Its port is in the box on its own Swarms page.)</div>
      <div className="row">
        <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="user@host, or http://127.0.0.1:PORT" aria-label="Its address" />
        {!isUrl && <input value={port} onChange={(e) => setPort(e.target.value)} className="narrow" aria-label="Its federation port" />}
        <button disabled={!target.trim()} onClick={() => act('Saving', () => api.updatePeer(peer.id, isUrl ? { url: target.trim() } : { ssh: { target: target.trim(), remotePort: Number(port) || 7422 } }))}>Connect back</button>
      </div>
    </div>
  );
}

function PeerCard({ peer, act, onRequest }: { peer: Peer; act: Act; onRequest: (peerId: string) => void }) {
  const [projects, setProjects] = useState<PeerProject[] | null>(null);
  const [preview, setPreview] = useState<ProjectCard[] | null>(null);
  const accepted = peer.trust === 'verified' || peer.trust === 'trusted';
  async function load() {
    const d = await act('Loading', () => api.peer(peer.id));
    if (d) setProjects(d.projects);
  }
  return (
    <article className={`pool-card ${LINK_TONE[peer.link]}`}>
      <header className="row nowrap">
        <span className={`chip pool ${LINK_TONE[peer.link]}`}><span className="dot" />{peer.trust === 'blocked' ? 'blocked' : LINK_LABEL[peer.link]}</span>
        <h4>{peer.label}</h4>
        {peer.name && peer.name !== peer.label && <span className="muted small ellipsis">“{peer.name}”</span>}
        <span className="badge">{peer.trust}</span>
      </header>
      <div className="small">fingerprint <Fingerprint value={peer.fingerprint} /></div>
      <div className="small muted">
        {peer.address ? (peer.address.kind === 'ssh' ? `ssh ${peer.address.target}${peer.address.sshPort ? `:${peer.address.sshPort}` : ''} → port ${peer.address.remotePort}` : peer.address.url) : 'no address for it here: it connects to you'}
        {' · '}last contact {ago(peer.lastContactAt)} · {peer.projects} project{peer.projects === 1 ? '' : 's'} cached
      </div>
      {peer.lastError && <div className="small error-text">{peer.lastError}</div>}
      {accepted && !peer.address && (
        <ConnectBack peer={peer} act={act} />
      )}
      {accepted && (
        <div className="row">
          <label className="small">
            We show it{' '}
            <select value={peer.shares} onChange={(e) => act('Saving', () => api.updatePeer(peer.id, { shares: e.target.value as Visibility }))}>
              <option value="none">nothing</option>
              <option value="basic">basic (name, one line, what it provides)</option>
              <option value="full" disabled={peer.trust !== 'trusted'}>everything we published{peer.trust !== 'trusted' ? ' (trusted only)' : ''}</option>
            </select>
          </label>
          <button className="ghost small-btn" onClick={async () => { const p = await act('Loading', () => api.previewPeer(peer.id)); if (p) setPreview(p.projects); }}>Preview what it gets</button>
        </div>
      )}
      <div className="row">
        {accepted && <button className="ghost small-btn" onClick={() => act('Saving', () => api.updatePeer(peer.id, { trust: peer.trust === 'trusted' ? 'verified' : 'trusted' }))} disabled={peer.trust !== 'trusted' && !peer.publicKey} title="A trusted peer may see everything you publish for it">{peer.trust === 'trusted' ? 'Stop trusting' : 'Trust'}</button>}
        {peer.address && <button className="ghost small-btn" onClick={() => act('Contacting', () => api.pollPeer(peer.id))}>Check now</button>}
        {accepted && peer.projects > 0 && <button className="ghost small-btn" onClick={() => (projects ? setProjects(null) : void load())}>{projects ? 'Hide projects' : 'Its projects'}</button>}
        {accepted && peer.swarmId && peer.address && <button className="ghost small-btn" onClick={() => onRequest(peer.id)}>Send a request…</button>}
        {peer.address && <button className="ghost small-btn" onClick={() => act('Saving', () => api.updatePeer(peer.id, { enabled: !peer.enabled }))}>{peer.enabled ? 'Pause' : 'Resume'}</button>}
        {peer.trust !== 'blocked' && accepted && <button className="ghost small-btn" onClick={() => act('Blocking', () => api.updatePeer(peer.id, { trust: 'blocked' }))}>Block</button>}
        <button className="ghost small-btn" onClick={() => confirm(`Forget ${peer.label} and the projects cached from it?`) && void act('Removing', () => api.removePeer(peer.id))}>{peer.trust === 'blocked' ? 'Unblock (forget)' : 'Forget'}</button>
      </div>
      {peer.trust === 'trusted' && <AutoAccept peer={peer} act={act} />}
      {preview && (
        <div className="peer-preview">
          <div className="small muted">This is exactly what {peer.label} receives from this swarm{peer.trust !== 'trusted' ? ' (at most basic until it is trusted)' : ''}:</div>
          {preview.length ? preview.map((c) => <CardText key={c.id} card={c} />) : <div className="muted small">Nothing.</div>}
          <button className="ghost small-btn" onClick={() => setPreview(null)}>Close</button>
        </div>
      )}
      {projects && (
        <div className="peer-preview">
          <div className="small muted">Shared by {peer.name ?? peer.label}. Their words, shown as text; agents see them only as data.</div>
          {projects.map((p) => <CardText key={p.card.id} card={p.card} />)}
        </div>
      )}
    </article>
  );
}

// --- the projects we share

function ProjectEditor({ shared, drafter, act }: { shared: SharedProject; drafter: 'fastlane' | 'orchestrator'; act: Act }) {
  const d = shared.draft;
  const [form, setForm] = useState<{ name: string; oneLine: string; about: string; provides: string; uses: string; accepts: boolean; note: string } | null>(null);
  const [vis, setVis] = useState<Visibility>(shared.visibility === 'none' ? 'basic' : shared.visibility);
  const edit = () => d && setForm({ name: d.name, oneLine: d.oneLine, about: d.about, provides: d.provides.join('\n'), uses: d.uses.join('\n'), accepts: d.accepts.requests, note: d.accepts.note });
  const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
  async function save() {
    if (!form || !d) return;
    const ok = await act('Saving', () => api.saveProjectDraft(shared.boardId, { ...d, name: form.name, oneLine: form.oneLine, about: form.about, provides: lines(form.provides), uses: lines(form.uses), accepts: { requests: form.accepts, note: form.note } }));
    if (ok) setForm(null);
  }
  return (
    <article className="pool-card">
      <header className="row nowrap">
        <h4>{shared.boardName}</h4>
        <span className="badge">{shared.published ? `shared: ${shared.visibility}${shared.dirty ? ', edited since' : ''}` : d ? 'draft' : 'not shared'}</span>
        {shared.draftSource && <span className="muted small">drafted by {shared.draftSource === 'fastlane' ? 'the fast lane' : shared.draftSource === 'orchestrator' ? 'the orchestrator' : 'you'}</span>}
      </header>
      {!form && d && <CardText card={d} />}
      {!form && !d && <p className="muted small">No card yet. A draft is written from the repository's README and manifests; you review it before anything is shared.</p>}
      {form && (
        <div className="swarm-form">
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label="Name" />
          <input value={form.oneLine} onChange={(e) => setForm({ ...form, oneLine: e.target.value })} placeholder="One line" aria-label="One line" />
          <textarea value={form.about} onChange={(e) => setForm({ ...form, about: e.target.value })} rows={4} placeholder="What it is, in a paragraph" aria-label="About" />
          <label className="small">What it provides, one per line (package names, repository URLs, commands, APIs)<textarea value={form.provides} onChange={(e) => setForm({ ...form, provides: e.target.value })} rows={3} /></label>
          <label className="small">What it uses, one per line<textarea value={form.uses} onChange={(e) => setForm({ ...form, uses: e.target.value })} rows={2} /></label>
          <label className="small"><input type="checkbox" checked={form.accepts} onChange={(e) => setForm({ ...form, accepts: e.target.checked })} /> Accept requests from other swarms for this project (each one still waits for your approval)</label>
          <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="How to ask (optional)" aria-label="How to ask" />
          <div className="row"><button onClick={save}>Save draft</button><button className="ghost" onClick={() => setForm(null)}>Cancel</button></div>
        </div>
      )}
      {!form && (
        <div className="row">
          <button className="ghost small-btn" onClick={() => act('Drafting', () => api.draftProject(shared.boardId, drafter))}>{d ? 'Redraft' : 'Draft a card'} ({drafter === 'fastlane' ? 'fast lane' : 'orchestrator'})</button>
          {d && <button className="ghost small-btn" onClick={edit}>Edit</button>}
          {d && (
            <>
              <select value={vis} onChange={(e) => setVis(e.target.value as Visibility)} aria-label="Visibility">
                <option value="basic">basic: name, one line, provides</option>
                <option value="full">full: the whole card (trusted peers only)</option>
              </select>
              <button onClick={() => act('Publishing', () => api.publishProject(shared.boardId, vis))}>{shared.published ? 'Publish changes' : 'Publish'}</button>
            </>
          )}
          {shared.published && <button className="ghost small-btn" onClick={() => act('Unpublishing', () => api.unpublishProject(shared.boardId))}>Stop sharing</button>}
        </div>
      )}
    </article>
  );
}

function NewRequest({ peers, initialPeer, act, onDone }: { peers: Peer[]; initialPeer: string; act: Act; onDone: () => void }) {
  const askable = peers.filter((p) => (p.trust === 'verified' || p.trust === 'trusted') && p.swarmId && p.address);
  const [peerId, setPeerId] = useState(initialPeer || askable[0]?.id || '');
  const projects = useProjects(peerId);
  const [project, setProject] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [blocking, setBlocking] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await act('Sending', () =>
      api.sendPeerRequest({ peer: peerId, title: title.trim(), description: description.trim(), project: project || undefined, blocking, acceptance: acceptance.split('\n').map((s) => s.trim()).filter(Boolean) }),
    );
    if (ok) onDone();
  }
  return (
    <form className="swarm-form" onSubmit={submit}>
      <h4>Send a request</h4>
      <p className="muted small">A bug report with how to reproduce it, or a piece of work with a spec. Its operator decides whether to take it; nothing runs there before they approve.</p>
      <div className="row">
        <select value={peerId} onChange={(e) => { setPeerId(e.target.value); setProject(''); }} aria-label="Swarm">
          {askable.map((p) => <option key={p.id} value={p.id}>{p.name ?? p.label}</option>)}
        </select>
        <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
          <option value="">(its only project)</option>
          {projects.filter((p) => p.accepts.requests).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Title" required />
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={5} placeholder="What is wrong or needed; repro steps, logs, the spec" aria-label="Description" required />
      <textarea value={acceptance} onChange={(e) => setAcceptance(e.target.value)} rows={2} placeholder="Acceptance criteria, one per line (optional)" aria-label="Acceptance criteria" />
      <label className="small"><input type="checkbox" checked={blocking} onChange={(e) => setBlocking(e.target.checked)} /> Something of mine waits for this</label>
      <div className="row"><button type="submit" disabled={!peerId || title.trim().length < 3 || !description.trim()}>Send</button><button type="button" className="ghost" onClick={onDone}>Cancel</button></div>
    </form>
  );
}

/** The cached projects of one peer, for the project picker. */
function useProjects(peerId: string): ProjectCard[] {
  const [cards, setCards] = useState<ProjectCard[]>([]);
  useEffect(() => {
    setCards([]);
    if (!peerId) return;
    let live = true;
    api.peer(peerId).then((d) => live && setCards(d.projects.map((p) => p.card)), () => {});
    return () => {
      live = false;
    };
  }, [peerId]);
  return cards;
}

// --- the view

export function SwarmsView({ overview, requests, onRefresh, onError }: { overview: FederationOverview | null; requests: FedRequest[]; onRefresh: () => void; onError: (m: string) => void }) {
  const [asking, setAsking] = useState<string | null>(null);
  const [showFinished, setShowFinished] = useState(false);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const act: Act = async (_label, fn) => {
    try {
      const out = await fn();
      onRefresh();
      return out;
    } catch (err) {
      onError((err as Error).message);
      return undefined;
    }
  };
  if (!overview) return <div className="page muted">Loading…</div>;
  const { self, settings, peers, shared, needs } = overview;
  const inbound = requests.filter((r) => r.direction === 'in' && (showFinished || !REQUEST_FINAL.includes(r.status)));
  const outbound = requests.filter((r) => r.direction === 'out' && (showFinished || !REQUEST_FINAL.includes(r.status)));
  const waitingKnocks = needs.knocks;
  const others = peers.filter((p) => p.trust !== 'pending');

  return (
    <div className="page swarms">
      <div className="page-head">
        <div>
          <h2>Swarms</h2>
          <p className="muted small">
            Connect Infinity Harness daemons across machines, publish short project cards for your peers, and exchange structured requests and answers.
          </p>
        </div>
      </div>

      <section>
        <h3>This swarm</h3>
        <div className="surface-box swarm-self-card">
          <div className="row nowrap">
            {nameDraft === null ? (
              <>
                <strong className="swarm-title">{settings.name}</strong>
                <button className="ghost small-btn" onClick={() => setNameDraft(settings.name)}>Rename</button>
              </>
            ) : (
              <>
                <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} aria-label="Swarm name" />
                <button className="small-btn" onClick={async () => { if (await act('Saving', () => api.updateFederation({ name: nameDraft }))) setNameDraft(null); }}>Save</button>
                <button className="ghost small-btn" onClick={() => setNameDraft(null)}>Cancel</button>
              </>
            )}
            <code className="muted small">{self.swarmId}</code>
          </div>
          <div className="small">Fingerprint <Fingerprint value={self.fingerprint} /> <span className="muted">— read this to the other operator; they compare it when they accept you.</span></div>
          <ConnectDetails overview={overview} />
          <div className="row small">
            <label className="row small">
              <span>Project cards are drafted by</span>
              <select value={settings.drafter} onChange={(e) => act('Saving', () => api.updateFederation({ drafter: e.target.value as 'fastlane' | 'orchestrator' }))}>
                <option value="fastlane">the fast lane (cheap; from README and manifests)</option>
                <option value="orchestrator">the orchestrator (reads the code; spends quota)</option>
              </select>
            </label>
            <span className="muted small">Whatever you publish ends up in your peers' agents' prompts, and so with their model vendors.</span>
          </div>
        </div>
      </section>

      {(waitingKnocks.length > 0 || needs.requests.length > 0 || needs.replies.length > 0) && (
        <section>
          <h3>Waiting for you</h3>
          {waitingKnocks.map((p) => <Knock key={p.id} peer={p} act={act} />)}
          {needs.requests.map((r) => <RequestItem key={r.id} r={r} act={act} />)}
          {needs.replies.map((r) => <RequestItem key={r.id} r={r} act={act} />)}
        </section>
      )}

      <section>
        <h3>Peers</h3>
        {others.length === 0 && <p className="muted small">No peers yet. Connect to another swarm below, or wait for one to knock.</p>}
        <div className="pool-grid">{others.map((p) => <PeerCard key={p.id} peer={p} act={act} onRequest={setAsking} />)}</div>
        <AddPeer act={act} />
      </section>

      {asking !== null && <section><NewRequest peers={peers} initialPeer={asking} act={act} onDone={() => setAsking(null)} /></section>}

      <section>
        <h3>Requests</h3>
        {inbound.length + outbound.length === 0 && <p className="muted small">None{showFinished ? '' : ' open'}.</p>}
        {inbound.filter((r) => r.status !== 'pending' || !needs.requests.some((n) => n.id === r.id)).map((r) => <RequestItem key={r.id} r={r} act={act} />)}
        {outbound.filter((r) => !needs.replies.some((n) => n.id === r.id)).map((r) => <RequestItem key={r.id} r={r} act={act} />)}
        <label className="small"><input type="checkbox" checked={showFinished} onChange={(e) => setShowFinished(e.target.checked)} /> Show finished</label>
        {asking === null && peers.some((p) => (p.trust === 'verified' || p.trust === 'trusted') && p.swarmId && p.address) && <div><button className="ghost" onClick={() => setAsking('')}>Send a request…</button></div>}
      </section>

      <section>
        <h3>Projects you share</h3>
        <p className="muted small">Nothing leaves this machine until you publish it. Taking requests is a choice you make per project.</p>
        <div className="pool-grid">{shared.map((s) => <ProjectEditor key={s.boardId} shared={s} drafter={settings.drafter} act={act} />)}</div>
      </section>
    </div>
  );
}
