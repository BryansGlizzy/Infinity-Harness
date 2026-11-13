// Storage for swarm federation (master plan Phase 7): peers, the projects we share and the ones we cached from peers,
// requests in both directions, replay-protection nonces and a few settings. Lives in the daemon's own database; every
// change appends an event so the audit trail and the live clients see it.
import { newId, type PeerCaps, type FedRequest, type Peer, type PeerAddress, type PeerKnock, type PeerProject, type PeerTrust, type ProjectCard, type RequestBudget, type RequestOrigin, type RequestResolution, type RequestStatus, type SharedProject, type ThreadEntry, type Visibility } from '@ih/core';
import type { Store } from './index.ts';

type Row = Record<string, string | number | null>;
const str = (v: unknown) => (v == null ? null : String(v));
const json = <T>(v: unknown): T | null => (v == null ? null : (JSON.parse(String(v)) as T));

export const FEDERATION_MIGRATION = `
  CREATE TABLE fed_peers (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    swarm_id TEXT UNIQUE,
    name TEXT,
    public_key TEXT,
    fingerprint TEXT,
    address_json TEXT,
    expected_fingerprint TEXT,
    trust TEXT NOT NULL,
    shares TEXT NOT NULL DEFAULT 'basic',
    enabled INTEGER NOT NULL DEFAULT 1,
    knock_json TEXT,
    last_contact_at TEXT,
    last_error TEXT,
    directory_hash TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE fed_shared (
    board_id TEXT PRIMARY KEY REFERENCES boards(id),
    visibility TEXT NOT NULL DEFAULT 'none',
    draft_json TEXT,
    draft_source TEXT,
    published_json TEXT,
    published_at TEXT
  );
  CREATE TABLE fed_peer_projects (
    peer_id TEXT NOT NULL REFERENCES fed_peers(id),
    project_id TEXT NOT NULL,
    card_json TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (peer_id, project_id)
  );
  CREATE TABLE fed_requests (
    id TEXT PRIMARY KEY,
    direction TEXT NOT NULL,
    peer_id TEXT NOT NULL REFERENCES fed_peers(id),
    remote_id TEXT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    project TEXT,
    blocking INTEGER NOT NULL DEFAULT 0,
    acceptance_json TEXT NOT NULL,
    milestones_json TEXT NOT NULL,
    budget_json TEXT,
    status TEXT NOT NULL,
    resolution_json TEXT,
    thread_json TEXT NOT NULL,
    origin_json TEXT NOT NULL,
    board_id TEXT,
    card_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX fed_requests_remote ON fed_requests(peer_id, direction, remote_id) WHERE remote_id IS NOT NULL;
  CREATE INDEX fed_requests_card ON fed_requests(card_id);
  CREATE TABLE fed_nonces (nonce TEXT PRIMARY KEY, ts INTEGER NOT NULL);
  CREATE TABLE fed_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export const FEDERATION_MIGRATION_2 = `
  ALTER TABLE fed_peers ADD COLUMN auto_accept INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE fed_peers ADD COLUMN caps_json TEXT;
  ALTER TABLE fed_requests ADD COLUMN approval_id TEXT;
  ALTER TABLE fed_requests ADD COLUMN auto INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE fed_requests ADD COLUMN milestones_done_json TEXT NOT NULL DEFAULT '[]';
  CREATE INDEX fed_requests_approval ON fed_requests(approval_id);
`;

export interface NewPeer {
  label: string;
  trust: PeerTrust;
  address?: PeerAddress | null;
  expectedFingerprint?: string | null;
  swarmId?: string | null;
  name?: string | null;
  publicKey?: string | null;
  fingerprint?: string | null;
  knock?: PeerKnock | null;
  shares?: Visibility;
}

export type PeerPatch = Partial<{
  label: string;
  swarmId: string | null;
  name: string | null;
  publicKey: string | null;
  fingerprint: string | null;
  address: PeerAddress | null;
  expectedFingerprint: string | null;
  trust: PeerTrust;
  shares: Visibility;
  autoAccept: boolean;
  caps: PeerCaps;
  enabled: boolean;
  knock: PeerKnock | null;
  lastContactAt: string | null;
  lastError: string | null;
  directoryHash: string | null;
}>;

export interface NewRequest {
  direction: 'in' | 'out';
  peerId: string;
  remoteId?: string | null;
  title: string;
  description: string;
  project?: string | null;
  blocking?: boolean;
  acceptance?: string[];
  milestones?: string[];
  budget?: RequestBudget | null;
  status: RequestStatus;
  origin: RequestOrigin;
  thread?: ThreadEntry[];
  boardId?: string | null;
  cardId?: string | null;
  approvalId?: string | null;
  auto?: boolean;
}

export type RequestPatch = Partial<{
  remoteId: string | null;
  status: RequestStatus;
  resolution: RequestResolution | null;
  thread: ThreadEntry[];
  boardId: string | null;
  cardId: string | null;
  milestonesDone: number[];
  budget: RequestBudget | null;
  approvalId: string | null;
  auto: boolean;
}>;

function toPeer(r: Row, projects = 0): Peer {
  return {
    id: String(r.id),
    label: String(r.label),
    swarmId: str(r.swarm_id),
    name: str(r.name),
    publicKey: str(r.public_key),
    fingerprint: str(r.fingerprint),
    address: json<PeerAddress>(r.address_json),
    expectedFingerprint: str(r.expected_fingerprint),
    trust: r.trust as PeerTrust,
    shares: (r.shares ?? 'basic') as Visibility,
    autoAccept: r.auto_accept === 1,
    caps: json<PeerCaps>(r.caps_json) ?? {},
    enabled: r.enabled === 1,
    knock: json<PeerKnock>(r.knock_json),
    lastContactAt: str(r.last_contact_at),
    lastError: str(r.last_error),
    createdAt: String(r.created_at),
    link: 'none',
    projects,
  };
}

function toRequest(r: Row): FedRequest {
  return {
    id: String(r.id),
    direction: r.direction === 'in' ? 'in' : 'out',
    peerId: String(r.peer_id),
    peerName: str(r.peer_name),
    remoteId: str(r.remote_id),
    title: String(r.title),
    description: String(r.description),
    project: str(r.project),
    blocking: r.blocking === 1,
    acceptance: json<string[]>(r.acceptance_json) ?? [],
    milestones: json<string[]>(r.milestones_json) ?? [],
    budget: json<RequestBudget>(r.budget_json),
    status: r.status as RequestStatus,
    resolution: json<RequestResolution>(r.resolution_json),
    thread: json<ThreadEntry[]>(r.thread_json) ?? [],
    milestonesDone: json<number[]>(r.milestones_done_json) ?? [],
    approvalId: str(r.approval_id),
    auto: r.auto === 1,
    origin: json<RequestOrigin>(r.origin_json) ?? { swarmId: '', cardId: null, hops: [] },
    boardId: str(r.board_id),
    cardId: str(r.card_id),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export class FedStore {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
  }

  private get db() {
    return this.store.db;
  }

  // --- settings

  getKv(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM fed_kv WHERE key = ?').get(key) as Row | undefined;
    return r ? String(r.value) : null;
  }

  setKv(key: string, value: string): void {
    this.db.prepare('INSERT INTO fed_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // --- replay protection

  /** Records a nonce. False when it was already used (a replay). */
  useNonce(nonce: string, ts: number): boolean {
    return Number(this.db.prepare('INSERT OR IGNORE INTO fed_nonces (nonce, ts) VALUES (?, ?)').run(nonce, ts).changes) > 0;
  }

  pruneNonces(olderThan: number): void {
    this.db.prepare('DELETE FROM fed_nonces WHERE ts < ?').run(olderThan);
  }

  // --- peers

  private projectCount(peerId: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM fed_peer_projects WHERE peer_id = ?').get(peerId) as Row).n);
  }

  getPeer(id: string): Peer | undefined {
    const r = this.db.prepare('SELECT * FROM fed_peers WHERE id = ?').get(id) as Row | undefined;
    return r && toPeer(r, this.projectCount(id));
  }

  peerBySwarm(swarmId: string): Peer | undefined {
    const r = this.db.prepare('SELECT * FROM fed_peers WHERE swarm_id = ?').get(swarmId) as Row | undefined;
    return r && toPeer(r, this.projectCount(String(r.id)));
  }

  /** A peer by id, by exact label (case-insensitive) or by swarm id. */
  findPeer(selector: string): Peer | undefined {
    const all = this.listPeers();
    return all.find((p) => p.id === selector) ?? all.find((p) => p.label.toLowerCase() === selector.toLowerCase()) ?? all.find((p) => p.swarmId === selector);
  }

  listPeers(): Peer[] {
    return (this.db.prepare('SELECT * FROM fed_peers ORDER BY created_at').all() as Row[]).map((r) => toPeer(r, this.projectCount(String(r.id))));
  }

  createPeer(input: NewPeer): Peer {
    const peer = this.store.transact(() => {
      const id = newId('pr');
      this.db
        .prepare(
          `INSERT INTO fed_peers (id, label, swarm_id, name, public_key, fingerprint, address_json, expected_fingerprint, trust, shares, enabled, knock_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id,
          input.label,
          input.swarmId ?? null,
          input.name ?? null,
          input.publicKey ?? null,
          input.fingerprint ?? null,
          input.address ? JSON.stringify(input.address) : null,
          input.expectedFingerprint ?? null,
          input.trust,
          input.shares ?? 'basic',
          input.knock ? JSON.stringify(input.knock) : null,
          new Date().toISOString(),
        );
      this.store.append('peer.updated', id, { id, trust: input.trust, created: true }, 'federation');
      return this.getPeer(id)!;
    });
    return peer;
  }

  updatePeer(id: string, patch: PeerPatch, actor = 'federation'): Peer {
    return this.store.transact(() => {
      const old = this.getPeer(id);
      if (!old) throw new Error(`peer ${id} not found`);
      const sets: string[] = [];
      const values: (string | number | null)[] = [];
      const set = (col: string, v: string | number | null) => (sets.push(`${col} = ?`), values.push(v));
      if (patch.label !== undefined) set('label', patch.label);
      if (patch.swarmId !== undefined) set('swarm_id', patch.swarmId);
      if (patch.name !== undefined) set('name', patch.name);
      if (patch.publicKey !== undefined) set('public_key', patch.publicKey);
      if (patch.fingerprint !== undefined) set('fingerprint', patch.fingerprint);
      if (patch.address !== undefined) set('address_json', patch.address ? JSON.stringify(patch.address) : null);
      if (patch.expectedFingerprint !== undefined) set('expected_fingerprint', patch.expectedFingerprint);
      if (patch.trust !== undefined) set('trust', patch.trust);
      if (patch.shares !== undefined) set('shares', patch.shares);
      if (patch.autoAccept !== undefined) set('auto_accept', patch.autoAccept ? 1 : 0);
      if (patch.caps !== undefined) set('caps_json', JSON.stringify(patch.caps));
      if (patch.enabled !== undefined) set('enabled', patch.enabled ? 1 : 0);
      if (patch.knock !== undefined) set('knock_json', patch.knock ? JSON.stringify(patch.knock) : null);
      if (patch.lastContactAt !== undefined) set('last_contact_at', patch.lastContactAt);
      if (patch.lastError !== undefined) set('last_error', patch.lastError);
      if (patch.directoryHash !== undefined) set('directory_hash', patch.directoryHash);
      if (!sets.length) return old;
      this.db.prepare(`UPDATE fed_peers SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
      const next = this.getPeer(id)!;
      // Contact bookkeeping (a timestamp or an error line) is not worth an event; changes of state are.
      const quiet = Object.keys(patch).every((k) => k === 'lastContactAt' || k === 'lastError' || k === 'directoryHash');
      if (!quiet) this.store.append('peer.updated', id, { id, trust: next.trust, patch: Object.keys(patch) }, actor);
      return next;
    });
  }

  directoryHash(peerId: string): string | null {
    const r = this.db.prepare('SELECT directory_hash FROM fed_peers WHERE id = ?').get(peerId) as Row | undefined;
    return r ? str(r.directory_hash) : null;
  }

  deletePeer(id: string, actor = 'federation'): void {
    this.store.transact(() => {
      this.db.prepare('DELETE FROM fed_peer_projects WHERE peer_id = ?').run(id);
      this.db.prepare('DELETE FROM fed_peers WHERE id = ?').run(id);
      this.store.append('peer.updated', id, { id, removed: true }, actor);
    });
  }

  /** Folds peer `dropId` into `keepId` (the same swarm known two ways): its requests move over, its cached projects go. */
  mergePeers(keepId: string, dropId: string): void {
    this.store.transact(() => {
      this.db.prepare('UPDATE fed_requests SET peer_id = ? WHERE peer_id = ?').run(keepId, dropId);
      this.db.prepare('DELETE FROM fed_peer_projects WHERE peer_id = ?').run(dropId);
      this.db.prepare('DELETE FROM fed_peers WHERE id = ?').run(dropId);
      this.store.append('peer.updated', keepId, { id: keepId, merged: dropId }, 'federation');
    });
  }

  pendingKnockCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM fed_peers WHERE trust = 'pending'").get() as Row).n);
  }

  // --- cached peer projects

  replacePeerProjects(peerId: string, cards: ProjectCard[]): void {
    this.store.transact(() => {
      this.db.prepare('DELETE FROM fed_peer_projects WHERE peer_id = ?').run(peerId);
      const insert = this.db.prepare('INSERT INTO fed_peer_projects (peer_id, project_id, card_json, received_at) VALUES (?, ?, ?, ?)');
      const now = new Date().toISOString();
      for (const card of cards) insert.run(peerId, card.id, JSON.stringify(card), now);
      this.store.append('peer.updated', peerId, { id: peerId, projects: cards.length }, 'federation');
    });
  }

  listPeerProjects(peerId?: string): PeerProject[] {
    const rows = (peerId
      ? this.db.prepare('SELECT * FROM fed_peer_projects WHERE peer_id = ? ORDER BY project_id').all(peerId)
      : this.db.prepare('SELECT * FROM fed_peer_projects ORDER BY peer_id, project_id').all()) as Row[];
    return rows.map((r) => ({ peerId: String(r.peer_id), card: json<ProjectCard>(r.card_json)!, receivedAt: String(r.received_at) }));
  }

  // --- shared projects (ours)

  getShared(boardId: string): SharedProject | undefined {
    const r = this.db
      .prepare('SELECT b.id AS board_id, b.name AS board_name, s.visibility, s.draft_json, s.draft_source, s.published_json, s.published_at FROM boards b LEFT JOIN fed_shared s ON s.board_id = b.id WHERE b.id = ?')
      .get(boardId) as Row | undefined;
    return r && toShared(r);
  }

  listShared(): SharedProject[] {
    const rows = this.db
      .prepare('SELECT b.id AS board_id, b.name AS board_name, s.visibility, s.draft_json, s.draft_source, s.published_json, s.published_at FROM boards b LEFT JOIN fed_shared s ON s.board_id = b.id ORDER BY b.created_at')
      .all() as Row[];
    return rows.map(toShared);
  }

  saveDraft(boardId: string, card: ProjectCard, source: 'fastlane' | 'orchestrator' | 'manual'): SharedProject {
    return this.store.transact(() => {
      this.db
        .prepare("INSERT INTO fed_shared (board_id, visibility, draft_json, draft_source) VALUES (?, 'none', ?, ?) ON CONFLICT(board_id) DO UPDATE SET draft_json = excluded.draft_json, draft_source = excluded.draft_source")
        .run(boardId, JSON.stringify(card), source);
      this.store.append('project.updated', boardId, { boardId, draft: true, source }, 'federation');
      return this.getShared(boardId)!;
    });
  }

  publish(boardId: string, card: ProjectCard, visibility: Visibility): SharedProject {
    return this.store.transact(() => {
      this.db
        .prepare(
          `INSERT INTO fed_shared (board_id, visibility, published_json, published_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(board_id) DO UPDATE SET visibility = excluded.visibility, published_json = excluded.published_json, published_at = excluded.published_at`,
        )
        .run(boardId, visibility, JSON.stringify(card), new Date().toISOString());
      this.store.append('project.updated', boardId, { boardId, published: true, visibility }, 'user:local');
      return this.getShared(boardId)!;
    });
  }

  /** Stops sharing: the published card and its visibility are cleared (the draft stays). */
  unpublish(boardId: string): SharedProject {
    return this.store.transact(() => {
      this.db.prepare("UPDATE fed_shared SET visibility = 'none', published_json = NULL, published_at = NULL WHERE board_id = ?").run(boardId);
      this.store.append('project.updated', boardId, { boardId, published: false }, 'user:local');
      return this.getShared(boardId)!;
    });
  }

  // --- requests

  private requestSelect = 'SELECT r.*, p.name AS peer_name_raw, COALESCE(p.name, p.label) AS peer_name FROM fed_requests r JOIN fed_peers p ON p.id = r.peer_id';

  getRequest(id: string): FedRequest | undefined {
    const r = this.db.prepare(`${this.requestSelect} WHERE r.id = ?`).get(id) as Row | undefined;
    return r && toRequest(r);
  }

  requestByRemote(peerId: string, direction: 'in' | 'out', remoteId: string): FedRequest | undefined {
    const r = this.db.prepare(`${this.requestSelect} WHERE r.peer_id = ? AND r.direction = ? AND r.remote_id = ?`).get(peerId, direction, remoteId) as Row | undefined;
    return r && toRequest(r);
  }

  /** Of these outbound request ids, the ones still unresolved: not yet landed, finished, declined or withdrawn. */
  openWaits(ids: string[]): FedRequest[] {
    return ids.map((id) => this.getRequest(id)).filter((r): r is FedRequest => !!r && !['landed', 'done', 'declined', 'cannot_reproduce', 'cancelled'].includes(r.status));
  }

  requestByApproval(approvalId: string): FedRequest | undefined {
    const r = this.db.prepare(`${this.requestSelect} WHERE r.approval_id = ?`).get(approvalId) as Row | undefined;
    return r && toRequest(r);
  }

  /** Outbound requests a card waits for. */
  requestsWaitedBy(cardId: string): FedRequest[] {
    return (this.db.prepare(`${this.requestSelect} WHERE r.direction = 'out' AND r.card_id = ?`).all(cardId) as Row[]).map(toRequest);
  }

  requestByCard(cardId: string): FedRequest | undefined {
    const r = this.db.prepare(`${this.requestSelect} WHERE r.card_id = ? AND r.direction = 'in'`).get(cardId) as Row | undefined;
    return r && toRequest(r);
  }

  listRequests(opts: { direction?: 'in' | 'out'; peerId?: string; statuses?: RequestStatus[]; limit?: number } = {}): FedRequest[] {
    const where: string[] = [];
    const values: (string | number)[] = [];
    if (opts.direction) (where.push('r.direction = ?'), values.push(opts.direction));
    if (opts.peerId) (where.push('r.peer_id = ?'), values.push(opts.peerId));
    if (opts.statuses?.length) (where.push(`r.status IN (${opts.statuses.map(() => '?').join(', ')})`), values.push(...opts.statuses));
    const sql = `${this.requestSelect}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY r.created_at DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...values, opts.limit ?? 200) as Row[]).map(toRequest);
  }

  countRequests(peerId: string, direction: 'in' | 'out', sinceIso: string, statuses?: RequestStatus[]): number {
    const status = statuses?.length ? ` AND status IN (${statuses.map(() => '?').join(', ')})` : '';
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM fed_requests WHERE peer_id = ? AND direction = ? AND created_at >= ?${status}`).get(peerId, direction, sinceIso, ...(statuses ?? [])) as Row).n);
  }

  createRequest(input: NewRequest, actor = 'federation'): FedRequest {
    return this.store.transact(() => {
      const id = newId('fr');
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO fed_requests (id, direction, peer_id, remote_id, title, description, project, blocking, acceptance_json, milestones_json, budget_json, status, thread_json, origin_json, board_id, card_id, approval_id, auto, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.direction,
          input.peerId,
          input.remoteId ?? null,
          input.title,
          input.description,
          input.project ?? null,
          input.blocking ? 1 : 0,
          JSON.stringify(input.acceptance ?? []),
          JSON.stringify(input.milestones ?? []),
          input.budget ? JSON.stringify(input.budget) : null,
          input.status,
          JSON.stringify(input.thread ?? []),
          JSON.stringify(input.origin),
          input.boardId ?? null,
          input.cardId ?? null,
          input.approvalId ?? null,
          input.auto ? 1 : 0,
          now,
          now,
        );
      const request = this.getRequest(id)!;
      this.store.append('request.updated', id, { id, direction: request.direction, peerId: request.peerId, status: request.status, created: true }, actor);
      return request;
    });
  }

  updateRequest(id: string, patch: RequestPatch, actor = 'federation'): FedRequest {
    return this.store.transact(() => {
      const old = this.getRequest(id);
      if (!old) throw new Error(`request ${id} not found`);
      const sets: string[] = ['updated_at = ?'];
      const values: (string | number | null)[] = [new Date().toISOString()];
      const set = (col: string, v: string | number | null) => (sets.push(`${col} = ?`), values.push(v));
      if (patch.remoteId !== undefined) set('remote_id', patch.remoteId);
      if (patch.status !== undefined) set('status', patch.status);
      if (patch.resolution !== undefined) set('resolution_json', patch.resolution ? JSON.stringify(patch.resolution) : null);
      if (patch.thread !== undefined) set('thread_json', JSON.stringify(patch.thread));
      if (patch.boardId !== undefined) set('board_id', patch.boardId);
      if (patch.cardId !== undefined) set('card_id', patch.cardId);
      if (patch.milestonesDone !== undefined) set('milestones_done_json', JSON.stringify(patch.milestonesDone));
      if (patch.budget !== undefined) set('budget_json', patch.budget ? JSON.stringify(patch.budget) : null);
      if (patch.approvalId !== undefined) set('approval_id', patch.approvalId);
      if (patch.auto !== undefined) set('auto', patch.auto ? 1 : 0);
      this.db.prepare(`UPDATE fed_requests SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
      const next = this.getRequest(id)!;
      this.store.append('request.updated', id, { id, direction: next.direction, peerId: next.peerId, status: next.status, from: old.status }, actor);
      return next;
    });
  }
}

function toShared(r: Row): SharedProject {
  const draft = json<ProjectCard>(r.draft_json);
  const published = json<ProjectCard>(r.published_json);
  const strip = (c: ProjectCard | null) => (c ? JSON.stringify({ ...c, updatedAt: '' }) : '');
  return {
    boardId: String(r.board_id),
    boardName: String(r.board_name),
    visibility: (r.visibility ?? 'none') as Visibility,
    draft,
    draftSource: str(r.draft_source) as SharedProject['draftSource'],
    published,
    publishedAt: str(r.published_at),
    dirty: !!draft && !!published && strip(draft) !== strip(published),
  };
}
