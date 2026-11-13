import { useState, type FormEvent } from 'react';
import { CARD_STATUSES, type AgentProfile, type Board, type Card, type CardStatus } from '@ih/core';
import { api, type ActiveSession, type PoolWithStatus } from './api.ts';
import { ROLE_LABEL, cardAgent } from './agentInfo.ts';
import { complexityLabel } from './labels.ts';

export const STATUS_LABEL: Record<CardStatus, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In progress',
  review: 'Review',
  merging: 'Merging',
  done: 'Done',
  blocked: 'Blocked',
};

const EMPTY_HINT: Record<CardStatus, string> = {
  backlog: '',
  ready: 'Cards here are routed to an agent automatically.',
  in_progress: 'Nothing running.',
  review: 'Finished work waits here to land.',
  merging: 'The merge queue is empty.',
  done: 'Landed cards end up here.',
  blocked: 'Nothing blocked.',
};

function AddCard({ boardId, onError }: { boardId: string; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api.createCard(boardId, title, description);
      setTitle('');
      setDescription('');
      setOpen(false);
    } catch (err) {
      onError((err as Error).message);
    }
  }

  if (!open) return <button className="ghost add" onClick={() => setOpen(true)}>+ Add card</button>;
  return (
    <form className="add-form" onSubmit={submit}>
      <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" required />
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Details, acceptance criteria (optional)" rows={3} />
      <div className="row">
        <button type="submit">Add</button>
        <button type="button" className="ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}

export function BoardView(props: {
  board: Board;
  cards: Card[];
  agents: AgentProfile[];
  pools: PoolWithStatus[];
  sessions: ActiveSession[];
  selected: string | null;
  onSelect: (id: string) => void;
  onError: (m: string) => void;
}) {
  return (
    <div className="board">
      {CARD_STATUSES.map((status) => {
        const column = props.cards.filter((c) => c.status === status);
        return (
          <section key={status} className="column">
            <h3>
              {STATUS_LABEL[status]} <span className="count">{column.length}</span>
            </h3>
            {column.map((card) => {
              const agent = cardAgent(card, props.agents, props.pools, props.sessions);
              return (
                <button
                  key={card.id}
                  className={`card ${card.id === props.selected ? 'selected' : ''} status-${card.status} ${card.role}`}
                  onClick={() => props.onSelect(card.id)}
                >
                  <span className="meta">
                    <span className={`role-tag ${card.role}`}>{ROLE_LABEL[card.role]}</span>
                    {card.pipeline.council && <span className="badge council">council</span>}
                    {card.status === 'in_progress' && <span className="pulse" aria-label="running" />}
                  </span>
                  <span className="title">{card.title}</span>
                  {agent && (
                    <span className="card-agent">
                      <strong>{agent.agentId ?? agent.poolId}</strong> <span className="muted">{agent.poolLabel}</span> · {agent.model}
                      {agent.reasoning && <span className="muted"> · {agent.reasoning}</span>}
                    </span>
                  )}
                  {(card.workType || card.classification) && (
                    <span className="meta">
                      {card.workType && <span>{card.workType}</span>}
                      {card.classification && <span>· {complexityLabel(card.classification.complexity)}</span>}
                    </span>
                  )}
                  {card.narration && <span className="card-narration">{card.narration}</span>}
                </button>
              );
            })}
            {column.length === 0 && status !== 'backlog' && <p className="column-empty muted small">{EMPTY_HINT[status]}</p>}
            {status === 'backlog' && <AddCard boardId={props.board.id} onError={props.onError} />}
          </section>
        );
      })}
    </div>
  );
}
