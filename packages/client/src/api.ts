// The daemon's REST API, one typed method per endpoint. Methods are arrow properties so they survive being passed around.
import type { AddonView, EfficiencyReport, Approval, Artifact, BoardMcpView, McpLibraryEntry, McpServerView, BoardRemovalInfo, DirListing, FileContent, Mention, BoardRemovalMode, BoardRemovalResult, DrafterMode, PeerCaps, FedRequest, FederationNeeds, FederationSettings, Peer, PeerProject, ProjectCard, RequestBudget, RequestResolution, SharedProject, Visibility, ArtifactKind, Board, Card, CardStatus, ChatItem, DaemonEvent, Dependency, Lease, Message, Outcome, Pool, RoutingRules, Session, Settings } from '@ih/core';
import { DaemonHttp } from './http.ts';
import type { FederationOverview, PeerDetail, PeerHit, PeerPreview, ActiveSession, AgentPrior, Candidate, CardChanges, FolderInfo, HarnessLoginFlow, MetricsReport, ModelCatalog, PoolHealthView, PoolHistoryData, PoolStatus, PoolWithStatus, RepoSetup, ReviewComment, SearchHit, SystemHarnessId, SystemHarnessStatus, UsageSummary } from './types.ts';

const GOAL_TIMEOUT_MS = 180_000;
const INSTALL_TIMEOUT_MS = 20 * 60_000;

export class DaemonApi {
  readonly http: DaemonHttp;
  constructor(http: DaemonHttp) {
    this.http = http;
  }

  private call = <T>(method: string, path: string, body?: unknown, timeoutMs?: number) => this.http.call<T>(method, path, body, { timeoutMs });

  get baseUrl(): string {
    return this.http.baseUrl;
  }
  set baseUrl(value: string) {
    this.http.baseUrl = value;
  }
  get token(): string {
    return this.http.token;
  }
  set token(value: string) {
    this.http.token = value;
  }
  wsUrl = (path: string) => this.http.wsUrl(path);

  /** True when the daemon answers its health check. */
  healthy = async (): Promise<boolean> => {
    try {
      await this.call('GET', '/api/health', undefined, 2_000);
      return true;
    } catch {
      return false;
    }
  };
  /** `local`: callers on this machine need no token. `token`: everyone does. */
  health = () => this.call<{ ok: boolean; auth: 'local' | 'token' }>('GET', '/api/health', undefined, 5_000);

  // --- pools and models
  pools = () => this.call<PoolWithStatus[]>('GET', '/api/pools');
  activeSessions = () => this.call<ActiveSession[]>('GET', '/api/sessions/active');
  /** Checks now whether the pool's model is answering. */
  testPool = (id: string) => this.call<PoolHealthView>('POST', `/api/pools/${id}/test`);
  /** Puts a pool that was taken out of rotation back in. */
  restorePool = (id: string) => this.call<PoolHealthView>('POST', `/api/pools/${id}/restore`);
  forcePool = (id: string, pct: number | null) => this.call<PoolStatus>('POST', `/api/pools/${id}/force`, { pct });
  models = (refresh = false) => this.call<ModelCatalog>('GET', `/api/models${refresh ? '?refresh=1' : ''}`, undefined, refresh ? 120_000 : undefined);
  poolHistory = (poolId: string, hours = 24) => this.call<PoolHistoryData>('GET', `/api/pools/${poolId}/history?hours=${hours}`);

  // --- boards and cards
  boards = () => this.call<Board[]>('GET', '/api/boards');
  createBoard = (name: string, repoPath: string, setup?: RepoSetup, mode?: Board['mode']) => this.call<Board & { setup: string[] }>('POST', '/api/boards', { name, repoPath, setup, mode });
  /** A folder of the project (or of one card's worktree), read-only, for the file tree. */
  listFiles = (boardId: string, path = '', cardId?: string) => this.call<DirListing>('GET', `/api/boards/${boardId}/files?${new URLSearchParams({ path, ...(cardId ? { card: cardId } : {}) })}`);
  readFile = (boardId: string, path: string, cardId?: string) => this.call<FileContent>('GET', `/api/boards/${boardId}/file?${new URLSearchParams({ path, ...(cardId ? { card: cardId } : {}) })}`);
  /** Projects of other swarms that can be typed after an @ in a prompt. */
  mentions = () => this.call<Mention[]>('GET', '/api/federation/mentions');
  /** What removing a board would touch. */
  boardRemoval = (id: string) => this.call<BoardRemovalInfo>('GET', `/api/boards/${id}/removal`);
  /** `forget`: take the board out of Infinity Harness (the folder stays). `delete`: also delete the project folder; the board's name must be passed back as `confirmName`. */
  removeBoard = (id: string, mode: BoardRemovalMode, confirmName?: string) => this.call<BoardRemovalResult>('POST', `/api/boards/${id}/remove`, { mode, confirmName }, 120_000);
  folder = (path: string, hidden = false) => this.call<FolderInfo>('GET', `/api/fs?${new URLSearchParams({ path, ...(hidden ? { hidden: '1' } : {}) })}`);
  cards = (boardId: string) => this.call<Card[]>('GET', `/api/boards/${boardId}/cards`);
  createCard = (boardId: string, title: string, description: string, status?: CardStatus) => this.call<Card>('POST', `/api/boards/${boardId}/cards`, { title, description, status });
  /** "Type a goal": the orchestrator decomposes it into cards. */
  goal = (boardId: string, goal: string, description: string) => this.call<Card>('POST', `/api/boards/${boardId}/goals`, { goal, description }, GOAL_TIMEOUT_MS);
  moveCard = (id: string, status: CardStatus) => this.call<Card>('PATCH', `/api/cards/${id}`, { status });
  setRouting = (id: string, routing: RoutingRules | null) => this.call<Card>('PATCH', `/api/cards/${id}`, { routing });
  setGrants = (cardId: string, grants: string[]) => this.call<Card>('PATCH', `/api/cards/${cardId}`, { grants });
  run = (id: string, poolId: string, model?: string, agentId?: string) => this.call<Session>('POST', `/api/cards/${id}/run`, { poolId, model, agentId });
  /** Deletes the card's worktree folder; the branch stays. Refused (409) when it has uncommitted changes, unless `force`. */
  removeWorktree = (id: string, force = false) => this.call<{ removed: boolean; discarded: string[]; branch: string | null }>('POST', `/api/cards/${id}/worktree/remove`, { force });
  cancel = (id: string) => this.call<{ ok: boolean }>('POST', `/api/cards/${id}/cancel`);
  events = (id: string) => this.call<DaemonEvent[]>('GET', `/api/cards/${id}/events`);
  sessions = (id: string) => this.call<Session[]>('GET', `/api/cards/${id}/sessions`);
  route = (id: string) => this.call<Candidate[]>('GET', `/api/cards/${id}/route`);
  terminal = (id: string) => this.call<{ available: boolean }>('GET', `/api/cards/${id}/terminal`);
  chat = (cardId: string, after = 0) => this.call<{ items: ChatItem[]; last: number }>('GET', `/api/cards/${cardId}/chat?after=${after}`);
  leases = (boardId: string) => this.call<Lease[]>('GET', `/api/boards/${boardId}/leases`);
  dependencies = (boardId: string) => this.call<Dependency[]>('GET', `/api/boards/${boardId}/dependencies`);
  addDependency = (cardId: string, blockedBy: string) => this.call<Dependency>('POST', `/api/cards/${cardId}/dependencies`, { blockedBy });

  // --- messages
  messages = (boardId: string) => this.call<Message[]>('GET', `/api/boards/${boardId}/messages`);
  /** Clears messages for the humans from the attention list: the given ids, or all of the board's. */
  dismissMessages = (boardId: string, ids?: string[]) => this.call<{ dismissed: string[] }>('POST', `/api/boards/${boardId}/messages/dismiss`, ids ? { ids } : {});
  sendMessage = (id: string, body: string, urgent = false) => this.call<Message>('POST', `/api/cards/${id}/messages`, { body, urgent });

  // --- context
  artifacts = (cardId: string, all = false) => this.call<Artifact[]>('GET', `/api/cards/${cardId}/artifacts${all ? '?all=1' : ''}`);
  addArtifact = (cardId: string, kind: ArtifactKind, title: string, body: string) => this.call<Artifact>('POST', `/api/cards/${cardId}/artifacts`, { kind, title, body });
  searchContext = (boardId: string, q: string, opts: { card?: string; scope?: string } = {}) =>
    this.call<SearchHit[]>('GET', `/api/boards/${boardId}/context?${new URLSearchParams({ q, ...(opts.card ? { card: opts.card } : {}), ...(opts.scope ? { scope: opts.scope } : {}) })}`);

  // --- changes and review
  changes = (cardId: string) => this.call<CardChanges>('GET', `/api/cards/${cardId}/changes`);
  diff = (cardId: string, path?: string) => this.call<{ diff: string }>('GET', `/api/cards/${cardId}/diff${path ? `?path=${encodeURIComponent(path)}` : ''}`);
  /** A file's contents on the card's branch (`to`, the default) or before it (`from`). */
  file = (cardId: string, path: string, side?: 'from' | 'to') =>
    this.call<{ path: string; ref: string; content: string }>('GET', `/api/cards/${cardId}/file?${new URLSearchParams({ path, ...(side ? { side } : {}) })}`);
  /** The operator's verdict on a card's branch: approve, or ask for changes with notes and comments on lines. */
  review = (cardId: string, verdict: 'approve' | 'changes', notes = '', comments: ReviewComment[] = []) =>
    this.call<Card>('POST', `/api/cards/${cardId}/review`, comments.length ? { verdict, notes, comments } : { verdict, notes });
  /** A comment on a line of the diff, sent to the card's agent at once. */
  comment = (cardId: string, c: ReviewComment) => this.call<Message>('POST', `/api/cards/${cardId}/comments`, c);
  land = (cardId: string) => this.call<Card>('POST', `/api/cards/${cardId}/land`);
  tryLocally = (cardId: string, mode: 'checkout' | 'apply') => this.call<{ summary: string }>('POST', `/api/cards/${cardId}/try`, { mode });

  // --- outcomes, priors, metrics
  pendingOutcomes = (boardId: string) => this.call<Outcome[]>('GET', `/api/outcomes?board=${boardId}&pending=1`);
  reviewOutcome = (id: number, verdict: 'pass' | 'fail' | 'ignore') => this.call<Outcome>('POST', `/api/outcomes/${id}/review`, { verdict });
  cardOutcomes = (cardId: string) => this.call<Outcome[]>('GET', `/api/cards/${cardId}/outcomes`);
  priors = (boardId: string) => this.call<AgentPrior[]>('GET', `/api/boards/${boardId}/priors`);
  metrics = (boardId: string, hours = 24) => this.call<MetricsReport>('GET', `/api/boards/${boardId}/metrics?hours=${hours}`);
  /** The headline numbers of `metrics` (a daemon without the endpoint rejects). */
  usage = (boardId: string, hours = 24) => this.call<UsageSummary>('GET', `/api/boards/${boardId}/metrics?hours=${hours}`);

  // --- approvals and tools
  approvals = (boardId: string, status: Approval['status'] = 'pending') => this.call<Approval[]>('GET', `/api/boards/${boardId}/approvals?status=${status}`);
  decide = (id: string, decision: 'approve' | 'deny', note?: string) => this.call<Approval>('POST', `/api/approvals/${id}/decide`, { decision, note });
  tools = (boardId: string) => this.call<{ name: string; command: string; installed: boolean; installable: boolean }[]>('GET', `/api/boards/${boardId}/tools`);
  // MCP hub (Phase 9): the machine's library of servers, and a board's view of it.
  mcpServers = () => this.call<McpServerView[]>('GET', '/api/mcp');
  mcpAdd = (entry: McpLibraryEntry) => this.call<McpServerView>('POST', '/api/mcp', entry);
  mcpSave = (id: string, entry: McpLibraryEntry) => this.call<McpServerView>('PUT', `/api/mcp/${encodeURIComponent(id)}`, entry);
  mcpRemove = (id: string) => this.call<{ ok: boolean }>('DELETE', `/api/mcp/${encodeURIComponent(id)}`);
  mcpAction = (id: string, action: 'start' | 'stop' | 'restart' | 'refresh') => this.call<McpServerView>('POST', `/api/mcp/${encodeURIComponent(id)}/${action}`, undefined, 120_000);
  mcpInstall = (id: string) => this.call<{ ok: boolean; output: string; server: McpServerView }>('POST', `/api/mcp/${encodeURIComponent(id)}/install`, undefined, INSTALL_TIMEOUT_MS);
  addons = (boardId: string) => this.call<AddonView[]>('GET', `/api/boards/${boardId}/addons`);
  addonEnable = (boardId: string, id: string, move = false) => this.call<AddonView>('POST', `/api/boards/${boardId}/addons/${encodeURIComponent(id)}/enable`, { move }, INSTALL_TIMEOUT_MS);
  addonDisable = (boardId: string, id: string) => this.call<AddonView>('POST', `/api/boards/${boardId}/addons/${encodeURIComponent(id)}/disable`);
  efficiency = (boardId: string) => this.call<EfficiencyReport>('GET', `/api/boards/${boardId}/efficiency`);
  boardMcp = (boardId: string) => this.call<BoardMcpView>('GET', `/api/boards/${boardId}/mcp`);
  installTool = (boardId: string, grant: string) => this.call<{ ok: boolean; output: string; installed: boolean }>('POST', `/api/boards/${boardId}/tools/${grant}/install`, undefined, INSTALL_TIMEOUT_MS);

  // --- system harnesses (discovery, install, sign-in, .env config)
  harnesses = () => this.call<SystemHarnessStatus[]>('GET', '/api/harnesses');
  installHarness = (id: SystemHarnessId) =>
    this.call<{ ok: boolean; output: string; harness: SystemHarnessStatus; pools: Pool[] }>('POST', `/api/harnesses/${encodeURIComponent(id)}/install`, undefined, INSTALL_TIMEOUT_MS);
  loginHarness = (id: SystemHarnessId, opts: { apiKey?: string; mode?: string } = {}) =>
    this.call<{ flow: HarnessLoginFlow | null; harness: SystemHarnessStatus; pools: Pool[] }>('POST', `/api/harnesses/${encodeURIComponent(id)}/login`, opts, 60_000);
  cancelHarnessLogin = (id: SystemHarnessId) =>
    this.call<{ ok: boolean; harness: SystemHarnessStatus }>('POST', `/api/harnesses/${encodeURIComponent(id)}/login/cancel`);
  configureHarnessEnv = (patch: { nimApiKey?: string; nimModel?: string; localBaseUrl?: string; localModel?: string }) =>
    this.call<{ harness: SystemHarnessStatus; pools: Pool[] }>('POST', '/api/harnesses/env', patch);

  // --- settings
  settings = (boardId: string) => this.call<Settings>('GET', `/api/boards/${boardId}/settings`);
  updateSettings = (boardId: string, patch: Partial<Settings>) => this.call<Settings>('PATCH', `/api/boards/${boardId}/settings`, patch);

  // --- swarm federation (Phase 7)
  federation = () => this.call<FederationOverview>('GET', '/api/federation');
  /** Needs-you items from peers: knocks waiting for a decision and requests waiting for approval. */
  federationNeeds = async (): Promise<FederationNeeds> => (await this.federation()).needs;
  updateFederation = (patch: Partial<FederationSettings>) => this.call<FederationSettings>('PATCH', '/api/federation/settings', patch);
  peers = () => this.call<Peer[]>('GET', '/api/federation/peers');
  peer = (id: string) => this.call<PeerDetail>('GET', `/api/federation/peers/${encodeURIComponent(id)}`);
  addPeer = (input: { label: string; ssh?: { target: string; sshPort?: number; remotePort?: number }; url?: string; expectedFingerprint?: string; shares?: Visibility }) => this.call<Peer>('POST', '/api/federation/peers', input);
  decidePeer = (id: string, decision: 'approve' | 'deny' | 'block') => this.call<{ peer: Peer | null }>('POST', `/api/federation/peers/${encodeURIComponent(id)}/decide`, { decision });
  updatePeer = (id: string, patch: { ssh?: { target: string; sshPort?: number; remotePort?: number }; url?: string; label?: string; trust?: 'verified' | 'trusted' | 'blocked'; shares?: Visibility; enabled?: boolean; autoAccept?: boolean; caps?: PeerCaps }) => this.call<Peer>('PATCH', `/api/federation/peers/${encodeURIComponent(id)}`, patch);
  removePeer = (id: string) => this.call<{ ok: boolean }>('DELETE', `/api/federation/peers/${encodeURIComponent(id)}`);
  pollPeer = (id: string) => this.call<Peer>('POST', `/api/federation/peers/${encodeURIComponent(id)}/poll`, undefined, 60_000);
  previewPeer = (id: string) => this.call<PeerPreview>('GET', `/api/federation/peers/${encodeURIComponent(id)}/preview`);
  peerProjects = (q?: string) => this.call<PeerHit[]>('GET', `/api/federation/projects${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  sharedProjects = () => this.call<SharedProject[]>('GET', '/api/federation/shared');
  draftProject = (boardId: string, mode?: DrafterMode) => this.call<{ shared?: SharedProject; started?: Card }>('POST', `/api/federation/shared/${boardId}/draft`, { mode }, GOAL_TIMEOUT_MS);
  saveProjectDraft = (boardId: string, card: Partial<ProjectCard>) => this.call<SharedProject>('PUT', `/api/federation/shared/${boardId}/draft`, { card });
  publishProject = (boardId: string, visibility: Visibility) => this.call<SharedProject>('POST', `/api/federation/shared/${boardId}/publish`, { visibility });
  unpublishProject = (boardId: string) => this.call<SharedProject>('POST', `/api/federation/shared/${boardId}/unpublish`);
  peerRequests = (opts: { direction?: 'in' | 'out'; peer?: string; open?: boolean } = {}) =>
    this.call<FedRequest[]>('GET', `/api/federation/requests?${new URLSearchParams({ ...(opts.direction ? { direction: opts.direction } : {}), ...(opts.peer ? { peer: opts.peer } : {}), ...(opts.open ? { open: '1' } : {}) })}`);
  peerRequest = (id: string) => this.call<FedRequest>('GET', `/api/federation/requests/${encodeURIComponent(id)}`);
  sendPeerRequest = (input: { peer: string; title: string; description: string; project?: string; blocking?: boolean; acceptance?: string[]; milestones?: string[]; budget?: RequestBudget }) => this.call<FedRequest>('POST', '/api/federation/requests', input, 60_000);
  approvePeerRequest = (id: string, note?: string) => this.call<FedRequest>('POST', `/api/federation/requests/${id}/approve`, { note }, GOAL_TIMEOUT_MS);
  declinePeerRequest = (id: string, reason: string) => this.call<FedRequest>('POST', `/api/federation/requests/${id}/decline`, { reason });
  askPeerInfo = (id: string, question: string) => this.call<FedRequest>('POST', `/api/federation/requests/${id}/info`, { question });
  cannotReproducePeerRequest = (id: string, note: string) => this.call<FedRequest>('POST', `/api/federation/requests/${id}/cannot-reproduce`, { note });
  landPeerRequest = (id: string, resolution: RequestResolution) => this.call<FedRequest>('POST', `/api/federation/requests/${id}/landed`, resolution);
  commentPeerRequest = (id: string, text: string) => this.call<FedRequest>('POST', `/api/federation/requests/${id}/comment`, { text }, 60_000);
  cancelPeerRequest = (id: string) => this.call<FedRequest>('POST', `/api/federation/requests/${id}/cancel`, undefined, 60_000);
  reopenPeerRequest = (id: string, reason: string) => this.call<FedRequest>('POST', `/api/federation/requests/${id}/reopen`, { reason }, 60_000);
  markPeerMilestone = (id: string, index: number, done = true) => this.call<FedRequest>('POST', `/api/federation/requests/${id}/milestone`, { index, done });
  setPeerRequestBudget = (id: string, budget: { maxUsd?: number; maxTokens?: number } | null) => this.call<FedRequest>('POST', `/api/federation/requests/${id}/budget`, budget ?? {});
  confirmPeerRequest = (id: string) => this.call<FedRequest>('POST', `/api/federation/requests/${id}/confirm`, undefined, 60_000);
}
