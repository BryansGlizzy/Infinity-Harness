import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  getBezierPath,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { AgentProfile, Card, Dependency, Message } from '@ih/core';
import type { ActiveSession, PoolWithStatus } from './api.ts';
import { STATUS_LABEL } from './BoardView.tsx';
import { ROLE_LABEL, agentHue, cardAgent, type CardAgent } from './agentInfo.ts';
import { complexityLabel } from './labels.ts';
import { remember, saved } from './storage.ts';
import { NodeActivity } from './NodeActivity.tsx';

const W = 264;
/** Nodes have a fixed height so the layout never overlaps them. */
const H = 132;
const GAP_X = 64;
const GAP_Y = 72;
/** Messages newer than this animate their edge. */
const LIVE_MS = 2 * 60_000;

type ColorBy = 'status' | 'agent';
type CardNodeData = {
  card: Card;
  agent: CardAgent | null;
  selected: boolean;
  talking: boolean;
  hidden: number;
  collapsed: boolean;
  colorBy: ColorBy;
  onToggle: (id: string) => void;
  /** The live activity box under the node. */
  activityOpen: boolean;
  onToggleActivity: (id: string) => void;
  onOpenCard: (id: string) => void;
  titleOf: (id: string) => string;
};
type CardNode = Node<CardNodeData, 'card'>;

function CardNodeView({ data }: NodeProps<CardNode>) {
  const { card, agent, selected, talking, colorBy } = data;
  const running = card.status === 'in_progress';
  const council = card.pipeline.council;
  const hueKey = agent?.agentId ?? agent?.poolId;
  const style = colorBy === 'agent' && hueKey ? ({ '--node-hue': agentHue(hueKey) } as React.CSSProperties) : undefined;
  return (
    <>
    <div className={`tnode status-${card.status} ${card.role} ${selected ? 'selected' : ''} ${talking ? 'talking' : ''} color-${colorBy}`} style={style}>
      <Handle type="target" position={Position.Top} id="t" />
      <Handle type="target" position={Position.Left} id="l" className="side-handle" />
      <Handle type="source" position={Position.Right} id="r" className="side-handle" />
      <div className="tnode-head">
        <span className={`role-tag ${card.role}`}>{ROLE_LABEL[card.role]}</span>
        <span className={`tstatus status-${card.status}`}>{STATUS_LABEL[card.status]}</span>
        {council && <span className="badge council">council · {council.phase}</span>}
        <span className="spacer" />
        {running && <span className="pulse" aria-label="running" />}
        <button
          className={`tnode-arrow nodrag ${data.activityOpen ? 'open' : ''}`}
          aria-expanded={data.activityOpen}
          title={data.activityOpen ? 'Hide the live activity' : 'Show the live activity here'}
          onClick={(e) => {
            e.stopPropagation();
            data.onToggleActivity(card.id);
          }}
        >
          ▾
        </button>
      </div>
      <div className="tnode-title" title={card.title}>{card.title}</div>
      {agent ? (
        <div className="tnode-agent" title={`${agent.agentId ?? 'no agent'} on ${agent.poolLabel}${agent.live ? ' (live session)' : ''}`}>
          <strong>{agent.agentId ?? agent.poolId}</strong>
          <span className="muted">{agent.poolLabel}</span>
          <span className="model">
            {agent.model}
            {agent.reasoning && <span className="muted"> · {agent.reasoning}</span>}
          </span>
        </div>
      ) : (
        <div className="tnode-agent muted">not assigned yet</div>
      )}
      <div className="tnode-meta muted">
        {card.workType && <span>{card.workType}</span>}
        {card.classification && (
          <span title={`Kev complexity ${card.classification.complexity.toFixed(2)} (0–4)`}>
            {complexityLabel(card.classification.complexity)}
            {card.classification.source === 'fallback' ? '?' : ''}
          </span>
        )}
        {card.narration && <span className="tnode-narration" title={card.narration}>{card.narration}</span>}
      </div>
      {(data.hidden > 0 || data.collapsed) && (
        <button
          className="tnode-fold nodrag"
          onClick={(e) => {
            e.stopPropagation();
            data.onToggle(card.id);
          }}
        >
          {data.hidden > 0 ? `+${data.hidden} done` : 'collapse'}
        </button>
      )}
      <Handle type="source" position={Position.Bottom} id="b" />
    </div>
      {/* Beside the card, not inside it: the card clips its own overflow. */}
      {data.activityOpen && <NodeActivity cardId={card.id} titleOf={data.titleOf} onOpen={() => data.onOpenCard(card.id)} />}
    </>
  );
}

/** Messages between two cards: a curved edge with a count; while the talk is recent, dots flow along it. */
function CommsEdge(props: EdgeProps<Edge<{ n: number; live: boolean; last: number; body: string; both: boolean }>>) {
  const [path, labelX, labelY] = getBezierPath(props);
  const d = props.data!;
  return (
    <>
      <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} className="comms-path" />
      {/* Re-keyed on every new message: flashes once along the edge. */}
      <path key={d.last} d={path} className="comms-flash" fill="none" />
      {d.live &&
        [0, 1, 2].map((i) => (
          <circle key={i} r={3.5} className="comms-dot">
            <animateMotion dur="2.4s" begin={`-${i * 0.8}s`} repeatCount="indefinite" path={path} />
          </circle>
        ))}
      <EdgeLabelRenderer>
        <div className="edge-label comms nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }} title={d.body}>
          ✉ {d.n}{d.both ? ' ⇅' : ''}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { card: CardNodeView };
const edgeTypes = { comms: CommsEdge };

/** Tidy tree: leaves side by side in creation order, each parent centred over its children. */
function layout(kids: Map<string, Card[]>, roots: Card[]): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  let cursor = 0;
  const place = (card: Card, depth: number): number => {
    const children = kids.get(card.id) ?? [];
    let x: number;
    if (!children.length) x = cursor++ * (W + GAP_X);
    else {
      const xs = children.map((ch) => place(ch, depth + 1));
      x = (xs[0]! + xs[xs.length - 1]!) / 2;
    }
    pos.set(card.id, { x, y: depth * (H + GAP_Y) });
    return x;
  };
  for (const root of roots) {
    place(root, 0);
    cursor += 0.5; // a little air between separate trees
  }
  return pos;
}

type Positions = Record<string, { x: number; y: number }>;
const posKey = (boardId: string) => `ih.tree.pos.${boardId}`;
function loadPositions(boardId: string): Positions {
  try {
    return JSON.parse(saved(posKey(boardId)) ?? '{}') as Positions;
  } catch {
    return {};
  }
}

const openKey = (boardId: string) => `ih.tree.activity.open.${boardId}`;
function loadOpen(boardId: string): Set<string> {
  try {
    return new Set(JSON.parse(saved(openKey(boardId)) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

interface TreeProps {
  boardId: string;
  cards: Card[];
  dependencies: Dependency[];
  messages: Message[];
  agents: AgentProfile[];
  pools: PoolWithStatus[];
  sessions: ActiveSession[];
  selected: string | null;
  onSelect: (id: string) => void;
}

function Tree(props: TreeProps) {
  const { cards, dependencies, messages, selected, boardId } = props;
  const flow = useReactFlow();
  const [moved, setMoved] = useState<Positions>(() => loadPositions(boardId));
  const [colorBy, setColorBy] = useState<ColorBy>(() => (saved('ih.tree.color') === 'agent' ? 'agent' : 'status'));
  const [follow, setFollow] = useState(() => saved('ih.tree.follow') === '1');
  const [foldDone, setFoldDone] = useState(() => saved('ih.tree.fold') !== '0');
  /** Subtrees the user opened (with folding on) or closed (with it off). */
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const [legendOpen, setLegendOpen] = useState(true);
  /** Cards whose live activity box is open, remembered per board. */
  const [activityOpen, setActivityOpen] = useState<Set<string>>(() => loadOpen(boardId));
  const onToggleActivity = useCallback(
    (id: string) =>
      setActivityOpen((s) => {
        const next = new Set(s);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        remember(openKey(boardId), JSON.stringify([...next]));
        return next;
      }),
    [boardId],
  );
  const titleOf = useCallback((id: string) => cards.find((c) => c.id === id)?.title ?? id, [cards]);

  useEffect(() => {
    setMoved(loadPositions(boardId));
    setToggled(new Set());
    setActivityOpen(loadOpen(boardId));
  }, [boardId]);

  const onToggle = useCallback((id: string) => {
    setToggled((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const tree = useMemo(() => {
    const ids = new Set(cards.map((c) => c.id));
    const kids = new Map<string, Card[]>();
    const roots: Card[] = [];
    for (const c of cards) {
      if (c.parentId && ids.has(c.parentId)) kids.set(c.parentId, [...(kids.get(c.parentId) ?? []), c]);
      else roots.push(c);
    }
    // A finished subtree: the card and everything under it are done.
    const done = new Map<string, boolean>();
    const isDone = (c: Card): boolean => {
      if (done.has(c.id)) return done.get(c.id)!;
      const v = c.status === 'done' && (kids.get(c.id) ?? []).every(isDone);
      done.set(c.id, v);
      return v;
    };
    const hidden = new Set<string>();
    const hiddenCount = new Map<string, number>();
    const hide = (c: Card): number => (kids.get(c.id) ?? []).reduce((n, k) => (hidden.add(k.id), n + 1 + hide(k)), 0);
    const walk = (c: Card) => {
      const children = kids.get(c.id) ?? [];
      const folded = children.length > 0 && isDone(c) && (foldDone ? !toggled.has(c.id) : toggled.has(c.id));
      if (folded) hiddenCount.set(c.id, hide(c));
      else children.forEach(walk);
    };
    roots.forEach(walk);
    const visible = cards.filter((c) => !hidden.has(c.id));
    const visKids = new Map([...kids].map(([k, v]) => [k, v.filter((c) => !hidden.has(c.id))]));
    return { visible, hidden, hiddenCount, pos: layout(visKids, roots), kids, isDone };
  }, [cards, foldDone, toggled]);

  const talking = useMemo(() => {
    const now = Date.now();
    const s = new Set<string>();
    for (const m of messages) {
      if (now - Date.parse(m.createdAt) > LIVE_MS) continue;
      if (m.fromActor.startsWith('card:')) s.add(m.fromActor.slice(5));
      if (m.toCard) s.add(m.toCard);
    }
    return s;
  }, [messages]);

  const baseNodes = useMemo<CardNode[]>(
    () =>
      tree.visible.map((card) => {
        const children = tree.kids.get(card.id) ?? [];
        return {
          id: card.id,
          type: 'card',
          position: moved[card.id] ?? tree.pos.get(card.id) ?? { x: 0, y: 0 },
          // An open activity box hangs below its node and overlaps what is under it, so it sits on top.
          ...(activityOpen.has(card.id) ? { zIndex: 1000 } : {}),
          data: {
            card,
            agent: cardAgent(card, props.agents, props.pools, props.sessions),
            selected: card.id === selected,
            talking: talking.has(card.id),
            hidden: tree.hiddenCount.get(card.id) ?? 0,
            // Offer to fold an open finished subtree again.
            collapsed: !tree.hiddenCount.has(card.id) && children.length > 0 && tree.isDone(card),
            colorBy,
            onToggle,
            activityOpen: activityOpen.has(card.id),
            onToggleActivity,
            onOpenCard: props.onSelect,
            titleOf,
          },
        };
      }),
    [tree, moved, selected, talking, colorBy, onToggle, activityOpen, onToggleActivity, titleOf, props.onSelect, props.agents, props.pools, props.sessions],
  );
  const [nodes, setNodes] = useState<CardNode[]>(baseNodes);
  // New data replaces the nodes, but each keeps the size React Flow measured for it and a position being dragged.
  // Fresh nodes without a size are hidden until re-measured, so the whole tree flickered on every update (and could
  // stay blank while updates kept coming).
  useEffect(() => {
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]));
      return baseNodes.map((n) => {
        const was = old.get(n.id);
        if (!was) return n;
        return { ...n, ...(was.measured ? { measured: was.measured } : {}), ...(was.dragging ? { position: was.position, dragging: true } : {}) };
      });
    });
  }, [baseNodes]);
  const onNodesChange = useCallback((changes: NodeChange<CardNode>[]) => setNodes((ns) => applyNodeChanges(changes, ns)), []);

  const edges = useMemo<Edge[]>(() => {
    const ids = new Set(tree.visible.map((c) => c.id));
    const at = (id: string) => moved[id] ?? tree.pos.get(id) ?? { x: 0, y: 0 };
    const out: Edge[] = [];
    for (const c of tree.visible) {
      if (c.parentId && ids.has(c.parentId)) {
        out.push({ id: `p-${c.id}`, source: c.parentId, target: c.id, sourceHandle: 'b', targetHandle: 't', type: 'smoothstep', className: `edge-parent ${c.status === 'in_progress' ? 'active' : ''}` });
      }
    }
    for (const d of dependencies) {
      if (!ids.has(d.cardId) || !ids.has(d.blockedBy)) continue;
      // Cards on the same row: connect side to side instead of looping under and over.
      const a = at(d.blockedBy);
      const b = at(d.cardId);
      const sameRow = Math.abs(a.y - b.y) < H;
      const leftToRight = a.x <= b.x;
      out.push({
        id: `d-${d.blockedBy}-${d.cardId}`,
        source: d.blockedBy,
        target: d.cardId,
        ...(sameRow && leftToRight ? { sourceHandle: 'r', targetHandle: 'l', type: 'smoothstep' } : { sourceHandle: 'b', targetHandle: 't' }),
        className: 'edge-dep',
        label: 'waits for',
        markerEnd: { type: MarkerType.ArrowClosed },
      });
    }
    // Comms: one edge per pair of cards that messaged each other (either way), animated while the talk is recent.
    // It runs from the higher card to the lower one, so it uses the bottom and top handles like the tree.
    const pairs = new Map<string, { from: string; to: string; n: number; last: number; body: string; both: boolean; first: string }>();
    for (const m of messages) {
      const sender = m.fromActor.startsWith('card:') ? m.fromActor.slice(5) : null;
      if (!sender || !m.toCard || !ids.has(sender) || !ids.has(m.toCard)) continue;
      const [from, to] = at(sender).y <= at(m.toCard).y ? [sender, m.toCard] : [m.toCard, sender];
      const key = `${from}>${to}`;
      const p = pairs.get(key) ?? { from, to, n: 0, last: 0, body: '', both: false, first: sender };
      if (sender !== p.first) p.both = true;
      p.n++;
      p.last = Math.max(p.last, Date.parse(m.createdAt));
      p.body = m.body;
      pairs.set(key, p);
    }
    const now = Date.now();
    for (const [key, p] of pairs) {
      out.push({
        id: `m-${key}`,
        source: p.from,
        target: p.to,
        sourceHandle: 'b',
        targetHandle: 't',
        type: 'comms',
        className: 'edge-comms',
        markerEnd: p.both ? undefined : { type: MarkerType.ArrowClosed },
        data: { n: p.n, live: now - p.last < LIVE_MS, last: p.last, body: p.body, both: p.both },
      });
    }
    return out;
  }, [tree, dependencies, messages, moved]);

  // Follow: keep the running cards in view as they change.
  const runningIds = tree.visible.filter((c) => c.status === 'in_progress').map((c) => c.id).join(',');
  useEffect(() => {
    if (!follow || !runningIds) return;
    void flow.fitView({ nodes: runningIds.split(',').map((id) => ({ id })), duration: 600, padding: 0.4, maxZoom: 1 });
  }, [follow, runningIds, flow]);

  const savePositions = (next: Positions) => {
    setMoved(next);
    remember(posKey(boardId), JSON.stringify(next));
  };
  const setPref = (key: string, value: string) => remember(key, value);
  const fit = () => void flow.fitView({ duration: 500, padding: 0.2, maxZoom: 1.1 });

  const agentsInView = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of nodes) {
      const a = n.data.agent;
      const key = a?.agentId ?? a?.poolId;
      if (key) m.set(key, a!.model);
    }
    return [...m];
  }, [nodes]);

  return (
    <div className="tree">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={(_e, _node, dragged) => {
          const next = { ...moved };
          for (const n of dragged) next[n.id] = n.position;
          savePositions(next);
        }}
        onNodeClick={(_e, node) => props.onSelect(node.id)}
        nodesConnectable={false}
        colorMode="system"
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
        minZoom={0.15}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable className="tree-minimap" nodeClassName={(n) => `mm status-${(n.data as CardNodeData).card.status}`} />
      </ReactFlow>

      <div className="tree-tools" role="toolbar" aria-label="Tree view">
        <button className="ghost small-btn" onClick={fit} title="Zoom to fit every card">Fit</button>
        <button
          className={`ghost small-btn ${follow ? 'on' : ''}`}
          aria-pressed={follow}
          onClick={() => {
            setFollow(!follow);
            setPref('ih.tree.follow', follow ? '0' : '1');
          }}
          title="Keep the running cards in view"
        >
          Follow running
        </button>
        <button
          className={`ghost small-btn ${foldDone ? 'on' : ''}`}
          aria-pressed={foldDone}
          onClick={() => {
            setFoldDone(!foldDone);
            setToggled(new Set());
            setPref('ih.tree.fold', foldDone ? '0' : '1');
          }}
          title="Fold subtrees whose cards are all done"
        >
          Fold finished
        </button>
        <div className="seg" role="group" aria-label="Colour cards by">
          {(['status', 'agent'] as const).map((c) => (
            <button
              key={c}
              className={colorBy === c ? 'on' : ''}
              aria-pressed={colorBy === c}
              onClick={() => {
                setColorBy(c);
                setPref('ih.tree.color', c);
              }}
            >
              {c === 'status' ? 'By status' : 'By agent'}
            </button>
          ))}
        </div>
        <button
          className="ghost small-btn"
          disabled={!Object.keys(moved).length}
          onClick={() => {
            savePositions({});
            setTimeout(fit, 50);
          }}
          title="Forget the positions you dragged cards to"
        >
          Tidy layout
        </button>
      </div>

      <div className={`tree-legend ${legendOpen ? '' : 'closed'}`}>
        <button className="link small" onClick={() => setLegendOpen(!legendOpen)} aria-expanded={legendOpen}>
          {legendOpen ? 'Legend ▾' : 'Legend ▸'}
        </button>
        {legendOpen && (
          <>
            <div className="lg-row">
              <span><i className="lg parent" /> part of</span>
              <span><i className="lg active" /> working now</span>
              <span><i className="lg dep" /> waits for</span>
              <span><i className="lg comms" /> messages (dots: last 2 min)</span>
            </div>
            <div className="lg-row">
              <span className="role-tag orchestrator">Orchestrator</span>
              <span className="role-tag lead">Lead</span>
              <span className="role-tag worker">Worker</span>
              <span className="badge council">council</span>
            </div>
            {colorBy === 'agent' && agentsInView.length > 0 && (
              <div className="lg-row">
                {agentsInView.map(([id, model]) => (
                  <span key={id}>
                    <i className="lg-swatch" style={{ background: `hsl(${agentHue(id)} 65% 50%)` }} /> {id} <span className="muted">{model}</span>
                  </span>
                ))}
              </div>
            )}
            <div className="lg-row muted">Drag cards to rearrange; the layout is remembered for this board.</div>
          </>
        )}
      </div>
    </div>
  );
}

export function TreeView(props: TreeProps) {
  if (!props.cards.length) {
    return (
      <div className="tree empty">
        <div className="empty-state">
          <h3>No cards yet</h3>
          <p className="muted">Type a goal in the bar above and press <strong>Plan</strong>: the orchestrator splits it into cards, which start on their own.</p>
          <p className="muted">Or switch to <strong>Board</strong> and add a card yourself.</p>
        </div>
      </div>
    );
  }
  return (
    <ReactFlowProvider>
      <Tree {...props} />
    </ReactFlowProvider>
  );
}
