import { useState } from 'react';
import type { AgentProfile, Approval, ApprovalKind, BoardMcp, BoardSkill, Card } from '@ih/core';
import { api } from './api.ts';

const KIND: Record<ApprovalKind, string> = {
  escalation: 'Needs an answer',
  spawn_agent: 'New agent',
  install_mcp: 'MCP server',
  install_skill: 'Skill',
  grant: 'Tool grant',
  install_tool: 'Install a tool',
  peer_request: 'Request to another swarm',
};

/** What approving would apply, spelled out so a human can judge it. */
function Detail({ a }: { a: Approval }) {
  switch (a.kind) {
    case 'spawn_agent': {
      const g = a.payload.agent as AgentProfile;
      return <p className="small">Adds <strong>{g.id}</strong>: a {g.role} on <code>{g.poolId}</code>{g.model ? <> running <code>{g.model}</code></> : ' on its default model'}{g.reasoning ? `, reasoning ${g.reasoning}` : ''}.</p>;
    }
    case 'install_mcp': {
      const m = a.payload.mcp as BoardMcp;
      return (
        <p className="small">
          Gives every new agent session the MCP server <strong>{m.name}</strong>: <code>{m.url ?? [m.command, ...(m.args ?? [])].join(' ')}</code>.
          {m.env && Object.keys(m.env).length > 0 && <> Environment: <code>{Object.keys(m.env).join(', ')}</code>.</>} It runs on this machine with your permissions: read what it does first.
        </p>
      );
    }
    case 'install_skill': {
      const s = a.payload.skill as BoardSkill;
      return (
        <details className="small">
          <summary>Skill <strong>{s.name}</strong>: {s.description}</summary>
          <pre className="skill-body">{s.body}</pre>
        </details>
      );
    }
    case 'grant':
      return <p className="small">Gives the card the <strong>{String(a.payload.grant)}</strong> tool grant (an extra MCP server) the next time it runs.</p>;
    case 'install_tool':
      return <p className="small">Runs the install command from Settings → Tools for <strong>{String(a.payload.grant)}</strong> on this machine, with your permissions. The card starts once it finishes.</p>;
    case 'escalation':
      return <p className="small">Your answer goes to the agent and the card runs again.</p>;
    case 'peer_request': {
      const p = a.payload as { peerName?: string; projectName?: string; title: string; description: string; blocking?: boolean; acceptance?: string[]; budget?: { maxUsd?: number; maxTokens?: number } | null };
      return (
        <div className="small">
          <p>Sends this to the swarm <strong>{p.peerName}</strong>{p.projectName ? <> (project {p.projectName})</> : null}. Their operator decides whether to take it.{p.blocking ? ' The card is on hold until they answer.' : ''}{p.budget ? ` It names a budget: ${[p.budget.maxUsd !== undefined ? `$${p.budget.maxUsd}` : '', p.budget.maxTokens !== undefined ? `${p.budget.maxTokens} tokens` : ''].filter(Boolean).join(' + ')}.` : ''}</p>
          <details open>
            <summary><strong>{p.title}</strong> (written by the agent)</summary>
            <p style={{ whiteSpace: 'pre-wrap' }}>{p.description}</p>
            {p.acceptance && p.acceptance.length > 0 && <ul>{p.acceptance.map((x, i) => <li key={i}>{x}</li>)}</ul>}
          </details>
          <p className="muted">It leaves this machine and reaches the other swarm's agents' prompts once their operator approves. Check it holds nothing private.</p>
        </div>
      );
    }
  }
}

/** Requests that wait for a decision. Approving applies them; an escalation resumes its card with your answer. */
export function ApprovalsPanel(props: { approvals: Approval[]; cards: Card[]; onSelect: (cardId: string) => void; onError: (m: string) => void }) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const title = (id: string | null) => props.cards.find((c) => c.id === id)?.title ?? id ?? '';

  async function decide(a: Approval, decision: 'approve' | 'deny') {
    setBusy(a.id);
    try {
      await api.decide(a.id, decision, notes[a.id]?.trim() || undefined);
    } catch (err) {
      props.onError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="inbox approvals" role="dialog" aria-label="Approvals">
      <div className="inbox-head">
        <strong>Approvals ({props.approvals.length})</strong>
      </div>
      {props.approvals.length === 0 && <p className="muted">Nothing is waiting for you.</p>}
      {props.approvals.map((a) => (
        <div key={a.id} className="inbox-item approval">
          <div className="muted">
            <span className="badge">{KIND[a.kind]}</span>{' '}
            {a.cardId && <button className="link" onClick={() => props.onSelect(a.cardId!)}>{title(a.cardId)}</button>}
            {' · '}
            {new Date(a.createdAt).toLocaleTimeString()}
          </div>
          <div>{a.summary}</div>
          <Detail a={a} />
          <div className="row">
            <input
              value={notes[a.id] ?? ''}
              onChange={(e) => setNotes((n) => ({ ...n, [a.id]: e.target.value }))}
              placeholder={a.kind === 'escalation' ? 'Your answer to the agent' : 'A note for the agent (optional)'}
              aria-label="Note"
            />
            <button disabled={busy === a.id || (a.kind === 'escalation' && !notes[a.id]?.trim())} onClick={() => decide(a, 'approve')}>{a.kind === 'escalation' ? 'Answer and resume' : 'Approve'}</button>
            <button className="ghost" disabled={busy === a.id} onClick={() => decide(a, 'deny')}>Deny</button>
          </div>
        </div>
      ))}
    </div>
  );
}
