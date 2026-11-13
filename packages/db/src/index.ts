import { FEDERATION_MIGRATION, FEDERATION_MIGRATION_2, FedStore } from './federation.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DEFAULT_GRANTS,
  DEFAULT_SETTINGS,
  isLegacyPlaywrightGrant,
  type Artifact,
  type ArtifactKind,
  type Outcome,
  type OutcomeResult,
  type OutcomeReview,
  OUTCOME_REVIEW_VALUE,
  newId,
  type Approval,
  type ApprovalKind,
  type ApprovalStatus,
  type Board,
  type Card,
  type CardRole,
  type CardStatus,
  type Classification,
  type DaemonEvent,
  type Dependency,
  type RoutingRules,
  type Pipeline,
  type Settings,
  type WorkType,
  type EventType,
  type Lease,
  type BoardMode,
  type Message,
  type Session,
  type SessionState,
} from '@ih/core';

// Each entry runs once, in order; the index is the schema version.
const MIGRATIONS = [
  `
  CREATE TABLE boards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    default_branch TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE nodes (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES boards(id),
    parent_id TEXT REFERENCES nodes(id),
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    pool_id TEXT,
    branch TEXT,
    worktree TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX nodes_board ON nodes(board_id);
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES nodes(id),
    pool_id TEXT NOT NULL,
    harness TEXT NOT NULL,
    model TEXT NOT NULL,
    vendor_session_id TEXT,
    state TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE INDEX sessions_card ON sessions(card_id);
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    actor TEXT NOT NULL,
    type TEXT NOT NULL,
    subject TEXT NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE INDEX events_subject ON events(subject, seq);
  `,
  `
  CREATE TABLE usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    pool_id TEXT NOT NULL,
    session_id TEXT,
    source TEXT NOT NULL,
    status INTEGER,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER
  );
  CREATE INDEX usage_pool_ts ON usage_events(pool_id, ts);
  `,
  `
  CREATE TABLE leases (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES boards(id),
    card_id TEXT NOT NULL REFERENCES nodes(id),
    glob TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    released_at TEXT
  );
  CREATE INDEX leases_board_active ON leases(board_id, released_at);
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES boards(id),
    from_actor TEXT NOT NULL,
    to_card TEXT,
    body TEXT NOT NULL,
    urgent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    delivered_at TEXT
  );
  CREATE INDEX messages_to ON messages(to_card, delivered_at);
  `,
  `
  ALTER TABLE nodes ADD COLUMN role TEXT NOT NULL DEFAULT 'worker';
  ALTER TABLE nodes ADD COLUMN work_type TEXT;
  ALTER TABLE nodes ADD COLUMN kev_json TEXT;
  ALTER TABLE nodes ADD COLUMN routing_rules_json TEXT;
  ALTER TABLE nodes ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE nodes ADD COLUMN created_by TEXT NOT NULL DEFAULT 'user:local';
  ALTER TABLE nodes ADD COLUMN narration TEXT;
  CREATE INDEX nodes_parent ON nodes(parent_id);
  CREATE TABLE edges (
    from_node TEXT NOT NULL REFERENCES nodes(id),
    to_node TEXT NOT NULL REFERENCES nodes(id),
    kind TEXT NOT NULL DEFAULT 'blocked_by',
    PRIMARY KEY (from_node, to_node, kind)
  );
  CREATE TABLE settings (
    board_id TEXT PRIMARY KEY,
    settings_json TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE nodes ADD COLUMN agent_id TEXT;
  `,
  `
  ALTER TABLE nodes ADD COLUMN pipeline_json TEXT;
  `,
  `
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES boards(id),
    card_id TEXT REFERENCES nodes(id),
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    tags_json TEXT NOT NULL DEFAULT '[]',
    summary TEXT,
    author TEXT NOT NULL,
    commit_sha TEXT,
    superseded_by TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    embedding BLOB,
    embed_model TEXT
  );
  CREATE INDEX artifacts_board ON artifacts(board_id, superseded_by);
  CREATE INDEX artifacts_card ON artifacts(card_id);
  CREATE VIRTUAL TABLE artifacts_fts USING fts5(artifact_id UNINDEXED, title, body, tags, summary, tokenize = 'porter unicode61');
  CREATE TABLE outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id TEXT NOT NULL REFERENCES nodes(id),
    board_id TEXT NOT NULL REFERENCES boards(id),
    agent_id TEXT NOT NULL,
    pool_id TEXT NOT NULL,
    model TEXT NOT NULL,
    work_type TEXT NOT NULL,
    complexity REAL NOT NULL,
    result TEXT NOT NULL,
    quality REAL,
    in_scope REAL,
    tests_passed INTEGER,
    changes_requested INTEGER NOT NULL DEFAULT 0,
    value REAL NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX outcomes_model ON outcomes(pool_id, model, work_type);
  `,
  `
  ALTER TABLE outcomes ADD COLUMN review TEXT;
  ALTER TABLE outcomes ADD COLUMN note TEXT;
  `,
  `
  ALTER TABLE boards ADD COLUMN mode TEXT NOT NULL DEFAULT 'worktree';
  `,
  // Phase 6: attributed usage (metrics and budgets), the approval queue, tool grants, pool usage history.
  `
  ALTER TABLE usage_events ADD COLUMN board_id TEXT;
  ALTER TABLE usage_events ADD COLUMN card_id TEXT;
  ALTER TABLE usage_events ADD COLUMN agent_id TEXT;
  ALTER TABLE usage_events ADD COLUMN model TEXT;
  ALTER TABLE usage_events ADD COLUMN cache_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE usage_events ADD COLUMN cost_usd REAL;
  CREATE INDEX usage_board_ts ON usage_events(board_id, ts);
  CREATE INDEX usage_card ON usage_events(card_id);
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES boards(id),
    card_id TEXT,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    decided_by TEXT,
    note TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE INDEX approvals_board ON approvals(board_id, status);
  ALTER TABLE nodes ADD COLUMN grants_json TEXT;
  CREATE TABLE pool_samples (
    ts TEXT NOT NULL,
    pool_id TEXT NOT NULL,
    state TEXT NOT NULL,
    top_pct REAL NOT NULL,
    windows_json TEXT NOT NULL,
    running INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX pool_samples_pool ON pool_samples(pool_id, ts);
  `,
  FEDERATION_MIGRATION,
  FEDERATION_MIGRATION_2,
  // Agents' requests to other swarms used to wait for a person by default; they now go straight out. Boards that saved
  // the old default (nobody had chosen it) follow the new one.
  `UPDATE settings SET settings_json = json_set(settings_json, '$.peerRequestApproval', json('false')) WHERE json_extract(settings_json, '$.peerRequestApproval') = 1;`,
  // "Messages for you" can be cleared; a cleared message stays in the log, it just stops asking for attention.
  `ALTER TABLE messages ADD COLUMN dismissed_at TEXT;`,
  // A pool whose endpoint stopped answering is taken out of rotation until a person puts it back.
  `CREATE TABLE pool_ejections (pool_id TEXT PRIMARY KEY, since TEXT NOT NULL, reason TEXT NOT NULL);`,
];

type Row = Record<string, string | number | null>;

const str = (v: unknown) => (v == null ? null : String(v));
const json = <T>(v: unknown): T | null => (v == null ? null : (JSON.parse(String(v)) as T));

/** Settings saved before agent profiles had `orchestrator: { poolId, model }`; it becomes the orchestrator agent. */
type LegacySettings = Partial<Settings> & { orchestrator?: { poolId?: string; model?: string } };

/** Settings merged over the defaults, so settings saved by an older version gain new keys. `agents` is replaced whole. */
export function mergeSettings(base: Settings, patch: LegacySettings): Settings {
  const { orchestrator: legacy, ...rest } = patch;
  // A browser grant saved while it still ran Playwright MCP becomes agent-browser, keeping the operator's mode.
  if (rest.grants && isLegacyPlaywrightGrant(rest.grants.browser)) {
    rest.grants = { ...rest.grants, browser: { ...DEFAULT_GRANTS.browser!, mode: rest.grants.browser!.mode } };
  }
  let agents = patch.agents ?? base.agents;
  if (legacy && !patch.agents) {
    agents = agents.map((a) =>
      a.role === 'orchestrator' && a.id === 'orchestrator' ? { ...a, poolId: legacy.poolId ?? a.poolId, model: legacy.model ?? a.model } : a,
    );
  }
  return {
    ...base,
    ...rest,
    agents: agents.map((a) => ({
      id: a.id,
      poolId: a.poolId,
      model: a.model ?? '',
      ...(a.reasoning ? { reasoning: a.reasoning } : {}),
      role: a.role,
      delegatesTo: a.delegatesTo ?? [],
      enabled: a.enabled !== false,
    })),
    poolSlots: { ...base.poolSlots, ...patch.poolSlots },
    scarcity: { ...base.scarcity, ...patch.scarcity },
    permissions: {
      orchestrator: { ...base.permissions.orchestrator, ...patch.permissions?.orchestrator },
      lead: { ...base.permissions.lead, ...patch.permissions?.lead },
      worker: { ...base.permissions.worker, ...patch.permissions?.worker },
    },
  };
}

function toBoard(r: Row): Board {
  return {
    id: String(r.id),
    name: String(r.name),
    repoPath: String(r.repo_path),
    defaultBranch: String(r.default_branch),
    mode: r.mode === 'direct' ? 'direct' : 'worktree',
    createdAt: String(r.created_at),
  };
}

function toCard(r: Row): Card {
  return {
    id: String(r.id),
    boardId: String(r.board_id),
    parentId: str(r.parent_id),
    title: String(r.title),
    description: String(r.description),
    status: r.status as CardStatus,
    poolId: str(r.pool_id),
    agentId: str(r.agent_id),
    branch: str(r.branch),
    worktree: str(r.worktree),
    role: (r.role ?? 'worker') as CardRole,
    workType: str(r.work_type) as WorkType | null,
    classification: json<Classification>(r.kev_json),
    routing: json<RoutingRules>(r.routing_rules_json),
    depth: Number(r.depth ?? 0),
    createdBy: String(r.created_by ?? 'user:local'),
    narration: str(r.narration),
    pipeline: json<Pipeline>(r.pipeline_json) ?? {},
    grants: json<string[]>(r.grants_json) ?? [],
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function toApproval(r: Row): Approval {
  return {
    id: String(r.id),
    boardId: String(r.board_id),
    cardId: str(r.card_id),
    kind: r.kind as ApprovalKind,
    summary: String(r.summary),
    payload: json<Record<string, unknown>>(r.payload_json) ?? {},
    status: r.status as ApprovalStatus,
    requestedBy: String(r.requested_by),
    decidedBy: str(r.decided_by),
    note: str(r.note),
    createdAt: String(r.created_at),
    decidedAt: str(r.decided_at),
  };
}

function toSession(r: Row): Session {
  return {
    id: String(r.id),
    cardId: String(r.card_id),
    poolId: String(r.pool_id),
    harness: String(r.harness),
    model: String(r.model),
    vendorSessionId: str(r.vendor_session_id),
    state: r.state as SessionState,
    startedAt: String(r.started_at),
    endedAt: str(r.ended_at),
  };
}

function toLease(r: Row): Lease {
  return {
    id: String(r.id),
    boardId: String(r.board_id),
    cardId: String(r.card_id),
    glob: String(r.glob),
    createdAt: String(r.created_at),
    expiresAt: String(r.expires_at),
    releasedAt: str(r.released_at),
  };
}

function toMessage(r: Row): Message {
  return {
    id: String(r.id),
    boardId: String(r.board_id),
    fromActor: String(r.from_actor),
    toCard: str(r.to_card),
    body: String(r.body),
    urgent: Number(r.urgent) === 1,
    createdAt: String(r.created_at),
    deliveredAt: str(r.delivered_at),
    dismissedAt: str(r.dismissed_at),
  };
}

function toEvent(r: Row): DaemonEvent {
  return {
    seq: Number(r.seq),
    ts: String(r.ts),
    actor: String(r.actor),
    type: r.type as EventType,
    subject: String(r.subject),
    payload: JSON.parse(String(r.payload)),
  };
}

function toArtifact(r: Row): Artifact {
  return {
    id: String(r.id),
    boardId: String(r.board_id),
    cardId: str(r.card_id),
    kind: r.kind as ArtifactKind,
    title: String(r.title),
    body: String(r.body),
    tags: json<string[]>(r.tags_json) ?? [],
    summary: str(r.summary),
    author: String(r.author),
    commitSha: str(r.commit_sha),
    supersededBy: str(r.superseded_by),
    version: Number(r.version),
    createdAt: String(r.created_at),
  };
}

function toOutcome(r: Row): Outcome {
  return {
    id: Number(r.id),
    cardId: String(r.card_id),
    boardId: String(r.board_id),
    agentId: String(r.agent_id),
    poolId: String(r.pool_id),
    model: String(r.model),
    workType: r.work_type as WorkType,
    complexity: Number(r.complexity),
    result: r.result as OutcomeResult,
    quality: r.quality == null ? null : Number(r.quality),
    inScope: r.in_scope == null ? null : Number(r.in_scope),
    testsPassed: r.tests_passed == null ? null : Number(r.tests_passed) === 1,
    changesRequested: Number(r.changes_requested),
    value: Number(r.value),
    review: (r.review ?? null) as OutcomeReview | null,
    note: str(r.note),
    createdAt: String(r.created_at),
  };
}

const ARTIFACT_COLUMNS = 'id, board_id, card_id, kind, title, body, tags_json, summary, author, commit_sha, superseded_by, version, created_at';

/** Observed success for one agent (pool + model), weighted by how close each outcome's complexity is to the card's. */
export interface OutcomeStats {
  poolId: string;
  model: string;
  /** Weighted mean of outcome values. */
  rate: number;
  /** Weighted number of outcomes. */
  n: number;
  /** Raw count. */
  count: number;
}

export interface NewArtifact {
  boardId: string;
  cardId?: string | null;
  kind: ArtifactKind;
  title: string;
  body: string;
  author: string;
  commitSha?: string | null;
  /** The artifact this one replaces (it is marked superseded, and this one takes the next version). */
  supersedes?: string | null;
  tags?: string[];
}

const CARD_COLUMNS: Record<string, string> = {
  title: 'title',
  description: 'description',
  status: 'status',
  poolId: 'pool_id',
  agentId: 'agent_id',
  branch: 'branch',
  worktree: 'worktree',
  parentId: 'parent_id',
  workType: 'work_type',
  role: 'role',
};
const CARD_JSON_COLUMNS: Record<string, string> = { classification: 'kev_json', routing: 'routing_rules_json', pipeline: 'pipeline_json', grants: 'grants_json' };

export type CardPatch = Partial<
  Pick<Card, 'title' | 'description' | 'status' | 'poolId' | 'agentId' | 'branch' | 'worktree' | 'parentId' | 'workType' | 'role' | 'classification' | 'routing' | 'pipeline' | 'grants'>
>;

export interface NewCard {
  boardId: string;
  title: string;
  description?: string;
  parentId?: string | null;
  status?: CardStatus;
  role?: CardRole;
  workType?: WorkType | null;
  routing?: RoutingRules | null;
  createdBy?: string;
  grants?: string[];
}

/** One usage record (a gateway request, or a telemetry data point from an agent). */
export interface UsageInput {
  ts?: string;
  poolId: string;
  source: string;
  sessionId?: string | null;
  status?: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs?: number;
  boardId?: string | null;
  cardId?: string | null;
  agentId?: string | null;
  model?: string | null;
  /** Cache reads and writes, kept apart from the token counts budgets use. */
  cacheTokens?: number;
  /** What the harness said the usage cost, when it says. */
  costUsd?: number | null;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  costUsd: number;
  requests: number;
}

export interface UsageRow extends Omit<UsageTotals, 'costUsd'> {
  cardId: string | null;
  agentId: string | null;
  poolId: string;
  model: string | null;
  /** Null when no record in the group reported a cost. */
  costUsd: number | null;
}

/** A pool's state at a moment, kept for the usage history (Phase 6.3). */
export interface PoolSample {
  ts: string;
  poolId: string;
  state: string;
  topPct: number;
  windows: { window: string; pct: number }[];
  running: number;
}

/** SQLite-backed store. Every mutation appends to the event log in the same transaction. */
export class Store {
  readonly db: DatabaseSync;
  /** Swarm federation storage (Phase 7). */
  readonly fed: FedStore = new FedStore(this);
  private listeners = new Set<(e: DaemonEvent) => void>();

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate() {
    const version = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  onEvent(fn: (e: DaemonEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Appends an event. Listeners are notified after the surrounding transaction commits. */
  append(type: EventType, subject: string, payload: unknown, actor = 'daemon'): DaemonEvent {
    const ts = new Date().toISOString();
    const r = this.db
      .prepare('INSERT INTO events (ts, actor, type, subject, payload) VALUES (?, ?, ?, ?, ?) RETURNING seq')
      .get(ts, actor, type, subject, JSON.stringify(payload)) as Row;
    const event: DaemonEvent = { seq: Number(r.seq), ts, actor, type, subject, payload };
    if (!this.db.isTransaction) this.emit(event);
    else this.pending.push(event);
    return event;
  }

  private pending: DaemonEvent[] = [];

  private flush() {
    const events = this.pending;
    this.pending = [];
    for (const e of events) this.emit(e);
  }

  private emitting = false;
  private queued: DaemonEvent[] = [];

  /**
   * Delivers events to listeners in sequence order. A listener that appends an event while handling one (context
   * capture does) would otherwise have the new event reach later listeners before the one that caused it; the new
   * event waits until the current one has been delivered to everybody.
   */
  private emit(e: DaemonEvent) {
    this.queued.push(e);
    if (this.emitting) return;
    this.emitting = true;
    try {
      for (let next = this.queued.shift(); next; next = this.queued.shift()) for (const fn of this.listeners) fn(next);
    } finally {
      this.emitting = false;
    }
  }

  /** Runs `fn` in one transaction; events appended inside are delivered after it commits. */
  transact<T>(fn: () => T): T {
    return this.mutate(fn);
  }

  private mutate<T>(fn: () => T): T {
    const out = this.tx(fn);
    this.flush();
    return out;
  }

  // --- boards

  /**
   * Removes a board and everything the harness keeps about it: cards and their sessions, notes, messages, approvals,
   * leases, outcomes, usage, settings, the project card it shared and the events of its cards. Requests exchanged with
   * other swarms stay as history, detached from the board. The project folder is not touched.
   */
  deleteBoard(boardId: string): void {
    this.mutate(() => {
      const ids = (this.db.prepare('SELECT id FROM nodes WHERE board_id = ?').all(boardId) as Row[]).map((r) => String(r.id));
      const chunks = <T,>(xs: T[], n = 400) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
      for (const part of chunks(ids)) {
        const marks = part.map(() => '?').join(', ');
        this.db.prepare(`DELETE FROM edges WHERE from_node IN (${marks}) OR to_node IN (${marks})`).run(...part, ...part);
        this.db.prepare(`DELETE FROM sessions WHERE card_id IN (${marks})`).run(...part);
        this.db.prepare(`DELETE FROM events WHERE subject IN (${marks})`).run(...part);
      }
      this.db.prepare('DELETE FROM leases WHERE board_id = ?').run(boardId);
      this.db.prepare('DELETE FROM messages WHERE board_id = ?').run(boardId);
      this.db.prepare('DELETE FROM approvals WHERE board_id = ?').run(boardId);
      this.db.prepare('DELETE FROM outcomes WHERE board_id = ?').run(boardId);
      this.db.prepare('DELETE FROM artifacts_fts WHERE artifact_id IN (SELECT id FROM artifacts WHERE board_id = ?)').run(boardId);
      this.db.prepare('DELETE FROM artifacts WHERE board_id = ?').run(boardId);
      this.db.prepare('DELETE FROM usage_events WHERE board_id = ?').run(boardId);
      this.db.prepare('DELETE FROM settings WHERE board_id = ?').run(boardId);
      this.db.prepare('DELETE FROM fed_shared WHERE board_id = ?').run(boardId);
      this.db.prepare('UPDATE fed_requests SET board_id = NULL, card_id = NULL WHERE board_id = ?').run(boardId);
      this.db.prepare('DELETE FROM events WHERE subject = ?').run(boardId);
      // One statement, so the cards' links to their parents do not matter.
      this.db.prepare('DELETE FROM nodes WHERE board_id = ?').run(boardId);
      this.db.prepare('DELETE FROM boards WHERE id = ?').run(boardId);
      this.append('board.removed', boardId, { id: boardId }, 'user:local');
    });
  }

  createBoard(input: { name: string; repoPath: string; defaultBranch: string; mode?: BoardMode }): Board {
    return this.mutate(() => {
      const board: Board = { id: newId('b'), ...input, mode: input.mode ?? 'worktree', createdAt: new Date().toISOString() };
      this.db
        .prepare('INSERT INTO boards (id, name, repo_path, default_branch, mode, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(board.id, board.name, board.repoPath, board.defaultBranch, board.mode, board.createdAt);
      this.append('board.created', board.id, board);
      return board;
    });
  }

  listBoards(): Board[] {
    return (this.db.prepare('SELECT * FROM boards ORDER BY created_at').all() as Row[]).map(toBoard);
  }

  getBoard(id: string): Board | undefined {
    const r = this.db.prepare('SELECT * FROM boards WHERE id = ?').get(id) as Row | undefined;
    return r && toBoard(r);
  }

  // --- cards

  createCard(input: NewCard): Card {
    return this.mutate(() => {
      const now = new Date().toISOString();
      const parent = input.parentId ? this.getCard(input.parentId) : undefined;
      if (input.parentId && !parent) throw new Error(`parent card ${input.parentId} not found`);
      const card: Card = {
        id: newId('c'),
        boardId: input.boardId,
        parentId: input.parentId ?? null,
        title: input.title,
        description: input.description ?? '',
        status: input.status ?? 'backlog',
        poolId: null,
        agentId: null,
        branch: null,
        worktree: null,
        role: input.role ?? 'worker',
        workType: input.workType ?? null,
        classification: null,
        routing: input.routing ?? null,
        depth: parent ? parent.depth + 1 : 0,
        createdBy: input.createdBy ?? 'user:local',
        narration: null,
        pipeline: {},
        grants: input.grants ?? [],
        createdAt: now,
        updatedAt: now,
      };
      this.db
        .prepare(
          `INSERT INTO nodes (id, board_id, parent_id, title, description, status, role, work_type, routing_rules_json, depth, created_by, grants_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          card.id,
          card.boardId,
          card.parentId,
          card.title,
          card.description,
          card.status,
          card.role,
          card.workType,
          card.routing ? JSON.stringify(card.routing) : null,
          card.depth,
          card.createdBy,
          card.grants.length ? JSON.stringify(card.grants) : null,
          now,
          now,
        );
      this.append('card.created', card.id, card, card.createdBy);
      return card;
    });
  }

  children(cardId: string): Card[] {
    return (this.db.prepare('SELECT * FROM nodes WHERE parent_id = ? ORDER BY created_at').all(cardId) as Row[]).map(toCard);
  }

  /** Cards created by `actor` since `sinceIso` (per-turn caps). */
  countCreatedBy(actor: string, sinceIso: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE created_by = ? AND created_at >= ?').get(actor, sinceIso) as Row).n);
  }

  /** The card's own routing rules, or the nearest ancestor's (rules are inherited down the tree). */
  effectiveRouting(cardId: string): RoutingRules | null {
    for (let card = this.getCard(cardId); card; card = card.parentId ? this.getCard(card.parentId) : undefined) {
      if (card.routing) return card.routing;
    }
    return null;
  }

  setNarration(cardId: string, narration: string): void {
    this.db.prepare('UPDATE nodes SET narration = ? WHERE id = ?').run(narration, cardId);
    this.append('card.narrated', cardId, { narration }, 'fast-lane');
  }

  // --- dependencies (blocked-by edges; the graph stays acyclic)

  dependencies(boardId: string): Dependency[] {
    return (
      this.db
        .prepare(
          `SELECT e.from_node, e.to_node FROM edges e JOIN nodes n ON n.id = e.from_node WHERE n.board_id = ? AND e.kind = 'blocked_by'`,
        )
        .all(boardId) as Row[]
    ).map((r) => ({ cardId: String(r.from_node), blockedBy: String(r.to_node) }));
  }

  blockers(cardId: string): Card[] {
    return (
      this.db
        .prepare(`SELECT n.* FROM edges e JOIN nodes n ON n.id = e.to_node WHERE e.from_node = ? AND e.kind = 'blocked_by'`)
        .all(cardId) as Row[]
    ).map(toCard);
  }

  /** Adds "cardId is blocked by blockedBy". Refuses self-links, cross-board links and cycles. */
  addDependency(cardId: string, blockedBy: string, actor = 'daemon'): Dependency {
    return this.mutate(() => {
      const a = this.getCard(cardId);
      const b = this.getCard(blockedBy);
      if (!a || !b) throw new Error('both cards must exist');
      if (a.boardId !== b.boardId) throw new Error('cards are on different boards');
      if (cardId === blockedBy) throw new Error('a card cannot block itself');
      // A cycle would appear if `blockedBy` already (transitively) waits for `cardId`.
      const seen = new Set<string>();
      const stack = [blockedBy];
      while (stack.length) {
        const id = stack.pop()!;
        if (id === cardId) throw new Error(`cycle: ${b.title} already waits for ${a.title}`);
        if (seen.has(id)) continue;
        seen.add(id);
        for (const r of this.db.prepare(`SELECT to_node FROM edges WHERE from_node = ? AND kind = 'blocked_by'`).all(id) as Row[]) {
          stack.push(String(r.to_node));
        }
      }
      this.db.prepare(`INSERT OR IGNORE INTO edges (from_node, to_node, kind) VALUES (?, ?, 'blocked_by')`).run(cardId, blockedBy);
      const dep = { cardId, blockedBy };
      this.append('dependency.added', cardId, dep, actor);
      return dep;
    });
  }

  // --- settings

  getSettings(boardId: string): Settings {
    const r = this.db.prepare('SELECT settings_json FROM settings WHERE board_id = ?').get(boardId) as Row | undefined;
    return mergeSettings(DEFAULT_SETTINGS, r ? (JSON.parse(String(r.settings_json)) as Partial<Settings>) : {});
  }

  updateSettings(boardId: string, patch: Partial<Settings>, actor = 'user:local'): Settings {
    return this.mutate(() => {
      const settings = mergeSettings(this.getSettings(boardId), patch);
      this.db
        .prepare('INSERT INTO settings (board_id, settings_json) VALUES (?, ?) ON CONFLICT(board_id) DO UPDATE SET settings_json = excluded.settings_json')
        .run(boardId, JSON.stringify(settings));
      this.append('settings.updated', boardId, settings, actor);
      return settings;
    });
  }

  listCards(boardId: string): Card[] {
    return (this.db.prepare('SELECT * FROM nodes WHERE board_id = ? ORDER BY created_at').all(boardId) as Row[]).map(toCard);
  }

  getCard(id: string): Card | undefined {
    const r = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as Row | undefined;
    return r && toCard(r);
  }

  updateCard(id: string, patch: CardPatch, actor = 'daemon'): Card {
    return this.mutate(() => {
      const sets: string[] = [];
      const values: (string | null)[] = [];
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        if (CARD_COLUMNS[key]) {
          sets.push(`${CARD_COLUMNS[key]} = ?`);
          values.push(value as string | null);
        } else if (CARD_JSON_COLUMNS[key]) {
          sets.push(`${CARD_JSON_COLUMNS[key]} = ?`);
          values.push(value === null ? null : JSON.stringify(value));
        }
      }
      const updatedAt = new Date().toISOString();
      this.db.prepare(`UPDATE nodes SET ${[...sets, 'updated_at = ?'].join(', ')} WHERE id = ?`).run(...values, updatedAt, id);
      const card = this.getCard(id);
      if (!card) throw new Error(`card ${id} not found`);
      this.append('card.updated', id, { patch, card }, actor);
      return card;
    });
  }

  // --- sessions

  createSession(input: { cardId: string; poolId: string; harness: string; model: string }): Session {
    return this.mutate(() => {
      const session: Session = {
        id: newId('s'),
        ...input,
        vendorSessionId: null,
        state: 'starting',
        startedAt: new Date().toISOString(),
        endedAt: null,
      };
      this.db
        .prepare('INSERT INTO sessions (id, card_id, pool_id, harness, model, state, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(session.id, session.cardId, session.poolId, session.harness, session.model, session.state, session.startedAt);
      this.append('session.started', session.cardId, session);
      return session;
    });
  }

  updateSession(id: string, patch: { state?: SessionState; vendorSessionId?: string }): Session {
    return this.mutate(() => {
      const ended = patch.state === 'ended' || patch.state === 'failed';
      this.db
        .prepare(
          `UPDATE sessions SET state = COALESCE(?, state), vendor_session_id = COALESCE(?, vendor_session_id),
           ended_at = CASE WHEN ? THEN ? ELSE ended_at END WHERE id = ?`,
        )
        .run(patch.state ?? null, patch.vendorSessionId ?? null, ended ? 1 : 0, new Date().toISOString(), id);
      const session = this.getSession(id)!;
      if (ended) this.append('session.ended', session.cardId, session);
      return session;
    });
  }

  getSession(id: string): Session | undefined {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined;
    return r && toSession(r);
  }

  listSessions(cardId: string): Session[] {
    return (this.db.prepare('SELECT * FROM sessions WHERE card_id = ? ORDER BY started_at').all(cardId) as Row[]).map(toSession);
  }

  /** Sessions still marked open (starting, running, idle), on every board. After a restart none of them has a process. */
  openSessions(): Session[] {
    return (this.db.prepare("SELECT * FROM sessions WHERE state IN ('starting', 'running', 'idle') ORDER BY started_at").all() as Row[]).map(toSession);
  }

  /** Cards in one status, on every board. */
  cardsInStatus(status: CardStatus): Card[] {
    return (this.db.prepare('SELECT * FROM nodes WHERE status = ? ORDER BY created_at').all(status) as Row[]).map(toCard);
  }

  // --- leases

  /** Active leases on a board (not released, not expired). */
  activeLeases(boardId: string): Lease[] {
    return (
      this.db
        .prepare('SELECT * FROM leases WHERE board_id = ? AND released_at IS NULL AND expires_at > ? ORDER BY created_at')
        .all(boardId, new Date().toISOString()) as Row[]
    ).map(toLease);
  }

  /** Inserts leases atomically; `check` runs inside the transaction and may throw to refuse them. */
  acquireLeases(input: { boardId: string; cardId: string; globs: string[]; ttlMs: number }, check: (active: Lease[]) => void): Lease[] {
    return this.mutate(() => {
      check(this.activeLeases(input.boardId));
      const now = new Date();
      const expiresAt = new Date(now.getTime() + input.ttlMs).toISOString();
      return input.globs.map((glob) => {
        const lease: Lease = {
          id: newId('l'),
          boardId: input.boardId,
          cardId: input.cardId,
          glob,
          createdAt: now.toISOString(),
          expiresAt,
          releasedAt: null,
        };
        this.db
          .prepare('INSERT INTO leases (id, board_id, card_id, glob, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(lease.id, lease.boardId, lease.cardId, lease.glob, lease.createdAt, lease.expiresAt);
        this.append('lease.acquired', input.cardId, lease, `card:${input.cardId}`);
        return lease;
      });
    });
  }

  /** Releases a card's active leases (all, or only the given globs). Returns what was released. */
  releaseLeases(cardId: string, globs?: string[]): Lease[] {
    return this.mutate(() => {
      const now = new Date().toISOString();
      const active = (
        this.db.prepare('SELECT * FROM leases WHERE card_id = ? AND released_at IS NULL').all(cardId) as Row[]
      ).map(toLease);
      const released = globs ? active.filter((l) => globs.includes(l.glob)) : active;
      for (const lease of released) {
        this.db.prepare('UPDATE leases SET released_at = ? WHERE id = ?').run(now, lease.id);
        lease.releasedAt = now;
        this.append('lease.released', cardId, lease, `card:${cardId}`);
      }
      return released;
    });
  }

  // --- messages

  postMessage(input: { boardId: string; fromActor: string; toCard: string | null; body: string; urgent: boolean }): Message {
    return this.mutate(() => {
      const message: Message = { id: newId('m'), ...input, createdAt: new Date().toISOString(), deliveredAt: null, dismissedAt: null };
      this.db
        .prepare('INSERT INTO messages (id, board_id, from_actor, to_card, body, urgent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(message.id, message.boardId, message.fromActor, message.toCard, message.body, message.urgent ? 1 : 0, message.createdAt);
      // Logged on both ends so each card's activity shows its side of the conversation.
      const fromCard = input.fromActor.startsWith('card:') ? input.fromActor.slice(5) : null;
      if (input.toCard) this.append('message.posted', input.toCard, message, input.fromActor);
      if (fromCard && fromCard !== input.toCard) this.append('message.posted', fromCard, message, input.fromActor);
      if (!input.toCard && !fromCard) this.append('message.posted', input.boardId, message, input.fromActor);
      return message;
    });
  }

  pendingMessages(cardId: string): Message[] {
    return (
      this.db.prepare('SELECT * FROM messages WHERE to_card = ? AND delivered_at IS NULL ORDER BY created_at').all(cardId) as Row[]
    ).map(toMessage);
  }

  markDelivered(ids: string[]): void {
    if (!ids.length) return;
    this.mutate(() => {
      const now = new Date().toISOString();
      for (const id of ids) {
        this.db.prepare('UPDATE messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL').run(now, id);
        const m = toMessage(this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row);
        if (m.toCard) this.append('message.delivered', m.toCard, m);
      }
    });
  }

  /**
   * Clears messages for the humans (not agents' mail to each other) from the attention list: the ones named in `ids`,
   * or all of the board's when `ids` is omitted. Returns the ids that were cleared.
   */
  dismissMessages(boardId: string, ids?: string[]): string[] {
    return this.mutate(() => {
      const now = new Date().toISOString();
      const open = (
        this.db.prepare('SELECT id FROM messages WHERE board_id = ? AND to_card IS NULL AND dismissed_at IS NULL').all(boardId) as Row[]
      ).map((r) => String(r.id));
      const wanted = ids ? new Set(ids) : null;
      const cleared = open.filter((id) => !wanted || wanted.has(id));
      for (const id of cleared) this.db.prepare('UPDATE messages SET dismissed_at = ? WHERE id = ?').run(now, id);
      if (cleared.length) this.append('message.dismissed', boardId, { boardId, ids: cleared, at: now }, 'user:local');
      return cleared;
    });
  }

  // --- pool ejections (an endpoint that stopped answering stays out of routing until a person restores it)

  poolEjections(): { poolId: string; since: string; reason: string }[] {
    return (this.db.prepare('SELECT * FROM pool_ejections').all() as Row[]).map((r) => ({ poolId: String(r.pool_id), since: String(r.since), reason: String(r.reason) }));
  }

  /** Takes a pool out of rotation. False when it already is (the first reason stands). */
  ejectPool(poolId: string, reason: string): boolean {
    return this.mutate(() => {
      if (this.db.prepare('SELECT 1 FROM pool_ejections WHERE pool_id = ?').get(poolId)) return false;
      const since = new Date().toISOString();
      this.db.prepare('INSERT INTO pool_ejections (pool_id, since, reason) VALUES (?, ?, ?)').run(poolId, since, reason);
      this.append('pool.ejected', poolId, { poolId, since, reason }, 'daemon:health');
      return true;
    });
  }

  restorePool(poolId: string): boolean {
    return this.mutate(() => {
      if (!this.db.prepare('DELETE FROM pool_ejections WHERE pool_id = ? RETURNING 1').get(poolId)) return false;
      this.append('pool.restored', poolId, { poolId }, 'user:local');
      return true;
    });
  }

  boardMessages(boardId: string, limit = 200): Message[] {
    return (
      this.db.prepare('SELECT * FROM messages WHERE board_id = ? ORDER BY created_at DESC LIMIT ?').all(boardId, limit) as Row[]
    )
      .map(toMessage)
      .reverse();
  }

  // --- usage

  recordUsage(u: UsageInput) {
    this.db
      .prepare(
        `INSERT INTO usage_events (ts, pool_id, session_id, source, status, input_tokens, output_tokens, latency_ms, board_id, card_id, agent_id, model, cache_tokens, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        u.ts ?? new Date().toISOString(),
        u.poolId,
        u.sessionId ?? null,
        u.source,
        u.status ?? null,
        u.inputTokens,
        u.outputTokens,
        u.latencyMs ?? null,
        u.boardId ?? null,
        u.cardId ?? null,
        u.agentId ?? null,
        u.model ?? null,
        u.cacheTokens ?? 0,
        u.costUsd ?? null,
      );
    this.usageListeners.forEach((fn) => fn(u));
  }

  private usageListeners = new Set<(u: UsageInput) => void>();

  /** Tells `fn` about every usage record as it is stored (budgets re-evaluate on it). */
  onUsage(fn: (u: UsageInput) => void): () => void {
    this.usageListeners.add(fn);
    return () => this.usageListeners.delete(fn);
  }

  /**
   * What a board (or one agent on it) has used since `sinceIso` (all time when omitted): tokens (input + output; cache
   * reads are tracked apart), the cost the harness reported, and request count. Records without a board count for nobody.
   */
  usageTotals(boardId: string, opts: { agentId?: string; sinceIso?: string } = {}): UsageTotals {
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o, COALESCE(SUM(cache_tokens), 0) AS c,
                COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS n
         FROM usage_events WHERE board_id = ? AND ts >= ? AND (? IS NULL OR agent_id = ?)`,
      )
      .get(boardId, opts.sinceIso ?? '', opts.agentId ?? null, opts.agentId ?? null) as Row;
    return { inputTokens: Number(r.i), outputTokens: Number(r.o), cacheTokens: Number(r.c), costUsd: Number(r.usd), requests: Number(r.n) };
  }

  /** What a set of cards has used since `sinceIso` (all time when omitted). Used for the budget of a request from another swarm. */
  usageForCards(cardIds: string[], sinceIso = ''): UsageTotals {
    if (!cardIds.length) return { inputTokens: 0, outputTokens: 0, cacheTokens: 0, costUsd: 0, requests: 0 };
    const marks = cardIds.map(() => '?').join(', ');
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o, COALESCE(SUM(cache_tokens), 0) AS c,
                COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS n
         FROM usage_events WHERE card_id IN (${marks}) AND ts >= ?`,
      )
      .get(...cardIds, sinceIso) as Row;
    return { inputTokens: Number(r.i), outputTokens: Number(r.o), cacheTokens: Number(r.c), costUsd: Number(r.usd), requests: Number(r.n) };
  }

  /** A pool's requests and tokens over time (all boards, plus the fast lane), bucketed by hour or day (UTC). */
  poolUsageSeries(poolId: string, sinceIso: string, bucket: 'hour' | 'day'): { bucket: string; requests: number; inputTokens: number; outputTokens: number; errors: number }[] {
    const len = bucket === 'hour' ? 13 : 10;
    return (
      this.db
        .prepare(
          `SELECT substr(ts, 1, ${len}) AS b, COUNT(*) AS n, COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o,
                  COALESCE(SUM(CASE WHEN status = 429 THEN 1 ELSE 0 END), 0) AS e
           FROM usage_events WHERE pool_id = ? AND ts >= ? GROUP BY b ORDER BY b`,
        )
        .all(poolId, sinceIso) as Row[]
    ).map((r) => ({ bucket: String(r.b), requests: Number(r.n), inputTokens: Number(r.i), outputTokens: Number(r.o), errors: Number(r.e) }));
  }

  /** Usage grouped by card, agent and model for a board (the metrics view rolls it up the card tree). */
  usageBreakdown(boardId: string, sinceIso = ''): UsageRow[] {
    return (
      this.db
        .prepare(
          `SELECT card_id, agent_id, pool_id, model, SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(cache_tokens) AS c,
                  SUM(cost_usd) AS usd, COUNT(*) AS n
           FROM usage_events WHERE board_id = ? AND ts >= ? GROUP BY card_id, agent_id, pool_id, model`,
        )
        .all(boardId, sinceIso) as Row[]
    ).map((r) => ({
      cardId: str(r.card_id),
      agentId: str(r.agent_id),
      poolId: String(r.pool_id),
      model: str(r.model),
      inputTokens: Number(r.i ?? 0),
      outputTokens: Number(r.o ?? 0),
      cacheTokens: Number(r.c ?? 0),
      costUsd: r.usd == null ? null : Number(r.usd),
      requests: Number(r.n),
    }));
  }

  /** Tokens and cost over time for a board, bucketed by hour or day (UTC), oldest first. */
  usageSeries(boardId: string, sinceIso: string, bucket: 'hour' | 'day'): { bucket: string; tokens: number; costUsd: number }[] {
    const len = bucket === 'hour' ? 13 : 10;
    return (
      this.db
        .prepare(
          `SELECT substr(ts, 1, ${len}) AS b, SUM(input_tokens + output_tokens) AS t, COALESCE(SUM(cost_usd), 0) AS usd
           FROM usage_events WHERE board_id = ? AND ts >= ? GROUP BY b ORDER BY b`,
        )
        .all(boardId, sinceIso) as Row[]
    ).map((r) => ({ bucket: String(r.b), tokens: Number(r.t ?? 0), costUsd: Number(r.usd) }));
  }

  /** Requests and tokens per pool since `sinceIso`. */
  usageSince(sinceIso: string): { poolId: string; requests: number; inputTokens: number; outputTokens: number }[] {
    return (
      this.db
        .prepare(
          `SELECT pool_id, COUNT(*) AS requests, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens
           FROM usage_events WHERE ts >= ? GROUP BY pool_id ORDER BY pool_id`,
        )
        .all(sinceIso) as Row[]
    ).map((r) => ({
      poolId: String(r.pool_id),
      requests: Number(r.requests),
      inputTokens: Number(r.input_tokens ?? 0),
      outputTokens: Number(r.output_tokens ?? 0),
    }));
  }

  // --- approvals (master plan Phase 6.4)

  createApproval(input: { boardId: string; cardId?: string | null; kind: ApprovalKind; summary: string; payload: Record<string, unknown>; requestedBy: string }): Approval {
    return this.mutate(() => {
      const approval: Approval = {
        id: newId('ap'),
        boardId: input.boardId,
        cardId: input.cardId ?? null,
        kind: input.kind,
        summary: input.summary,
        payload: input.payload,
        status: 'pending',
        requestedBy: input.requestedBy,
        decidedBy: null,
        note: null,
        createdAt: new Date().toISOString(),
        decidedAt: null,
      };
      this.db
        .prepare('INSERT INTO approvals (id, board_id, card_id, kind, summary, payload_json, status, requested_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(approval.id, approval.boardId, approval.cardId, approval.kind, approval.summary, JSON.stringify(approval.payload), approval.status, approval.requestedBy, approval.createdAt);
      this.append('approval.created', approval.boardId, approval, input.requestedBy);
      return approval;
    });
  }

  getApproval(id: string): Approval | undefined {
    const r = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined;
    return r && toApproval(r);
  }

  listApprovals(boardId: string, opts: { status?: ApprovalStatus; limit?: number } = {}): Approval[] {
    return (
      this.db
        .prepare('SELECT * FROM approvals WHERE board_id = ? AND (? IS NULL OR status = ?) ORDER BY created_at DESC LIMIT ?')
        .all(boardId, opts.status ?? null, opts.status ?? null, opts.limit ?? 200) as Row[]
    ).map(toApproval);
  }

  /** Records a human's decision on a pending approval; it is final. */
  decideApproval(id: string, status: 'approved' | 'denied', decidedBy: string, note?: string | null): Approval {
    return this.mutate(() => {
      const old = this.getApproval(id);
      if (!old) throw new Error(`approval ${id} not found`);
      if (old.status !== 'pending') throw new Error(`approval ${id} was already ${old.status}`);
      this.db
        .prepare('UPDATE approvals SET status = ?, decided_by = ?, note = ?, decided_at = ? WHERE id = ?')
        .run(status, decidedBy, note?.trim() || null, new Date().toISOString(), id);
      const approval = this.getApproval(id)!;
      this.append('approval.decided', approval.boardId, approval, decidedBy);
      return approval;
    });
  }

  // --- pool usage history (master plan Phase 6.3)

  recordPoolSamples(samples: PoolSample[]): void {
    if (!samples.length) return;
    this.tx(() => {
      const insert = this.db.prepare('INSERT INTO pool_samples (ts, pool_id, state, top_pct, windows_json, running) VALUES (?, ?, ?, ?, ?, ?)');
      for (const x of samples) insert.run(x.ts, x.poolId, x.state, x.topPct, JSON.stringify(x.windows), x.running);
    });
  }

  poolHistory(poolId: string, sinceIso: string): PoolSample[] {
    return (this.db.prepare('SELECT * FROM pool_samples WHERE pool_id = ? AND ts >= ? ORDER BY ts').all(poolId, sinceIso) as Row[]).map((r) => ({
      ts: String(r.ts),
      poolId: String(r.pool_id),
      state: String(r.state),
      topPct: Number(r.top_pct),
      windows: JSON.parse(String(r.windows_json)) as PoolSample['windows'],
      running: Number(r.running),
    }));
  }

  /** Forgets samples older than `beforeIso` (the history keeps a week). */
  prunePoolSamples(beforeIso: string): void {
    this.db.prepare('DELETE FROM pool_samples WHERE ts < ?').run(beforeIso);
  }

  /** Moves every "waits for `from`" link onto `to` (best-of-N: dependents follow the winning candidate). */
  moveDependents(from: string, to: string): void {
    this.mutate(() => {
      const rows = this.db.prepare(`SELECT from_node FROM edges WHERE to_node = ? AND kind = 'blocked_by'`).all(from) as Row[];
      for (const r of rows) {
        this.db.prepare(`DELETE FROM edges WHERE from_node = ? AND to_node = ? AND kind = 'blocked_by'`).run(String(r.from_node), from);
        this.db.prepare(`INSERT OR IGNORE INTO edges (from_node, to_node, kind) VALUES (?, ?, 'blocked_by')`).run(String(r.from_node), to);
        this.append('dependency.added', String(r.from_node), { cardId: String(r.from_node), blockedBy: to }, 'daemon');
      }
    });
  }

  /** Cards that wait for `cardId`. */
  dependents(cardId: string): Card[] {
    return (this.db.prepare(`SELECT n.* FROM edges e JOIN nodes n ON n.id = e.from_node WHERE e.to_node = ? AND e.kind = 'blocked_by'`).all(cardId) as Row[]).map(toCard);
  }

  // --- artifacts (master plan §5.7)

  putArtifact(input: NewArtifact): Artifact {
    return this.mutate(() => {
      const old = input.supersedes ? this.getArtifact(input.supersedes) : undefined;
      if (input.supersedes && (!old || old.boardId !== input.boardId)) throw new Error(`no artifact ${input.supersedes} on this board`);
      const artifact: Artifact = {
        id: newId('a'),
        boardId: input.boardId,
        cardId: input.cardId ?? null,
        kind: input.kind,
        title: input.title,
        body: input.body,
        tags: input.tags ?? [],
        summary: null,
        author: input.author,
        commitSha: input.commitSha ?? null,
        supersededBy: null,
        version: old ? old.version + 1 : 1,
        createdAt: new Date().toISOString(),
      };
      this.db
        .prepare(
          `INSERT INTO artifacts (${ARTIFACT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          artifact.id,
          artifact.boardId,
          artifact.cardId,
          artifact.kind,
          artifact.title,
          artifact.body,
          JSON.stringify(artifact.tags),
          null,
          artifact.author,
          artifact.commitSha,
          null,
          artifact.version,
          artifact.createdAt,
        );
      this.db.prepare('INSERT INTO artifacts_fts (artifact_id, title, body, tags, summary) VALUES (?, ?, ?, ?, ?)').run(artifact.id, artifact.title, artifact.body, artifact.tags.join(' '), '');
      if (old) this.db.prepare('UPDATE artifacts SET superseded_by = ? WHERE id = ?').run(artifact.id, old.id);
      this.append('artifact.saved', artifact.cardId ?? artifact.boardId, { artifact, supersedes: old?.id ?? null }, input.author);
      return artifact;
    });
  }

  getArtifact(id: string): Artifact | undefined {
    const r = this.db.prepare(`SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE id = ?`).get(id) as Row | undefined;
    return r && toArtifact(r);
  }

  /** A board's artifacts, newest first: current ones only unless `all`; optionally only some cards or kinds. */
  listArtifacts(boardId: string, opts: { cardIds?: string[]; kinds?: ArtifactKind[]; all?: boolean; limit?: number } = {}): Artifact[] {
    const where = ['board_id = ?'];
    const args: (string | number)[] = [boardId];
    if (!opts.all) where.push('superseded_by IS NULL');
    if (opts.cardIds) {
      if (!opts.cardIds.length) return [];
      where.push(`card_id IN (${opts.cardIds.map(() => '?').join(', ')})`);
      args.push(...opts.cardIds);
    }
    if (opts.kinds?.length) {
      where.push(`kind IN (${opts.kinds.map(() => '?').join(', ')})`);
      args.push(...opts.kinds);
    }
    args.push(opts.limit ?? 500);
    return (
      this.db.prepare(`SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...args) as Row[]
    ).map(toArtifact);
  }

  /** Tags and summary from the fast lane (job #4); also indexed for search. */
  setArtifactMeta(id: string, meta: { tags: string[]; summary: string }): void {
    this.db.prepare('UPDATE artifacts SET tags_json = ?, summary = ? WHERE id = ?').run(JSON.stringify(meta.tags), meta.summary, id);
    this.db.prepare('UPDATE artifacts_fts SET tags = ?, summary = ? WHERE artifact_id = ?').run(meta.tags.join(' '), meta.summary, id);
  }

  setArtifactEmbedding(id: string, vector: Float32Array, model: string): void {
    this.db.prepare('UPDATE artifacts SET embedding = ?, embed_model = ? WHERE id = ?').run(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength), model, id);
  }

  /** Current artifacts with an embedding from `model`, for vector search (brute force; boards hold thousands at most). */
  artifactEmbeddings(boardId: string, model: string, cardIds?: string[]): { id: string; vector: Float32Array }[] {
    const where = ['board_id = ?', 'superseded_by IS NULL', 'embedding IS NOT NULL', 'embed_model = ?'];
    const args: string[] = [boardId, model];
    if (cardIds) {
      if (!cardIds.length) return [];
      where.push(`card_id IN (${cardIds.map(() => '?').join(', ')})`);
      args.push(...cardIds);
    }
    return (this.db.prepare(`SELECT id, embedding FROM artifacts WHERE ${where.join(' AND ')}`).all(...args) as { id: string; embedding: Uint8Array }[]).map((r) => {
      const bytes = r.embedding;
      return { id: String(r.id), vector: new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) };
    });
  }

  /** Current artifacts missing an embedding from `model` (backfill after the endpoint was down). */
  unembeddedArtifacts(model: string, limit = 50): Artifact[] {
    return (
      this.db
        .prepare(`SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE superseded_by IS NULL AND (embedding IS NULL OR embed_model IS NOT ?) ORDER BY created_at LIMIT ?`)
        .all(model, limit) as Row[]
    ).map(toArtifact);
  }

  /** FTS5 search; `match` is an FTS5 query expression. Best first. */
  searchArtifactsText(boardId: string, match: string, opts: { cardIds?: string[]; kinds?: ArtifactKind[]; limit?: number } = {}): { id: string; rank: number }[] {
    const where = ['artifacts_fts MATCH ?', 'a.board_id = ?', 'a.superseded_by IS NULL'];
    const args: (string | number)[] = [match, boardId];
    if (opts.cardIds) {
      if (!opts.cardIds.length) return [];
      where.push(`a.card_id IN (${opts.cardIds.map(() => '?').join(', ')})`);
      args.push(...opts.cardIds);
    }
    if (opts.kinds?.length) {
      where.push(`a.kind IN (${opts.kinds.map(() => '?').join(', ')})`);
      args.push(...opts.kinds);
    }
    args.push(opts.limit ?? 20);
    return (
      this.db
        .prepare(
          `SELECT a.id AS id, bm25(artifacts_fts, 0, 4, 1, 2, 2) AS rank FROM artifacts_fts JOIN artifacts a ON a.id = artifacts_fts.artifact_id
           WHERE ${where.join(' AND ')} ORDER BY rank LIMIT ?`,
        )
        .all(...args) as Row[]
    ).map((r) => ({ id: String(r.id), rank: Number(r.rank) }));
  }

  /** The card and every card below it. */
  subtreeIds(cardId: string): string[] {
    const out: string[] = [];
    const stack = [cardId];
    while (stack.length) {
      const id = stack.pop()!;
      out.push(id);
      for (const r of this.db.prepare('SELECT id FROM nodes WHERE parent_id = ?').all(id) as Row[]) stack.push(String(r.id));
    }
    return out;
  }

  // --- outcomes (master plan §5.4 step 7)

  recordOutcome(o: Omit<Outcome, 'id' | 'createdAt' | 'review' | 'note'> & { review?: OutcomeReview | null; note?: string | null }, actor = 'daemon'): Outcome {
    return this.mutate(() => {
      const createdAt = new Date().toISOString();
      const r = this.db
        .prepare(
          `INSERT INTO outcomes (card_id, board_id, agent_id, pool_id, model, work_type, complexity, result, quality, in_scope, tests_passed, changes_requested, value, review, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .get(
          o.cardId,
          o.boardId,
          o.agentId,
          o.poolId,
          o.model,
          o.workType,
          o.complexity,
          o.result,
          o.quality,
          o.inScope,
          o.testsPassed === null ? null : o.testsPassed ? 1 : 0,
          o.changesRequested,
          o.value,
          o.review ?? null,
          o.note ?? null,
          createdAt,
        ) as Row;
      const outcome: Outcome = { ...o, review: o.review ?? null, note: o.note ?? null, id: Number(r.id), createdAt };
      this.append('card.outcome', o.cardId, outcome, actor);
      return outcome;
    });
  }

  outcomesFor(cardId: string): Outcome[] {
    return (this.db.prepare('SELECT * FROM outcomes WHERE card_id = ? ORDER BY id').all(cardId) as Row[]).map(toOutcome);
  }

  listOutcomes(limit = 500, opts: { boardId?: string; pending?: boolean } = {}): Outcome[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.boardId) {
      where.push('board_id = ?');
      args.push(opts.boardId);
    }
    if (opts.pending) where.push(`review = 'pending'`);
    return (
      this.db.prepare(`SELECT * FROM outcomes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...args, limit) as Row[]
    ).map(toOutcome);
  }

  getOutcome(id: number): Outcome | undefined {
    const r = this.db.prepare('SELECT * FROM outcomes WHERE id = ?').get(id) as Row | undefined;
    return r && toOutcome(r);
  }

  /** A human weighs an outcome: pass (counts as success), fail (counts as failure) or ignore (doesn't count). */
  reviewOutcome(id: number, verdict: Exclude<OutcomeReview, 'pending'>, actor = 'user:local'): Outcome {
    return this.mutate(() => {
      const before = this.getOutcome(id);
      if (!before) throw new Error(`outcome ${id} not found`);
      const value = verdict === 'ignore' ? before.value : OUTCOME_REVIEW_VALUE[verdict];
      this.db.prepare('UPDATE outcomes SET review = ?, value = ? WHERE id = ?').run(verdict, value, id);
      const outcome = this.getOutcome(id)!;
      this.append('outcome.reviewed', outcome.cardId, outcome, actor);
      return outcome;
    });
  }

  /**
   * Success per agent (pool + model) for one work type, across boards (it is a property of the model). Outcomes at
   * the card's complexity count fully, one level away half, further a quarter.
   */
  outcomeStats(workType: string, complexity: number): OutcomeStats[] {
    // Outcomes waiting for a human, or set aside by one, don't count.
    const rows = this.db
      .prepare(`SELECT pool_id, model, complexity, value FROM outcomes WHERE work_type = ? AND (review IS NULL OR review IN ('pass', 'fail'))`)
      .all(workType) as Row[];
    const by = new Map<string, OutcomeStats & { sum: number }>();
    for (const r of rows) {
      const key = `${r.pool_id}\0${r.model}`;
      const d = Math.abs(Number(r.complexity) - complexity);
      const w = d < 0.75 ? 1 : d < 1.75 ? 0.5 : 0.25;
      const s = by.get(key) ?? { poolId: String(r.pool_id), model: String(r.model), rate: 0, n: 0, count: 0, sum: 0 };
      s.sum += w * Number(r.value);
      s.n += w;
      s.count++;
      by.set(key, s);
    }
    return [...by.values()].map(({ sum, ...s }) => ({ ...s, rate: sum / s.n, n: Math.round(s.n * 100) / 100 }));
  }

  // --- events

  /** The newest event's sequence number (0 for an empty log). */
  lastEventSeq(): number {
    return Number((this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM events').get() as Row).n);
  }

  /** Every event after `afterSeq`, oldest first (for a client catching up after a dropped connection). */
  eventsAfter(afterSeq: number, limit: number): DaemonEvent[] {
    return (this.db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?').all(afterSeq, limit) as Row[]).map(toEvent);
  }

  /** Events about one subject (a card's events use the card id as subject). */
  /**
   * A subject's events, oldest first. With `afterSeq` it pages forward from there; without it, a subject with more than
   * `limit` events returns the NEWEST `limit` (the oldest ones used to be returned, which left a long-running card's
   * panel, narration and summary stuck in its first minutes).
   */
  eventsFor(subject: string, afterSeq = 0, limit = 2000): DaemonEvent[] {
    if (afterSeq > 0) {
      return (this.db.prepare('SELECT * FROM events WHERE subject = ? AND seq > ? ORDER BY seq LIMIT ?').all(subject, afterSeq, limit) as Row[]).map(toEvent);
    }
    return (this.db.prepare('SELECT * FROM events WHERE subject = ? ORDER BY seq DESC LIMIT ?').all(subject, limit) as Row[]).map(toEvent).reverse();
  }

  close() {
    this.db.close();
  }
}

export * from './federation.ts';
