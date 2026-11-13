// Shapes of the daemon's REST responses, shared by every client (web UI, VS Code, CLI, TUI).
import type { Artifact, Board, Lease, ModelOption, Pool, ReasoningOptions, Skill } from '@ih/core';

export interface WindowUsage {
  window: string;
  limit: number;
  used: number;
  pct: number;
  resetsAt?: number;
}
export interface PoolStatus {
  poolId: string;
  state: 'open' | 'warn' | 'halted' | 'locked';
  windows: WindowUsage[];
  lockedUntil: number | null;
  queued: number;
}
/** Whether a pool's model is answering (`/api/pools`, `/api/pools/:id/test`). */
export interface PoolHealthView {
  reachable: 'online' | 'offline' | 'unknown';
  checked: 'endpoint' | 'harness';
  latencyMs: number | null;
  checkedAt: string | null;
  detail: string | null;
  /** Taken out of rotation after its endpoint stopped answering; stays out until a person puts it back. */
  ejected: { since: string; reason: string } | null;
}
export type PoolWithStatus = Pool & { status: PoolStatus; running: number; health?: PoolHealthView };

/** An open agent session on some pool and board (`/api/sessions/active`). */
export interface ActiveSession {
  cardId: string;
  boardId: string;
  boardName: string;
  poolId: string;
  agentId: string | null;
  model: string;
  reasoning: string;
  state: 'working' | 'idle';
  kind: 'card' | 'review';
}

/** Models each pool's harness offers, by pool id; `error` when probing it failed (the default model is still listed). */
export type ModelCatalog = Record<string, { models: ModelOption[]; reasoning?: ReasoningOptions | null; error?: string }>;

/** One agent's routing verdict for a card (scheduler `card.routed` events and `/route`). */
export interface Candidate {
  agentId: string;
  poolId: string;
  model: string;
  eligible: boolean;
  score: number;
  reasons: string[];
}

/** A folder as the New board browser sees it (`/api/fs`). */
export interface FolderInfo {
  path: string;
  parent: string | null;
  exists: boolean;
  notDirectory?: boolean;
  dirs: { name: string; git: boolean }[];
  itemCount: number;
  git: null | { root: string; branch: string; commits: number; origin: string | null; github: boolean; dirty: boolean; inside: boolean };
  home: string;
  gh: boolean;
}

/** Turning a folder into a repository when a board is created. */
export interface RepoSetup {
  create?: boolean;
  branch?: string;
  gitignore?: 'none' | 'general' | 'python' | 'node';
  github?: 'none' | 'private' | 'public';
}

/** What a card's work changed (`/api/cards/:id/changes`). */
export interface CardChanges {
  /** Direct board: the files the agent's edit tools touched, current contents only (no history). */
  direct?: boolean;
  landed: boolean;
  base: string;
  branch: string | null;
  from: string | null;
  to: string | null;
  files: { path: string; status: string; additions: number | null; deletions: number | null; from?: string }[];
  commits: { sha: string; subject: string; date: string }[];
}

/** A context search result (master plan §5.7). */
export interface SearchHit {
  artifact: Artifact;
  score: number;
  via: ('text' | 'vector')[];
  similarity?: number;
}

/** An agent's effective routing prior and its recorded outcomes per work type (`/api/boards/:id/priors`). */
export interface AgentPrior {
  agentId: string;
  poolId: string;
  model: string;
  role: string;
  prior: { family: string; capability: number; skills: Record<Skill, number>; frontend: number; noWeb: boolean };
  observed: Record<string, { n: number; mean: number }>;
}

/** What agents (and a board) have used (`/api/boards/:id/metrics`, Phase 6.3). */
export interface UsageSum {
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  costUsd: number;
  requests: number;
}
export interface BudgetStatus {
  /** `board`, or an agent id. */
  scope: string;
  budget: { limit: number; unit: 'tokens' | 'usd'; period: 'day' | 'week' | 'total' };
  used: number;
  pct: number;
  state: 'open' | 'warn' | 'halted' | 'locked';
}
export interface MetricsReport {
  since: string;
  hours: number;
  totals: UsageSum;
  byAgent: ({ agentId: string; poolId: string } & UsageSum)[];
  byModel: ({ model: string; poolId: string } & UsageSum)[];
  byPool: ({ poolId: string } & UsageSum)[];
  cards: { id: string; title: string; parentId: string | null; role: string; status: string; agentId: string | null; own: UsageSum; subtree: UsageSum }[];
  series: { bucket: string; tokens: number; costUsd: number }[];
  unattributed: UsageSum;
  budgets: BudgetStatus[];
}
/** A pool's recent past (`/api/pools/:id/history`). */
export interface PoolHistoryData {
  poolId: string;
  hours: number;
  samples: { ts: string; state: string; topPct: number; running: number; windows: { window: string; pct: number }[] }[];
  usage: { bucket: string; requests: number; inputTokens: number; outputTokens: number; errors: number }[];
  outages: { from: string; to: string; state: string }[];
}

/** The headline numbers of `/api/boards/:id/metrics` (tokens and cost over a window, and the budgets). */
export interface UsageSummary {
  hours: number;
  totals: { tokens: number; costUsd: number; requests: number };
  budgets: { scope: string; pct: number; state: 'open' | 'warn' | 'halted' | 'locked' }[];
}

/** The part of a pool the status bar and the TUI show. `PoolWithStatus` is assignable to it. */
export interface PoolSummary {
  id: string;
  label: string;
  running: number;
  status: { state: 'open' | 'warn' | 'halted' | 'locked'; windows: { window: string; pct: number }[] };
  /** Is the model answering; a pool out of rotation has `ejected` set. */
  health?: { reachable: 'online' | 'offline' | 'unknown'; latencyMs: number | null; ejected: { since: string; reason: string } | null };
}

/** A comment on a line of a card's diff. */
export interface ReviewComment {
  path: string;
  line?: number;
  endLine?: number;
  body: string;
}

// --- swarm federation (Phase 7)
import type { FederationNeeds, FederationState, FedRequest, Peer, PeerProject, ProjectCard, SharedProject, Visibility } from '@ih/core';

export interface FederationOverview extends FederationState {
  peers: Peer[];
  shared: SharedProject[];
  needs: FederationNeeds;
}
export interface PeerDetail {
  peer: Peer;
  projects: PeerProject[];
  requests: FedRequest[];
}
export interface PeerPreview {
  allowed: Visibility;
  name: string;
  projects: ProjectCard[];
}
export interface PeerHit {
  peer: Peer;
  card: ProjectCard;
  score: number;
}

// --- system harnesses & agent installation / sign-in
export type SystemHarnessId = 'claude' | 'codex' | 'kimi' | 'agy' | 'opencode' | 'gh';
export type HarnessAuthStatus = 'signed_in' | 'signed_out' | 'configured' | 'unconfigured' | 'unknown';

export interface HarnessLoginFlow {
  active: boolean;
  url: string | null;
  code: string | null;
  output: string;
  error: string | null;
  startedAt: string;
}

export interface SystemHarnessStatus {
  id: SystemHarnessId;
  label: string;
  description: string;
  poolIds: string[];
  installed: boolean;
  binaryPath: string | null;
  missingParts: string[];
  version: string | null;
  auth: {
    status: HarnessAuthStatus;
    detail: string | null;
    account: string | null;
  };
  installCommand: string;
  loginCommand: string | null;
  supportsApiKeyLogin?: boolean;
  loginFlow: HarnessLoginFlow | null;
  envConfig?: {
    nimApiKeySet: boolean;
    nimModel: string;
    localBaseUrl: string;
    localModel: string;
  };
}

