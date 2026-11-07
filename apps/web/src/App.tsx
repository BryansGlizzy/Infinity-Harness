import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { effectiveAgents, type Approval, type Board, type Card, type DaemonEvent, type Dependency, type Lease, type LiveMessage, type Message, type Outcome, type Settings } from '@mh/core';
import { api, type ActiveSession, type ModelCatalog, type PoolStatus, type PoolWithStatus } from './api.ts';
import { AgentsView } from './AgentsView.tsx';
import { MetricsView } from './MetricsView.tsx';
import { PoolsView } from './PoolsView.tsx';
import { remember, saved } from './storage.ts';
import { THEMES, applyTheme, savedTheme, type ThemeId } from './theme.ts';
import { boardAgents } from './agentInfo.ts';
import { StatusStrip } from './StatusStrip.tsx';
import { useEventStream } from './useEventStream.ts';
import { BoardView } from './BoardView.tsx';
import { CardPanel } from './CardPanel.tsx';
import { NewBoardForm } from './NewBoardForm.tsx';
import { SettingsPanel } from './SettingsPanel.tsx';
import { TreeView } from './TreeView.tsx';

const BOARD_KEY = 'mh.board';
const VIEW_KEY = 'mh.view';
const VIEWS = [
  { id: 'tree', label: 'Tree' },
  { id: 'board', label: 'Board' },
  { id: 'agents', label: 'Agents' },
  { id: 'pools', label: 'Pools' },
  { id: 'metrics', label: 'Metrics' },
] as const;
type View = (typeof VIEWS)[number]['id'];

/** "Type a goal": the orchestrator decomposes it into cards that route themselves. */
function GoalBar({ boardId, council, onError }: { boardId: string; council: number; onError: (m: string) => void }) {
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!goal.trim()) return;
    setBusy(true);
    try {
      await api.goal(boardId, goal.trim(), '');
      setGoal('');
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="goalbar" onSubmit={submit}>
      <input
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        placeholder={council >= 2 ? `Type a goal; a council of ${council} orchestrators plans it together` : 'Type a goal; the orchestrator plans it into cards'}
        aria-label="Goal"
      />
      <button type="submit" disabled={busy || !goal.trim()}>{busy ? 'Starting…' : 'Plan'}</button>
    </form>
  );
}

export function App() {
  const [boards, setBoards] = useState<Board[]>([]);
  // ?board=<id> opens that board (the VS Code extension embeds the UI this way); otherwise the last one used.
  const [boardId, setBoardId] = useState<string | null>(() => new URLSearchParams(location.search).get('board') ?? saved(BOARD_KEY));
  const [view, setView] = useState<View>(() => (VIEWS.find((v) => v.id === (new URLSearchParams(location.search).get('view') ?? saved(VIEW_KEY)))?.id ?? 'tree'));
  const [theme, setTheme] = useState<ThemeId>(savedTheme);
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [pools, setPools] = useState<PoolWithStatus[]>([]);
  const [leases, setLeases] = useState<Lease[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [pendingOutcomes, setPendingOutcomes] = useState<Outcome[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [dependencies, setDependencies] = useState<Dependency[]>([]);
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(location.search).get('card'));
  const [cardEvents, setCardEvents] = useState<DaemonEvent[]>([]);
  const [creatingBoard, setCreatingBoard] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(() => new URLSearchParams(location.search).has('settings'));
  /** A board was just created: Settings opens with a short "set up your agents" intro. */
  const [welcome, setWelcome] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [models, setModels] = useState<ModelCatalog>({});
  const [error, setError] = useState<string | null>(null);

  const refreshPools = useCallback(() => {
    void api.activeSessions().then(setSessions, () => {});
    return api.pools().then(setPools, (e: Error) => setError(e.message));
  }, []);
  useEffect(() => applyTheme(theme), [theme]);
  // The first call waits for the daemon's harness probes; refresh probes again (e.g. after a plan change).
  const refreshModels = useCallback((refresh = false) => api.models(refresh).then(setModels, (e: Error) => setError(e.message)), []);

  useEffect(() => {
    void refreshPools();
    void refreshModels();
    api.boards().then((list) => {
      setBoards(list);
      if (!list.length) setCreatingBoard(true);
      else setBoardId((id) => (id && list.some((b) => b.id === id) ? id : list[0]!.id));
    }, (e: Error) => setError(e.message));
    // Session counts change without a pool-state change; refresh them now and then.
    const timer = setInterval(() => void refreshPools(), 5000);
    return () => clearInterval(timer);
  }, [refreshPools]);

  const firstBoard = useRef(true);
  useEffect(() => {
    // Keep a ?card= selection on the first load; switching boards clears it.
    if (!firstBoard.current) setSelected(null);
    firstBoard.current = false;
    setCards([]);
    setDependencies([]);
    setApprovals([]);
    setSettings(null);
    if (!boardId) return;
    remember(BOARD_KEY, boardId);
    api.settings(boardId).then(setSettings, (e: Error) => setError(e.message));
    api.cards(boardId).then(setCards, (e: Error) => setError(e.message));
    api.leases(boardId).then(setLeases, (e: Error) => setError(e.message));
    api.messages(boardId).then(setMessages, (e: Error) => setError(e.message));
    api.pendingOutcomes(boardId).then(setPendingOutcomes, (e: Error) => setError(e.message));
    api.approvals(boardId).then(setApprovals, () => {});
    api.dependencies(boardId).then(setDependencies, (e: Error) => setError(e.message));
  }, [boardId]);

  useEffect(() => {
    setCardEvents([]);
    if (selected) api.events(selected).then(setCardEvents, (e: Error) => setError(e.message));
  }, [selected]);

  const onEvent = useCallback(
    (msg: DaemonEvent | LiveMessage) => {
      if ('live' in msg) {
        if (msg.type === 'pool.status') {
          const status = msg.payload as PoolStatus;
          setPools((list) => list.map((p) => (p.id === status.poolId ? { ...p, status } : p)));
        }
        return;
      }
      const e = msg;
      if ((e.type === 'lease.acquired' || e.type === 'lease.released') && (e.payload as Lease).boardId === boardId) {
        api.leases(boardId).then(setLeases, () => {});
      }
      if (e.type === 'message.posted') {
        const m = e.payload as Message;
        if (m.boardId === boardId) setMessages((list) => (list.some((x) => x.id === m.id) ? list : [...list, m]));
      }
      if ((e.type === 'card.outcome' || e.type === 'outcome.reviewed') && (e.payload as Outcome).boardId === boardId) {
        api.pendingOutcomes(boardId).then(setPendingOutcomes, () => {});
      }
      if (e.type === 'settings.updated' && e.subject === boardId) setSettings(e.payload as Settings);
      if ((e.type === 'approval.created' || e.type === 'approval.decided') && (e.payload as Approval).boardId === boardId) {
        api.approvals(boardId).then(setApprovals, () => {});
      }
      if (e.type === 'board.created') {
        setBoards((list) => (list.some((b) => b.id === e.subject) ? list : [...list, e.payload as Board]));
      }
      if (e.type === 'card.created' || e.type === 'card.updated') {
        const card = e.type === 'card.created' ? (e.payload as Card) : (e.payload as { card: Card }).card;
        if (card.boardId === boardId) {
          setCards((list) => (list.some((c) => c.id === card.id) ? list.map((c) => (c.id === card.id ? card : c)) : [...list, card]));
        }
        if (e.type === 'card.updated' && (e.payload as { patch: Partial<Card> }).patch.status) void refreshPools();
      }
      if (e.type === 'card.narrated') {
        const { narration } = e.payload as { narration: string };
        setCards((list) => list.map((c) => (c.id === e.subject ? { ...c, narration } : c)));
      }
      if (e.type === 'dependency.added') {
        const d = e.payload as Dependency;
        setDependencies((list) => (list.some((x) => x.cardId === d.cardId && x.blockedBy === d.blockedBy) ? list : [...list, d]));
      }
      if (e.subject === selected) {
        setCardEvents((list) => (list.some((x) => x.seq === e.seq) ? list : [...list, e]));
      }
    },
    [boardId, selected, refreshPools],
  );
  const connected = useEventStream(onEvent);

  const board = boards.find((b) => b.id === boardId) ?? null;
  const card = cards.find((c) => c.id === selected) ?? null;
  const humanMessages = messages.filter((m) => m.toCard === null);
  const switchView = (v: View) => {
    setView(v);
    remember(VIEW_KEY, v);
  };

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand" title="Infinity Harness: a meta harness for all of your agents to work together">
          <span className="brand-mark" aria-hidden="true">∞</span>
          <span className="brand-name">Infinity Harness</span>
        </span>
        {boards.length > 0 && (
          <select value={boardId ?? ''} onChange={(e) => setBoardId(e.target.value)} aria-label="Board">
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        )}
        {board && <span className="muted repo" title={board.repoPath}>{board.repoPath} · {board.defaultBranch}</span>}
        <button className="ghost" onClick={() => setCreatingBoard(true)}>New board</button>
        {board && (
          <GoalBar
            boardId={board.id}
            council={settings ? effectiveAgents(settings, pools).filter((a) => a.enabled && a.role === 'orchestrator').length : 0}
            onError={setError}
          />
        )}
        <span className="spacer" />
        {board && (
          <nav className="seg views" aria-label="View">
            {VIEWS.map((v) => (
              <button key={v.id} aria-current={view === v.id ? 'page' : undefined} className={view === v.id ? 'on' : ''} onClick={() => switchView(v.id)}>
                {v.label}
              </button>
            ))}
          </nav>
        )}
        <select className="theme-pick" value={theme} onChange={(e) => setTheme(e.target.value as ThemeId)} aria-label="Theme" title={THEMES.find((t) => t.id === theme)?.hint}>
          {THEMES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        {board && <button className={`ghost ${settingsOpen ? 'on' : ''}`} onClick={() => setSettingsOpen((o) => !o)} aria-expanded={settingsOpen}>Settings</button>}
        <span className={`dot ${connected ? 'ok' : 'down'}`} title={connected ? 'Live: connected to the daemon' : 'Disconnected: reconnecting…'} />
      </header>

      {!connected && <div className="banner warn" role="status">Lost the connection to the daemon. Reconnecting…</div>}
      {error && (
        <div className="banner" role="alert">
          {error} <button className="ghost" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {board && <StatusStrip pools={pools} leases={leases} cards={cards} humanMessages={humanMessages} pendingOutcomes={pendingOutcomes} approvals={approvals} onSelect={setSelected} onError={setError} />}

      {creatingBoard && (
        <NewBoardForm
          onCancel={boards.length ? () => setCreatingBoard(false) : undefined}
          onCreated={(b) => {
            setBoards((list) => (list.some((x) => x.id === b.id) ? list : [...list, b]));
            setBoardId(b.id);
            setCreatingBoard(false);
            setWelcome(true);
            switchView('agents');
          }}
        />
      )}

      <main className={card || settingsOpen ? 'main with-panel' : 'main'}>
        {board && view === 'tree' && (
          <TreeView
            boardId={board.id}
            cards={cards}
            dependencies={dependencies}
            messages={messages}
            agents={boardAgents(settings, pools)}
            pools={pools}
            sessions={sessions}
            selected={selected}
            onSelect={setSelected}
          />
        )}
        {board && view === 'board' && (
          <BoardView board={board} cards={cards} agents={boardAgents(settings, pools)} pools={pools} sessions={sessions} selected={selected} onSelect={setSelected} onError={setError} />
        )}
        {board && view === 'agents' && (
          <AgentsView
            boardId={board.id}
            settings={settings}
            pools={pools}
            sessions={sessions}
            models={models}
            onSettings={setSettings}
            onRefreshModels={() => void refreshModels(true)}
            onError={setError}
            intro={welcome}
            onDismissIntro={() => setWelcome(false)}
          />
        )}
        {board && view === 'pools' && (
          <PoolsView boards={boards} boardId={board.id} settings={settings} pools={pools} sessions={sessions} cards={cards} onSelect={setSelected} onError={setError} />
        )}
        {board && view === 'metrics' && <MetricsView boardId={board.id} onSelect={setSelected} onError={setError} />}
        {!board && !creatingBoard && (
          <div className="empty-state page">
            <h3>No board open</h3>
            <p className="muted">A board is one project folder. Press <strong>New board</strong> to pick a folder, or create a new one; it is set up as a repository for you.</p>
            <button onClick={() => setCreatingBoard(true)}>New board</button>
          </div>
        )}
        {settingsOpen && board ? (
          <SettingsPanel
            boardId={board.id}
            pools={pools}
            settings={settings}
            onSettings={setSettings}
            onClose={() => setSettingsOpen(false)}
            onError={setError}
            onOpenAgents={() => {
              setSettingsOpen(false);
              switchView('agents');
            }}
          />
        ) : (
          card && (
            <CardPanel
              card={card}
              cards={cards}
              pools={pools}
              sessions={sessions}
              settings={settings}
              models={models}
              events={cardEvents}
              dependencies={dependencies}
              onSelect={setSelected}
              onClose={() => setSelected(null)}
              onError={setError}
            />
          )
        )}
      </main>
    </div>
  );
}
