// Shared types for the daemon, adapters and web UI.

export * from './federation.ts';

export const CARD_STATUSES = ['backlog', 'ready', 'in_progress', 'review', 'merging', 'done', 'blocked'] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

/**
 * worktree: each card in its own git worktree and branch, landed through the refinery (the default for a git repo).
 * direct: agents work in the folder itself, like the vendor IDE extensions; no branches, reviews or landing. The
 * default for a folder that isn't a git repository (master plan Phase 6.1).
 */
export type BoardMode = 'worktree' | 'direct';

/** What removing a board would touch, shown before the person chooses (`GET /api/boards/:id/removal`). */
export interface BoardRemovalInfo {
  board: Board;
  cards: number;
  /** Agent sessions working or waiting on its cards. */
  running: number;
  /** Cards in the merge queue right now. */
  merging: number;
  worktrees: number;
  /** Card worktrees with changes nobody committed. */
  dirtyWorktrees: number;
  folder: {
    exists: boolean;
    git: boolean;
    /** Changed files in the project folder itself; null when it is not a repository. */
    uncommitted: number | null;
    /** Branches of this board's cards holding work that has not landed on the default branch. */
    unlandedBranches: number | null;
  };
  federation: { sharing: boolean; openIn: number; openOut: number };
  /** Why "delete the folder too" is not offered for this board, or null. */
  deleteBlocked: string | null;
  /** Why the board cannot be removed at all right now, or null. */
  blocked: string | null;
}

export type BoardRemovalMode = 'forget' | 'delete';

export interface BoardRemovalResult {
  removed: true;
  mode: BoardRemovalMode;
  /** Card worktrees left on disk because they hold uncommitted changes. */
  keptWorktrees: string[];
  /** The project folder that was deleted (mode `delete`), else null. */
  deletedFolder: string | null;
  unlandedBranches: number | null;
}

export interface Board {
  id: string;
  name: string;
  /** The project folder: a git repository's top folder, or (direct mode) any folder. */
  repoPath: string;
  /** Empty for a direct board on a folder without git. */
  defaultBranch: string;
  mode: BoardMode;
  createdAt: string;
}

/**
 * What a card is for: the orchestrator plans the goal, a lead breaks a large chunk down further (both create child
 * cards and write no code), workers change code.
 */
export type CardRole = 'orchestrator' | 'lead' | 'worker';
export const CARD_ROLES: CardRole[] = ['orchestrator', 'lead', 'worker'];

export const WORK_TYPES = ['feature', 'bugfix', 'refactor', 'test', 'docs', 'research'] as const;
export type WorkType = (typeof WORK_TYPES)[number];

/** Kev's read of a card (master plan §5.4 step 2). Probabilities are kept so routing can use them. */
export interface Classification {
  workType: WorkType;
  workTypeProbs: Record<string, number>;
  /** Expected complexity on a 0–4 scale (trivial … very large). */
  complexity: number;
  complexityProbs: Record<string, number>;
  /** Probability that a mistake here needs a second agent's review. */
  needsReview: number;
  /** Probability that this is mainly web front-end work (UI, HTML/CSS, browser JavaScript); some models are better at it. */
  frontend?: number;
  /** `kev` when Kev answered, `fallback` when it was unreachable and defaults were used. */
  source: 'kev' | 'fallback';
  at: string;
}

/**
 * Routing rules on a card; children inherit them unless they set their own (master plan §5.4 step 3).
 * Entries name agents or pools: `agy` matches every agent on the agy pool, `agy-argon` only that agent.
 */
export interface RoutingRules {
  /** Only these agents/pools may take the card. */
  pools?: string[];
  /** Never these agents/pools. */
  avoid?: string[];
  /**
   * The card needs network access from its shell (package installs, downloads, tests that call a service). Agents whose
   * shell has none (Codex, master plan Phase 6.2) are skipped.
   */
  needsNetwork?: boolean;
}

/** Where a card is in review, landing and retries (master plan §5.4 steps 6–8, §5.6). */
export interface Pipeline {
  /** Failed runs handed to another agent (reassign-on-failure). */
  retries?: number;
  /** Landing failures (conflicts, failing tests): the 1st goes back to the author, the 2nd to another agent, then a human. */
  mergeAttempts?: number;
  /** Cross-provider review rounds so far. */
  reviewRounds?: number;
  /** Branch head the last approving (or final) review saw; a new head is reviewed again. */
  reviewedSha?: string;
  /** Review rounds that asked for changes (lowers the author's outcome score). */
  changesRequested?: number;
  /** Agents that failed this card or its landing; routing prefers others. */
  avoid?: string[];
  /** Escalated to a human: no more automatic retries. */
  escalated?: boolean;
  prUrl?: string;
  landedSha?: string;
  /** Set on a goal planned by a council of orchestrators (see Council). */
  council?: Council;
  /** The operator's verdict on the card's branch, from the web UI or VS Code (Phase 6.1); it stands in for the agent reviewer. */
  humanReview?: HumanReview;
  /** Set on a card run as several candidates at once (best-of-N, Phase 6.5). */
  bestOf?: BestOf;
  /** Requests to other swarms (ids of this daemon's outbound requests) the card waits for before it runs again (Phase 7). */
  waitingOn?: string[];
  /** Outbound requests that are confirmed done when this card is done: it was resumed to check what a peer landed. */
  confirms?: string[];
  /** On a finished goal: the card where the orchestrator wrote its final summary, and how many finished cards it covered. */
  finalSummary?: { cardId: string; cards: number; at: string };
  /** On a summary card: the goal it summarizes. */
  summaryOf?: string;
}

/** The operator reviews a card's branch: approve it for landing, or send it back to its author with notes. */
export interface HumanReview {
  verdict: 'approve' | 'changes';
  notes: string;
  /** Branch head the verdict was given on; a newer head needs a new verdict. */
  sha: string | null;
  at: string;
  by: string;
}

/**
 * Best-of-N (master plan §5.4 step 9): one card is worked by N agents in parallel, each on its own branch, and Kev picks
 * the winner. The candidates are sibling cards sharing a `group` (the original card's id).
 */
export interface BestOf {
  /** The original card's id; every candidate carries it. */
  group: string;
  /** 1-based candidate number; candidate 1 is the original card. */
  candidate: number;
  /** How many candidates the group was started with. */
  of: number;
  /** running: still racing · won: continues to review and landing · lost: discarded. */
  state: 'running' | 'won' | 'lost';
  /** Kev's 0–1 score of this candidate's diff, once judged. */
  score?: number;
}

/**
 * A goal planned by several orchestrators together (2+ enabled orchestrator agents). Each proposes a split into one
 * share per member; Kev picks the best proposal; each member plans its share under its own card; when everything has
 * landed, each member cross-checks another member's share, creating fix-up cards if needed.
 */
export interface Council {
  phase: 'proposing' | 'planning' | 'working' | 'verifying' | 'fixing' | 'done' | 'failed';
  members: { agentId: string; poolId: string; model: string; cardId: string }[];
  /** The member whose proposal Kev chose. */
  winner?: string;
  /** Kev's 0–1 score per member's proposal. */
  scores?: Record<string, number>;
  /** Verification rounds so far. */
  round?: number;
  /** When the current phase started (cards created after it count as fix-ups). */
  since: string;
  /** Per member, the last verification verdict. */
  verdicts?: Record<string, 'approve' | 'changes' | 'none'>;
}

/** One member's share in a council split. */
export interface CouncilShare {
  member: string;
  /** What the share covers: features, files, modules. */
  scope: string;
  /** The cards it expects to create. */
  cards: string[];
}

export interface Card {
  id: string;
  boardId: string;
  parentId: string | null;
  title: string;
  description: string;
  status: CardStatus;
  poolId: string | null;
  /** The agent profile that last ran the card (see AgentProfile). */
  agentId: string | null;
  branch: string | null;
  worktree: string | null;
  role: CardRole;
  /** Proposed by the orchestrator when it creates the card; Kev confirms or overrides it. */
  workType: WorkType | null;
  classification: Classification | null;
  routing: RoutingRules | null;
  /** Depth in the tree: 0 for a root card. */
  depth: number;
  /** Who created the card: `user:local`, or `card:<id>` for an agent. */
  createdBy: string;
  /** One-line live status written by the fast-lane narrator. */
  narration: string | null;
  pipeline: Pipeline;
  /** Tool grants (names from Settings.grants) this card's agent gets as extra MCP servers, e.g. `browser` (Phase 6.5). */
  grants: string[];
  createdAt: string;
  updatedAt: string;
}

/** "can't start until": `cardId` waits for `blockedBy` to reach Review or Done. */
export interface Dependency {
  cardId: string;
  blockedBy: string;
}

export type SessionState = 'starting' | 'running' | 'idle' | 'ended' | 'failed';

export interface Session {
  id: string;
  cardId: string;
  poolId: string;
  harness: string;
  model: string;
  vendorSessionId: string | null;
  state: SessionState;
  startedAt: string;
  endedAt: string | null;
}

export type HarnessId = 'opencode' | 'kimi' | 'agy' | 'claude' | 'codex';

export interface Pool {
  id: string;
  label: string;
  harness: HarnessId;
  /** Default model, used by agents that don't name one. */
  model: string;
  kind: 'api' | 'local' | 'subscription';
}

/** A model a harness offers, as discovered from it (ACP `session/new` config options, or Claude's aliases). */
export interface ModelOption {
  id: string;
  name: string;
}

/**
 * The reasoning (thinking / effort) setting a harness publishes: Claude's `--effort`, or an ACP session config option
 * such as Kimi's `thinking`, agy's `thinking_level` or OpenCode's `effort`.
 */
export interface ReasoningOptions {
  /** The harness's name for it (the ACP config option id, or `effort` for Claude). */
  configId: string;
  levels: ModelOption[];
  /** What the harness uses when none is set. */
  current?: string;
}

/**
 * An agent the board can hand cards to: a pool (quota, slots, harness) plus the model it runs and its place in the
 * delegation hierarchy (master plan Phase 3.5). Several agents may share a pool, e.g. Opus as orchestrator and
 * Sonnet as a lead, both on Claude Pro.
 */
export interface AgentProfile {
  /** Unique on the board; routing rules and delegation targets name it. */
  id: string;
  poolId: string;
  /** Harness model id; empty means the pool's default. */
  model: string;
  /** Reasoning / thinking level, one the harness publishes (see ReasoningOptions); empty means the harness default. */
  reasoning?: string;
  /** The kind of card it takes. */
  role: CardRole;
  /** Agents the child cards of an orchestrator or lead may go to; empty means any worker (and for the orchestrator, any lead). */
  delegatesTo: string[];
  enabled: boolean;
  /** Not saved in settings: added for a pool that has no worker or lead of its own. */
  implicit?: boolean;
}

/** True when a routing-rule entry names this agent or its pool. */
export function ruleMatches(entry: string, agent: Pick<AgentProfile, 'id' | 'poolId'>): boolean {
  return entry === agent.id || entry === agent.poolId;
}

/**
 * The board's agents on the pools that exist: the saved ones, plus a worker on its default model for every pool
 * that has no worker or lead saved (so a new pool, or a board from before agents existed, still gets work).
 */
export function effectiveAgents(settings: Pick<Settings, 'agents'>, pools: Pick<Pool, 'id'>[]): AgentProfile[] {
  const ids = new Set(pools.map((p) => p.id));
  const saved = settings.agents.filter((a) => ids.has(a.poolId));
  const covered = new Set(saved.filter((a) => a.role !== 'orchestrator').map((a) => a.poolId));
  const taken = new Set(saved.map((a) => a.id));
  const implicit = pools
    .filter((p) => !covered.has(p.id))
    .map((p) => ({ id: taken.has(p.id) ? `${p.id}-worker` : p.id, poolId: p.id, model: '', role: 'worker' as const, delegatesTo: [], enabled: true, implicit: true }));
  return [...saved, ...implicit];
}

/**
 * The agent profile a card runs as. An orchestrator card that ran on a fallback pool (or before agent ids existed)
 * acts as the first enabled orchestrator, so its delegation targets still apply.
 */
export function cardAgent(card: Pick<Card, 'agentId' | 'role'>, agents: AgentProfile[]): AgentProfile | undefined {
  const own = agents.find((a) => a.id === card.agentId && a.role === card.role);
  return own ?? (card.role === 'orchestrator' ? agents.find((a) => a.role === 'orchestrator' && a.enabled) : undefined);
}

/**
 * Agents the children of a card run by `caller` may go to: its `delegatesTo`, or with none set, every worker
 * (and, for the orchestrator, every lead too).
 */
export function delegationTargets(caller: AgentProfile | undefined, callerRole: CardRole, agents: AgentProfile[]): AgentProfile[] {
  const usable = agents.filter((a) => a.enabled && a.role !== 'orchestrator' && a.id !== caller?.id);
  if (caller?.delegatesTo.length) return usable.filter((a) => caller.delegatesTo.includes(a.id));
  return usable.filter((a) => a.role === 'worker' || (callerRole === 'orchestrator' && a.role === 'lead'));
}

/** Problems with an agent list, checked when settings are saved: ids, targets, and no delegation cycles. */
export function validateAgents(agents: AgentProfile[]): string | null {
  const byId = new Map<string, AgentProfile>();
  for (const a of agents) {
    if (!/^[a-z0-9][a-z0-9._-]{0,39}$/i.test(a.id)) return `agent id "${a.id}" must be 1–40 letters, digits, dots, dashes or underscores`;
    if (byId.has(a.id)) return `two agents are called "${a.id}"`;
    if (!CARD_ROLES.includes(a.role)) return `agent ${a.id}: unknown role ${a.role}`;
    byId.set(a.id, a);
  }
  for (const a of agents) {
    if (a.role === 'worker' && a.delegatesTo.length) return `agent ${a.id} is a worker; only orchestrators and leads delegate`;
    for (const t of a.delegatesTo) {
      const target = byId.get(t);
      if (!target) return `agent ${a.id} delegates to unknown agent "${t}"`;
      if (t === a.id) return `agent ${a.id} cannot delegate to itself`;
      if (target.role === 'orchestrator') return `agent ${a.id} cannot delegate to the orchestrator ${t}`;
    }
  }
  // Leads delegating to leads must form a tree, never loop back up the hierarchy.
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, path: string[]): string | null => {
    if (state.get(id) === 'done') return null;
    if (state.get(id) === 'visiting') return `delegation cycle: ${[...path, id].join(' → ')}`;
    state.set(id, 'visiting');
    for (const t of byId.get(id)?.delegatesTo ?? []) {
      const found = visit(t, [...path, id]);
      if (found) return found;
    }
    state.set(id, 'done');
    return null;
  };
  for (const a of agents) {
    const found = visit(a.id, []);
    if (found) return found;
  }
  return null;
}

/**
 * What routing priors and outcomes are kept for: each work type, plus `review` (reading another agent's branch).
 * Frontend work is a modifier on top (see Classification.frontend and Prior.frontend).
 */
export const SKILLS = [...WORK_TYPES, 'review'] as const;
export type Skill = (typeof SKILLS)[number];

/** A per-agent change to the built-in model priors, set in Settings (master plan Phase 5). */
export interface PriorOverride {
  /** Highest complexity (0–4) the agent handles well; beyond it expected success drops quickly. */
  capability?: number;
  /** Expected success (0–1) per skill. */
  skills?: Partial<Record<Skill, number>>;
  /** Expected success (0–1) on web front-end work. */
  frontend?: number;
}

/** A spending cap (Phase 6.3). Warn at 80% of `limit`, pause new work at 95%, like the pools' rate limits. */
export interface Budget {
  limit: number;
  /** Tokens (input + output) or US dollars (only where the harness reports a cost, e.g. Claude Code's telemetry). */
  unit: 'tokens' | 'usd';
  /** `total`: everything since the board began; `day` and `week` are rolling windows. */
  period: 'day' | 'week' | 'total';
}

export interface BudgetSettings {
  /** All agents on the board together; null for no cap. */
  board: Budget | null;
  /** Per agent id. */
  agents: Record<string, Budget>;
}

/**
 * An extra MCP server a card's agent can be granted (Phase 6.5), e.g. a browser for checking a UI. `mode` says who may
 * grant it: `auto` (an orchestrator or the agent asks, it is given), `approval` (a human approves first) or `off`.
 */
export interface ToolGrant {
  label: string;
  description: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Told to the agent in its prompt: how to learn the tool (e.g. a skills command). */
  usage?: string;
  /**
   * Shell command that installs `command`. It runs only when a human approves (or clicks Install), and only this
   * operator-set text is ever run: an agent's request names the grant, never the command.
   */
  install?: string;
  mode: 'auto' | 'approval' | 'off';
}

/**
 * Grants that ship with the daemon: Vercel's agent-browser (a headless browser) and agent-desktop (the desktop through
 * the OS accessibility tree). Both are CLIs with an MCP mode (`<cli> mcp`, stdio) that must be installed on the machine
 * (`npm install -g agent-browser && agent-browser install`; `npm install -g agent-desktop`).
 */
export const DEFAULT_GRANTS: Record<string, ToolGrant> = {
  browser: {
    label: 'Browser',
    description: 'Drive a headless browser (agent-browser): open pages, snapshot and click elements, fill forms, take screenshots. For checking UI flows and visual results.',
    command: 'agent-browser',
    args: ['mcp'],
    // One isolated session per card; screenshots and downloads stay out of the worktree; an idle browser exits after 5 minutes.
    env: {
      AGENT_BROWSER_SESSION: 'ih-{card}',
      AGENT_BROWSER_SCREENSHOT_DIR: '/tmp/ih-browser/{card}',
      AGENT_BROWSER_DOWNLOAD_PATH: '/tmp/ih-browser/{card}/downloads',
      AGENT_BROWSER_IDLE_TIMEOUT_MS: '300000',
    },
    usage: 'Before the first use, run `agent-browser skills get core` and follow it.',
    install: 'npm install -g --allow-scripts=agent-browser agent-browser && agent-browser install',
    mode: 'approval',
  },
  computer: {
    label: 'Desktop',
    description:
      'See and operate desktop apps through the OS accessibility tree (agent-desktop): snapshot an app, click, type, press keys, screenshot. It acts on the real desktop of the machine the daemon runs on. Off until you turn it on.',
    command: 'agent-desktop',
    args: ['mcp'],
    env: {},
    usage: 'Before the first use, read the skills `desktop` and `platform` (the desktop_skills_get tool, or `agent-desktop skills get desktop` and `agent-desktop skills get platform`) and follow them.',
    install: 'npm install -g --allow-scripts=agent-desktop agent-desktop',
    mode: 'off',
  },
};

/** The old browser grant (Playwright MCP): boards that saved settings before agent-browser replaced it. */
export const isLegacyPlaywrightGrant = (g: Pick<ToolGrant, 'args'> | undefined): boolean => !!g?.args.some((a) => a.includes('@playwright/mcp'));

/** An MCP server approved for every agent session on the board (`propose_mcp`, Phase 6.4). */
export interface BoardMcp {
  name: string;
  /** A local server (stdio) ... */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** ... or a remote one (Streamable HTTP). */
  url?: string;
}

/** A skill approved for the board (`propose_skill`): instructions every worker's prompt carries. */
export interface BoardSkill {
  name: string;
  description: string;
  body: string;
}

/** What each role may do through the board MCP (master plan §5.9). */
export interface RolePermissions {
  canCreateCards: boolean;
  canAddDependencies: boolean;
  /** `spawn_agent`: add an agent profile to the board. Waits for a human unless Settings.autoApproveSpawn. */
  canSpawnAgents?: boolean;
  /** `propose_mcp` / `propose_skill`: ask for an MCP server or skill. Always waits for a human. */
  canInstallMcp?: boolean;
  /** `request_grant`, and `grants` on `create_subtask`: ask for a tool grant (Phase 6.5). */
  canRequestGrants?: boolean;
  /** `request_peer`: ask another swarm for a fix, a piece of work or an answer (Phase 7). Waits for a human only if Settings.peerRequestApproval is on. */
  canRequestPeers?: boolean;
}

/** Board-wide settings, editable in the UI (master plan §2.6, §5.9). */
export interface Settings {
  /** Start ready cards automatically on the best pool. */
  autoRoute: boolean;
  /** Concurrent sessions per pool. */
  poolSlots: Record<string, number>;
  /** Multiplier per pool in the routing score; lower means "use only when others are busy". */
  scarcity: Record<string, number>;
  /**
   * Your own thumb on the scale, per agent id (default 1, range 0–10): the routing score is multiplied by it. Above 1
   * it favours the agent, but only for cards at or below the complexity it handles well; below 1 it is used less; 0
   * switches it off for automatic routing (a card can still be run on it by hand).
   */
  agentWeights: Record<string, number>;
  /** Claude Pro share (percent of the 5h window) kept for the orchestrator; workers stop at 100 − reserve. */
  claudeReservePct: number;
  /** Same for Codex: workers stop taking cards when its 5-hour usage passes 100 − this, keeping the rest for the orchestrator. */
  codexReservePct: number;
  /** Seconds a ready card may wait for its only eligible pool while that pool is halted before it is re-routed. */
  rerouteAfterSec: number;
  /**
   * Minutes a working turn may go without any agent activity before it counts as stalled (e.g. the harness is
   * silently retrying an overloaded upstream). The turn is cancelled, the pool locked briefly, and the card re-routed.
   */
  stallMinutes: number;
  /**
   * Agent profiles and the delegation hierarchy (master plan Phase 3.5). The first enabled orchestrator plans goals.
   * Pools with no worker or lead here get an implicit worker on their default model (see effectiveAgents).
   */
  agents: AgentProfile[];
  /** Tree guardrails. */
  maxDepth: number;
  maxChildren: number;
  maxCardsPerTurn: number;
  /**
   * Agents' tools may use the machine's toolchains, package caches and scratch space outside their worktree:
   * `/tmp`, every PATH directory and the known toolchain folders in the home (`~/.platformio`, `~/.cargo`, `~/.cache`, …).
   * Off: the worktree (and the repo's git dir) only.
   */
  shareToolchains: boolean;
  /** More folders agents' tools may use outside their worktree (absolute or `~/…`), e.g. an SDK in a custom place. */
  toolPaths: string[];
  /**
   * Direct boards only: worker cards running at once in the shared folder. Leases keep Claude, OpenCode and agy apart,
   * but Kimi and Codex edit inside the folder without asking, so more than one can step on each other.
   */
  directParallel: number;
  /** Per-role permission toggles (master plan §5.9). */
  permissions: Record<CardRole, RolePermissions>;
  /** Fast-lane jobs (master plan §5.11). */
  narrator: boolean;
  specLint: boolean;
  /** Refinery (master plan §5.6): land reviewed cards through the serial merge queue. */
  autoLand: boolean;
  /** `pr`: push, open a GitHub PR and squash-merge it; `local`: squash onto the local default branch; `auto`: pr when the repo has a GitHub remote and gh is installed. */
  landMode: 'auto' | 'local' | 'pr';
  /** Run in the card's worktree after it is brought up to date; empty skips tests. */
  testCommand: string;
  testTimeoutSec: number;
  /**
   * Run once in each new card worktree before its agent starts (and again when this text changes): install
   * dependencies, copy `.env`. Empty skips. Environment: IH_REPO_PATH, IH_WORKTREE, IH_BRANCH, IH_BOARD.
   */
  worktreeSetup: string;
  worktreeSetupTimeoutSec: number;
  /** Landing failures before a human is asked (1st back to the author, 2nd to another agent). */
  mergeAttempts: number;
  /** Failed runs reassigned to another agent, with a handoff, before a human is asked. */
  maxRetries: number;
  /** Cross-provider review before landing, for cards whose Kev needs-review score reaches the threshold. */
  crossReview: boolean;
  reviewThreshold: number;
  maxReviewRounds: number;
  /** Council verification rounds (each may add fix-up cards) before the goal is closed anyway. */
  councilVerifyRounds: number;
  /** Per-agent changes to the built-in model priors (keyed by agent id). */
  priorOverrides: Record<string, PriorOverride>;
  /** Blend recorded outcomes into routing (master plan §5.4 step 7). Off: priors only. */
  learnFromOutcomes: boolean;
  /** Ask Kev to score landed work against its acceptance criteria. */
  kevOutcomeScoring: boolean;
  /** Fast-lane jobs (master plan §5.11): query rewrite (#3), artifact tagging (#4), ask_agent quick answers (#2). */
  queryRewrite: boolean;
  artifactTagging: boolean;
  quickAnswers: boolean;
  /** Fast-lane job #8: short notification text for approvals and escalations (Phase 6.4). */
  notificationText: boolean;
  /** Spending caps per board and per agent (Phase 6.3). */
  budgets: BudgetSettings;
  /**
   * Hold cards in Review until the operator approves or requests changes (from the web UI or VS Code) instead of
   * sending them to an agent reviewer (Phase 6.1). A verdict given while this is off still counts.
   */
  humanReview: boolean;
  /** When a goal's cards are all done, the orchestrator writes a final summary: what was done, how to verify it, open issues, reference documentation. */
  finalSummary: boolean;
  /** An agent's request to another swarm waits for a human to approve it before it is sent. Off (default): it is sent at once. */
  peerRequestApproval: boolean;
  /** Best-of-N (master plan §5.4 step 9): run big cards on several agents at once and keep the best. Off by default. */
  bestOfN: { enabled: boolean; n: number; minComplexity: number };
  /** Tool grants cards can be given (Phase 6.5), by name. */
  grants: Record<string, ToolGrant>;
  /** `spawn_agent` requests are applied without waiting for a human. */
  autoApproveSpawn: boolean;
  /** MCP servers approved for the board (Phase 6.4); every new agent session gets them. */
  mcpServers: BoardMcp[];
  /** Skills approved for the board; workers' prompts carry them. */
  skills: BoardSkill[];
}

export const DEFAULT_SETTINGS: Settings = {
  autoRoute: true,
  poolSlots: { claude: 1, codex: 2, kimi: 2, agy: 2, nim: 3, local: 2 },
  scarcity: { claude: 0.15, codex: 1, kimi: 1, agy: 1, nim: 0.8, local: 0.5 },
  claudeReservePct: 30,
  codexReservePct: 30,
  rerouteAfterSec: 60,
  stallMinutes: 5,
  agents: [{ id: 'orchestrator', poolId: 'claude', model: 'opus', role: 'orchestrator', delegatesTo: [], enabled: true }],
  maxDepth: 5,
  maxChildren: 12,
  maxCardsPerTurn: 20,
  shareToolchains: true,
  toolPaths: [],
  directParallel: 3,
  permissions: {
    orchestrator: { canCreateCards: true, canAddDependencies: true, canSpawnAgents: false, canInstallMcp: false, canRequestGrants: true, canRequestPeers: true },
    lead: { canCreateCards: true, canAddDependencies: true, canSpawnAgents: false, canInstallMcp: false, canRequestGrants: true, canRequestPeers: true },
    worker: { canCreateCards: false, canAddDependencies: false, canSpawnAgents: false, canInstallMcp: false, canRequestGrants: true, canRequestPeers: true },
  },
  narrator: true,
  specLint: true,
  autoLand: true,
  landMode: 'auto',
  testCommand: '',
  testTimeoutSec: 600,
  worktreeSetup: '',
  worktreeSetupTimeoutSec: 900,
  mergeAttempts: 3,
  maxRetries: 1,
  crossReview: true,
  reviewThreshold: 0.6,
  maxReviewRounds: 2,
  councilVerifyRounds: 2,
  priorOverrides: {},
  agentWeights: {},
  learnFromOutcomes: true,
  kevOutcomeScoring: true,
  queryRewrite: true,
  artifactTagging: true,
  quickAnswers: true,
  notificationText: true,
  budgets: { board: null, agents: {} },
  humanReview: false,
  finalSummary: true,
  peerRequestApproval: false,
  bestOfN: { enabled: false, n: 2, minComplexity: 2 },
  grants: DEFAULT_GRANTS,
  autoApproveSpawn: false,
  mcpServers: [],
  skills: [],
};

// --- context (master plan §5.7)

/**
 * spec: a card's task; decision: a choice others should follow; contract: an interface between cards; handoff: the
 * state of a card for its next agent; finding: something learned; summary: what a turn did; note: anything else. proposal: a council member's plan for splitting a goal.
 */
export const ARTIFACT_KINDS = ['spec', 'decision', 'contract', 'handoff', 'finding', 'summary', 'note', 'proposal'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface Artifact {
  id: string;
  boardId: string;
  /** The card it belongs to; null for board-wide notes. */
  cardId: string | null;
  kind: ArtifactKind;
  title: string;
  body: string;
  /** Written by the fast lane (job #4) after it is saved. */
  tags: string[];
  summary: string | null;
  /** `card:<id>`, `agent:<agentId>`, `user:<name>` or `daemon`. */
  author: string;
  /** Branch head when it was written, so readers can tell it may be stale. */
  commitSha: string | null;
  /** The newer artifact that replaced this one. */
  supersededBy: string | null;
  version: number;
  createdAt: string;
}

/** A structured handoff note (handoff-mcp style), required whenever a card moves to another agent. */
export interface Handoff {
  /** Where the work stands. */
  state: string;
  decisions: string[];
  blockers: string[];
  /** Files that matter, repo-relative. */
  files: string[];
  nextSteps: string[];
}

export function renderHandoff(h: Handoff): string {
  const list = (title: string, items: string[]) => (items.length ? `\n\n## ${title}\n${items.map((i) => `- ${i}`).join('\n')}` : '');
  return `## State\n${h.state.trim()}${list('Decisions', h.decisions)}${list('Blockers', h.blockers)}${list('Files', h.files)}${list('Next steps', h.nextSteps)}`;
}

/** How a card's run ended for the agent that did it (master plan §5.4 step 7). */
export type OutcomeResult = 'landed' | 'failed_run' | 'failed_landing' | 'escalated' | 'blocked';

/**
 * A human's weighting of an outcome the daemon can't judge on its own (an agent reporting itself blocked may be right).
 * pending: routing ignores it until weighed. pass: the block was justified (counts as success). fail: it counts as a
 * failure. ignore: it doesn't count either way.
 */
export type OutcomeReview = 'pending' | 'pass' | 'fail' | 'ignore';
export const OUTCOME_REVIEW_VALUE = { pass: 1, fail: 0 } as const;

export interface Outcome {
  id: number;
  cardId: string;
  boardId: string;
  agentId: string;
  poolId: string;
  model: string;
  workType: WorkType;
  complexity: number;
  result: OutcomeResult;
  /** Kev's 0–1 score of the landed work against the acceptance criteria; null without Kev. */
  quality: number | null;
  /** Kev's probability that the change stayed within the card's scope. */
  inScope: number | null;
  testsPassed: boolean | null;
  changesRequested: number;
  /** What routing learns from: 0 (failed) … 1 (landed, fully meets the criteria). */
  value: number;
  /** Set for outcomes a human weighs (blocks); null for outcomes the daemon scored itself. */
  review: OutcomeReview | null;
  /** Why: the agent's block reason, for the human weighing it. */
  note: string | null;
  createdAt: string;
}

/** The learning signal for an outcome: landed work counts by Kev's score, scope and requested changes; failures low. */
export function outcomeValue(o: Pick<Outcome, 'result' | 'quality' | 'inScope' | 'changesRequested'> & { kind?: 'conflict' | 'tests' }): number {
  if (o.result === 'landed') {
    const quality = o.quality ?? 0.85;
    const scope = o.inScope !== null && o.inScope < 0.5 ? 0.7 : 1;
    return Math.round(quality * scope * 0.9 ** o.changesRequested * 1000) / 1000;
  }
  if (o.result === 'failed_landing') return o.kind === 'conflict' ? 0.4 : 0.2;
  return 0;
}

export interface Lease {
  id: string;
  boardId: string;
  cardId: string;
  /** Repo-relative path or glob, e.g. `src/auth/**`. */
  glob: string;
  createdAt: string;
  expiresAt: string;
  releasedAt: string | null;
}

export interface Message {
  id: string;
  boardId: string;
  /** `card:<id>` for agents, `user:<name>` for humans. */
  fromActor: string;
  /** Recipient card; null means the humans watching the board. */
  toCard: string | null;
  body: string;
  urgent: boolean;
  createdAt: string;
  deliveredAt: string | null;
  /** When a human cleared it from "Messages for you"; it stays in the card's own activity. */
  dismissedAt: string | null;
}

/** Normalized event emitted by every harness adapter. */
export type HarnessEvent =
  | { type: 'message'; role: 'agent' | 'user'; text: string }
  | { type: 'thought'; text: string }
  | { type: 'tool_call'; id: string; title: string; kind: string; status: string; locations: string[] }
  | { type: 'tool_update'; id: string; status: string; title?: string; locations?: string[] }
  /** What a tool call printed (a command's output, a file write's result). Several can arrive for one call; they are appended. */
  | { type: 'tool_output'; id: string; text: string; exitCode?: number }
  /** Something the harness did on its own that the person should see, e.g. retrying after a provider error. */
  | { type: 'notice'; text: string }
  | { type: 'plan'; entries: { content: string; status: string }[] }
  | { type: 'permission'; title: string; decision: 'allowed' | 'rejected'; reason: string }
  | { type: 'turn_end'; stopReason: string }
  | { type: 'error'; message: string };

// --- approvals (master plan Phase 6.4)

/**
 * escalation: an agent needs a human (`escalate_to_human`) · spawn_agent: an agent asks for a new agent profile ·
 * install_mcp / install_skill: an agent proposes an MCP server or skill for the board · grant: a card asks for a tool
 * grant (a browser, say) · install_tool: a granted tool's command isn't on this machine; approving runs the grant's install command.
 */
export type ApprovalKind = 'escalation' | 'spawn_agent' | 'install_mcp' | 'install_skill' | 'grant' | 'install_tool' | 'peer_request';
export type ApprovalStatus = 'pending' | 'approved' | 'denied';

export interface Approval {
  id: string;
  boardId: string;
  /** The card that asked. */
  cardId: string | null;
  kind: ApprovalKind;
  /** One line a human reads (the fast lane words it when it can). */
  summary: string;
  /** What approving applies: the agent profile, the MCP server, the skill, the grant name, or the escalation's reason. */
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  requestedBy: string;
  decidedBy: string | null;
  /** The human's answer: guidance for an escalation, or why a request was denied. */
  note: string | null;
  createdAt: string;
  decidedAt: string | null;
}

/** One entry of a goal's conversation (`GET /api/cards/:id/chat`), see the daemon's chat.ts. */
export interface ChatItem {
  /** Event sequence number; the cursor for polling. */
  seq: number;
  ts: string;
  /** you: the human · agent: an agent's message · ask: a card's question to the human · note: the board's own message · status: a card changed state. */
  kind: 'you' | 'agent' | 'ask' | 'note' | 'status';
  cardId: string;
  cardTitle: string;
  text: string;
  /** For `ask`: a human has replied to that card since. */
  answered?: boolean;
  messageId?: string;
}

/** Everything that happens is appended to the event log; the UI and projections read it. */
export interface DaemonEvent {
  seq: number;
  ts: string;
  actor: string;
  type: EventType;
  subject: string;
  payload: unknown;
}

export type EventType =
  | 'board.created'
  | 'card.created'
  | 'card.updated'
  | 'card.routed'
  | 'card.narrated'
  | 'card.refinery'
  | 'card.setup'
  | 'session.interrupted'
  | 'card.outcome'
  | 'card.council'
  | 'outcome.reviewed'
  | 'approval.created'
  | 'approval.decided'
  | 'artifact.saved'
  | 'dependency.added'
  | 'settings.updated'
  | 'session.started'
  | 'session.event'
  | 'session.ended'
  | 'message.posted'
  | 'message.delivered'
  | 'message.dismissed'
  | 'pool.ejected'
  | 'pool.restored'
  | 'lease.acquired'
  | 'lease.released'
  | 'peer.updated'
  | 'request.updated'
  | 'project.updated'
  | 'board.removed';

/** Ephemeral push to UI clients; not stored in the event log. */
export interface LiveMessage {
  live: true;
  type: 'pool.status' | 'leases.changed' | 'budget.status' | 'stream.status';
  subject: string;
  payload: unknown;
  ts: string;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function slugify(text: string, max = 40): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/g, '') || 'card'
  );
}
