import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { effectiveAgents, type Mention, type Approval, type Board, type Card, type DaemonEvent, type Dependency, type FedRequest, type Lease, type LiveMessage, type Message, type Outcome, type Settings } from '@ih/core';
import { api, type ActiveSession, type FederationOverview, type ModelCatalog, type PoolStatus, type PoolWithStatus } from './api.ts';
import { AgentsView } from './AgentsView.tsx';
import { MetricsView } from './MetricsView.tsx';
import { PoolsView } from './PoolsView.tsx';
import { remember, saved } from './storage.ts';
import { COLOR_MODES, THEMES, applyColorMode, applyTheme, savedColorMode, savedTheme, type ColorMode, type ThemeId } from './theme.ts';
import { boardAgents } from './agentInfo.ts';
import { StatusStrip } from './StatusStrip.tsx';
import { publishEvent } from './activityBus.ts';
import { SwarmsView } from './SwarmsView.tsx';
import { useEventStream } from './useEventStream.ts';
import { BoardView } from './BoardView.tsx';
import { CardPanel } from './CardPanel.tsx';
import { NewBoardForm } from './NewBoardForm.tsx';
import { RemoveBoardDialog } from './RemoveBoardDialog.tsx';
import { FileTree, type OpenFile } from './FileTree.tsx';
import { FileViewer } from './FileViewer.tsx';
import { MentionInput, MentionsContext } from './Mentions.tsx';
import { SettingsPanel } from './SettingsPanel.tsx';
import { TreeView } from './TreeView.tsx';

const BOARD_KEY = 'ih.board';
const VIEW_KEY = 'ih.view';
const VIEWS = [
  { id: 'tree', label: 'Tree' },
  { id: 'board', label: 'Board' },
  { id: 'agents', label: 'Agents' },
  { id: 'pools', label: 'Pools' },
  { id: 'metrics', label: 'Metrics' },
  { id: 'swarms', label: 'Swarms' },
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
      <span className={`goalbar-tag ${council >= 2 ? 'council' : ''}`} title={council >= 2 ? `${council} orchestrators enabled` : 'Orchestrator goal prompt'}>
        {council >= 2 ? `Council (${council})` : 'Goal'}
      </span>
      <MentionInput
        value={goal}
        onChange={setGoal}
        placeholder={council >= 2 ? `Describe a goal — a council of ${council} orchestrators plans it together (@ names a peer project)…` : 'Describe a goal — the orchestrator decomposes it into cards (@ names another swarm\'s project)…'}
        ariaLabel="Goal"
      />
      <button type="submit" className="goalbar-submit" disabled={busy || !goal.trim()}>{busy ? 'Starting…' : 'Plan'}</button>
    </form>
  );
}

export function App() {
  const [boards, setBoards] = useState<Board[]>([]);
  // ?board=<id> opens that board (the VS Code extension embeds the UI this way); otherwise the last one used.
  const [boardId, setBoardId] = useState<string | null>(() => new URLSearchParams(location.search).get('board') ?? saved(BOARD_KEY));
  const [view, setView] = useState<View>(() => (VIEWS.find((v) => v.id === (new URLSearchParams(location.search).get('view') ?? saved(VIEW_KEY)))?.id ?? 'tree'));
  const [theme, setTheme] = useState<ThemeId>(savedTheme);
  const [colorMode, setColorMode] = useState<ColorMode>(savedColorMode);
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
  const [removingBoard, setRemovingBoard] = useState(false);
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  const [treeRefresh, setTreeRefresh] = useState(0);
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(() => new URLSearchParams(location.search).has('settings'));
  /** A board was just created: Settings opens with a short "set up your agents" intro. */
  const [welcome, setWelcome] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [models, setModels] = useState<ModelCatalog>({});
  const [error, setError] = useState<string | null>(null);
  // Swarm federation (Phase 7): peers, shared projects, requests; swarm-wide, not per board.
  const [federation, setFederation] = useState<FederationOverview | null>(null);
  const [peerRequests, setPeerRequests] = useState<FedRequest[]>([]);
  const refreshFederation = useCallback(() => {
    void api.federation().then(setFederation, () => {});
    void api.peerRequests().then(setPeerRequests, () => {});
    void api.mentions().then(setMentions, () => {});
  }, []);

  const refreshPools = useCallback(() => {
    // Only when something changed: a new array every few seconds re-renders (and, in the tree, rebuilds) everything.
    void api.activeSessions().then((next) => setSessions((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next)), () => {});
    return api.pools().then(setPools, (e: Error) => setError(e.message));
  }, []);
  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => {
    applyColorMode(colorMode);
    if (colorMode !== 'system' || typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyColorMode('system');
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, [colorMode]);
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
    // Links to peers change state without an event of their own.
    refreshFederation();
    const fedTimer = setInterval(refreshFederation, 15000);
    return () => {
      clearInterval(timer);
      clearInterval(fedTimer);
    };
  }, [refreshPools, refreshFederation]);

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
    if (!selected) return;
    let current = true;
    api.events(selected).then(
      (list) => {
        // Ignore the answer for a card that is no longer open; keep events that streamed in while it was loading.
        if (!current) return;
        setCardEvents((arrived) => {
          const have = new Set(list.map((e) => e.seq));
          return [...list, ...arrived.filter((e) => !have.has(e.seq))].sort((a, b) => a.seq - b.seq);
        });
      },
      (e: Error) => current && setError(e.message),
    );
    return () => {
      current = false;
    };
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
      publishEvent(e);
      if ((e.type === 'lease.acquired' || e.type === 'lease.released') && (e.payload as Lease).boardId === boardId) {
        api.leases(boardId).then(setLeases, () => {});
      }
      if (e.type === 'message.posted') {
        const m = e.payload as Message;
        if (m.boardId === boardId) setMessages((list) => (list.some((x) => x.id === m.id) ? list : [...list, m]));
      }
      if (e.type === 'message.dismissed' && e.subject === boardId) {
        const { ids, at } = e.payload as { ids: string[]; at: string };
        setMessages((list) => list.map((m) => (ids.includes(m.id) && !m.dismissedAt ? { ...m, dismissedAt: at } : m)));
      }
      if ((e.type === 'card.outcome' || e.type === 'outcome.reviewed') && (e.payload as Outcome).boardId === boardId) {
        api.pendingOutcomes(boardId).then(setPendingOutcomes, () => {});
      }
      if (e.type === 'settings.updated' && e.subject === boardId) setSettings(e.payload as Settings);
      if ((e.type === 'approval.created' || e.type === 'approval.decided') && (e.payload as Approval).boardId === boardId) {
        api.approvals(boardId).then(setApprovals, () => {});
      }
      if (e.type === 'pool.ejected' || e.type === 'pool.restored') void refreshPools();
      if (e.type === 'peer.updated' || e.type === 'request.updated' || e.type === 'project.updated') refreshFederation();
      if (e.type === 'board.removed') {
        void api.boards().then((list) => {
          setBoards(list);
          setBoardId((id) => (id && list.some((b) => b.id === id) ? id : (list[0]?.id ?? null)));
          if (!list.length) setCreatingBoard(true);
        }, () => {});
      }
      if (e.type === 'board.created') {
        setBoards((list) => (list.some((b) => b.id === e.subject) ? list : [...list, e.payload as Board]));
      }
      if (e.type === 'card.created' || e.type === 'card.updated') {
        const card = e.type === 'card.created' ? (e.payload as Card) : (e.payload as { card: Card }).card;
        if (card.boardId === boardId) {
          setCards((list) => (list.some((c) => c.id === card.id) ? list.map((c) => (c.id === card.id ? card : c)) : [...list, card]));
        }
        if (e.type === 'card.updated' && (e.payload as { patch: Partial<Card> }).patch.status) {
          void refreshPools();
          setTreeRefresh((n) => n + 1); // a card finished or landed: the files may have changed
        }
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
    [boardId, selected, refreshPools, refreshFederation],
  );
  const connected = useEventStream(onEvent);

  // A card and a file share the right-hand side: opening one closes the other.
  useEffect(() => {
    if (selected) setOpenFile(null);
  }, [selected]);
  useEffect(() => setOpenFile(null), [boardId]);

  const board = boards.find((b) => b.id === boardId) ?? null;
  const card = cards.find((c) => c.id === selected) ?? null;
  const humanMessages = messages.filter((m) => m.toCard === null && !m.dismissedAt);
  const switchView = (v: View) => {
    setView(v);
    remember(VIEW_KEY, v);
  };
  /** Shows a card in the right-hand pane even when Settings or a file is open there. */
  const showCard = (id: string) => {
    setSettingsOpen(false);
    setOpenFile(null);
    setSelected(id);
  };
  /** Opens Settings on a given tab (it remembers its last tab, so a remount picks this one). */
  const [settingsKey, setSettingsKey] = useState(0);
  const showSettings = (tab: string) => {
    remember('ih.settings.tab', tab);
    setSettingsKey((k) => k + 1);
    setSelected(null);
    setOpenFile(null);
    setSettingsOpen(true);
  };
  const dismissMessages = (ids?: string[]) => {
    if (!boardId) return;
    const at = new Date().toISOString();
    // Cleared at once; the daemon's reply (and its event) agree, and a failure puts them back.
    setMessages((list) => list.map((m) => (m.toCard === null && !m.dismissedAt && (!ids || ids.includes(m.id)) ? { ...m, dismissedAt: at } : m)));
    api.dismissMessages(boardId, ids).catch((e: Error) => {
      setError(e.message);
      void api.messages(boardId).then(setMessages, () => {});
    });
  };

  return (
    <MentionsContext.Provider value={mentions}>
    <div className="app">
      <header className="topbar">
        <div className="topbar-group">
          <span className="brand" title="Infinity Harness: a meta harness for all of your agents to work together">
            <span className="brand-mark" aria-hidden="true">∞</span>
            <span className="brand-name">Infinity Harness</span>
          </span>
          {boards.length > 0 && (
            <select className="board-select" value={boardId ?? ''} onChange={(e) => setBoardId(e.target.value)} aria-label="Board">
              {boards.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
          {board && (
            <span className="repo-pill" title={`${board.repoPath} (${board.defaultBranch})`}>
              <span className="muted repo">{board.repoPath}</span>
              <span className="repo-branch">{board.defaultBranch}</span>
            </span>
          )}
          <div className="topbar-actions">
            <button className="ghost small-btn" onClick={() => setCreatingBoard(true)}>+ New board</button>
            {board && <button className="ghost small-btn" onClick={() => setRemovingBoard(true)} title="Remove this board from Infinity Harness, or delete its folder too">Remove…</button>}
          </div>
        </div>
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
        <span className="spacer" />
        <div className="topbar-group topbar-right">
          <select className="theme-pick" value={theme} onChange={(e) => setTheme(e.target.value as ThemeId)} aria-label="Theme" title={THEMES.find((t) => t.id === theme)?.hint}>
            {THEMES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <div className="seg mode-pick" role="group" aria-label="Color mode">
            {COLOR_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                className={colorMode === m.id ? 'on' : ''}
                aria-pressed={colorMode === m.id}
                title={m.hint}
                onClick={() => setColorMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
          {board && <button className={`ghost ${settingsOpen ? 'on' : ''}`} onClick={() => setSettingsOpen((o) => !o)} aria-expanded={settingsOpen}>Settings</button>}
          <span className={`conn-pill ${connected ? 'ok' : 'down'}`} title={connected ? 'Live: connected to the daemon over WebSocket' : 'Disconnected: reconnecting to the daemon…'}>
            <span className={`dot ${connected ? 'ok' : 'down'}`} />
            <span className="conn-label">{connected ? 'Live' : 'Offline'}</span>
          </span>
        </div>
      </header>

      {board && (
        <div className="command-bar">
          <GoalBar
            boardId={board.id}
            council={settings ? effectiveAgents(settings, pools).filter((a) => a.enabled && a.role === 'orchestrator').length : 0}
            onError={setError}
          />
        </div>
      )}

      {notice && (
        <div className="banner notice" role="status">
          <span>{notice}</span>
          <span className="spacer" />
          <button className="ghost small-btn" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}
      {removingBoard && board && (
        <RemoveBoardDialog
          board={board}
          onClose={() => setRemovingBoard(false)}
          onError={setError}
          onRemoved={(note) => {
            setRemovingBoard(false);
            setNotice(note);
          }}
        />
      )}
      {!connected && <div className="banner warn" role="status">Lost the connection to the daemon. Reconnecting…</div>}
      {error && (
        <div className="banner" role="alert">
          <span>{error}</span>
          <span className="spacer" />
          <button className="ghost small-btn" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {board && <StatusStrip pools={pools} leases={leases} cards={cards} humanMessages={humanMessages} pendingOutcomes={pendingOutcomes} approvals={approvals} swarmWaiting={federation ? federation.needs.knocks.length + federation.needs.requests.length : 0} onOpenSwarms={() => switchView('swarms')} onOpenAgents={() => { setSettingsOpen(false); switchView('agents'); }} onOpenSettings={showSettings} onDismiss={dismissMessages} onSelect={showCard} onError={setError} />}

      {creatingBoard && (
        boards.length > 0 ? (
          <div className="modal-backdrop" role="presentation" onClick={() => setCreatingBoard(false)}>
            <div className="modal-sheet-wrap" onClick={(e) => e.stopPropagation()}>
              <NewBoardForm
                onCancel={() => setCreatingBoard(false)}
                onCreated={(b) => {
                  setBoards((list) => (list.some((x) => x.id === b.id) ? list : [...list, b]));
                  setBoardId(b.id);
                  setCreatingBoard(false);
                  setWelcome(true);
                  switchView('agents');
                }}
              />
            </div>
          </div>
        ) : (
          <NewBoardForm
            onCreated={(b) => {
              setBoards((list) => (list.some((x) => x.id === b.id) ? list : [...list, b]));
              setBoardId(b.id);
              setCreatingBoard(false);
              setWelcome(true);
              switchView('agents');
            }}
          />
        )
      )}

      <div className="workspace">
      {board && (
        <FileTree
          board={board}
          card={card}
          open={openFile}
          refreshKey={treeRefresh}
          onOpen={(f) => {
            setSelected(null);
            setOpenFile(f);
          }}
        />
      )}
      <main className={card || settingsOpen || openFile ? 'main with-panel' : 'main'}>
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
            onPoolsChanged={() => void refreshPools()}
            onError={setError}
            intro={welcome}
            onDismissIntro={() => setWelcome(false)}
          />
        )}
        {board && view === 'pools' && (
          <PoolsView boards={boards} boardId={board.id} settings={settings} pools={pools} sessions={sessions} cards={cards} onSelect={setSelected} onError={setError} />
        )}
        {board && view === 'metrics' && <MetricsView boardId={board.id} onSelect={setSelected} onError={setError} />}
        {board && view === 'swarms' && <SwarmsView overview={federation} requests={peerRequests} onRefresh={refreshFederation} onError={setError} />}
        {!board && !creatingBoard && (
          <div className="empty-state page">
            <h3>No board open</h3>
            <p className="muted">A board is one project folder. Press <strong>New board</strong> to pick a folder, or create a new one; it is set up as a repository for you.</p>
            <button onClick={() => setCreatingBoard(true)}>New board</button>
          </div>
        )}
        {settingsOpen && board ? (
          <SettingsPanel
            key={settingsKey}
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
        ) : openFile && board ? (
          <FileViewer board={board} file={openFile} onClose={() => setOpenFile(null)} onError={setError} />
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
    </div>
    </MentionsContext.Provider>
  );
}
