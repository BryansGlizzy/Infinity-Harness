// The daemon's REST API, one typed method per endpoint. Methods are arrow properties so they survive being passed around.
import type { Approval, Artifact, ArtifactKind, Board, Card, CardStatus, ChatItem, DaemonEvent, Dependency, Lease, Message, Outcome, RoutingRules, Session, Settings } from '@mh/core';
import { DaemonHttp } from './http.ts';
import type { ActiveSession, AgentPrior, Candidate, CardChanges, FolderInfo, MetricsReport, ModelCatalog, PoolHistoryData, PoolStatus, PoolWithStatus, RepoSetup, ReviewComment, SearchHit, UsageSummary } from './types.ts';

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
  forcePool = (id: string, pct: number | null) => this.call<PoolStatus>('POST', `/api/pools/${id}/force`, { pct });
  models = (refresh = false) => this.call<ModelCatalog>('GET', `/api/models${refresh ? '?refresh=1' : ''}`, undefined, refresh ? 120_000 : undefined);
  poolHistory = (poolId: string, hours = 24) => this.call<PoolHistoryData>('GET', `/api/pools/${poolId}/history?hours=${hours}`);

  // --- boards and cards
  boards = () => this.call<Board[]>('GET', '/api/boards');
  createBoard = (name: string, repoPath: string, setup?: RepoSetup, mode?: Board['mode']) => this.call<Board & { setup: string[] }>('POST', '/api/boards', { name, repoPath, setup, mode });
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
  installTool = (boardId: string, grant: string) => this.call<{ ok: boolean; output: string; installed: boolean }>('POST', `/api/boards/${boardId}/tools/${grant}/install`, undefined, INSTALL_TIMEOUT_MS);

  // --- settings
  settings = (boardId: string) => this.call<Settings>('GET', `/api/boards/${boardId}/settings`);
  updateSettings = (boardId: string, patch: Partial<Settings>) => this.call<Settings>('PATCH', `/api/boards/${boardId}/settings`, patch);
}
