// Swarm federation types (master plan Phase 7). A swarm is one daemon with its boards and agents; peers are other swarms
// it has agreed to cooperate with. Only structured data crosses between them: knocks, project cards, requests.

/**
 * Our decision about a peer. `pending`: it knocked and a human has not decided (quarantined: shown to the operator, to
 * no agent). `verified`: identity accepted, directories flow at basic visibility, every request needs a human.
 * `trusted`: verified plus the operator's flag (full visibility; auto-accept is a later stage). `blocked`: its knocks are ignored.
 */
export const PEER_TRUSTS = ['pending', 'verified', 'trusted', 'blocked'] as const;
export type PeerTrust = (typeof PEER_TRUSTS)[number];

/** What we show a peer of a project (and, per peer, of everything): nothing, name + one line + what it provides, or the whole card. */
export const VISIBILITIES = ['none', 'basic', 'full'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

/** How to reach a peer's federation port: through our own SSH forward, or a plain local URL (the address of their own tunnel). */
export type PeerAddress = { kind: 'ssh'; target: string; sshPort?: number; remotePort: number } | { kind: 'url'; url: string };

export const DEFAULT_FED_PORT = 7422;

/**
 * connecting: the forward is coming up · online: the peer answered · waiting: it answered "pending" (its operator has not
 * accepted us yet) · reconnecting: dropped, retrying · attention: needs a person (login, host key, wrong key) ·
 * stopped: not polled (disabled or blocked) · none: nobody to call (the peer knocked on us and we have no address for it).
 */
export type LinkState = 'none' | 'connecting' | 'online' | 'waiting' | 'reconnecting' | 'attention' | 'stopped';

/** One project a swarm shares. `basic` shows id, name, oneLine, provides and accepts.requests; `full` shows everything. */
export interface ProjectCard {
  /** Stable per project at its owner; peers name it in requests. */
  id: string;
  name: string;
  oneLine: string;
  /** A paragraph on what it is. */
  about: string;
  /** Identities other projects depend on: package names, repository URLs, module paths, APIs. */
  provides: string[];
  uses: string[];
  stack: string[];
  accepts: { requests: boolean; note: string };
  version: string | null;
  lastCommit: string | null;
  /** Titles of recently landed work. */
  recent: string[];
  updatedAt: string;
}

export const PROJECT_LIMITS = { projects: 64, text: 4000, line: 300, list: 60, item: 200 } as const;

/** Our own identity, as peers see it. `swarmId` is derived from the key, so a claimed id cannot disagree with its key. */
export interface SwarmInfo {
  swarmId: string;
  name: string;
  fingerprint: string;
  /** Base64 SPKI DER of the ed25519 public key. */
  publicKey: string;
}

export interface PeerKnock {
  at: string;
  name: string;
  /** What the knocker offered about itself. Inert text for the operator to read; never given to an agent before approval. */
  projects: ProjectCard[];
}

/** A spend limit: dollars (where the harness reports a cost) and/or tokens. */
export interface Spend {
  usd?: number;
  tokens?: number;
}

/** What a trusted peer's requests may spend when they start without asking (auto-accept needs both limits). */
export interface PeerCaps {
  perRequest?: Spend;
  perDay?: Spend;
}

export interface Peer {
  id: string;
  /** Our own alias for it. */
  label: string;
  swarmId: string | null;
  name: string | null;
  publicKey: string | null;
  fingerprint: string | null;
  /** Present when we added it (we call out); absent when it only knocked on us. */
  address: PeerAddress | null;
  /** If the operator typed the fingerprint of the peer they meant to reach, a different key is refused. */
  expectedFingerprint: string | null;
  trust: PeerTrust;
  /** What we show this peer. `full` only takes effect while the peer is trusted. */
  shares: Visibility;
  /** Requests from this peer start without waiting for a person. Only for a trusted peer with `caps` set. */
  autoAccept: boolean;
  caps: PeerCaps;
  enabled: boolean;
  /** The knock waiting for a decision (trust `pending`). */
  knock: PeerKnock | null;
  lastContactAt: string | null;
  lastError: string | null;
  createdAt: string;
  /** Runtime state of our link to it. */
  link: LinkState;
  /** Projects we have cached from it. */
  projects: number;
}

/** A project card received from a peer. Stored read-only and marked with where it came from. */
export interface PeerProject {
  peerId: string;
  card: ProjectCard;
  receivedAt: string;
}

export interface SharedProject {
  boardId: string;
  boardName: string;
  /** Published at this visibility (the most any peer can see). */
  visibility: Visibility;
  draft: ProjectCard | null;
  draftSource: 'fastlane' | 'orchestrator' | 'manual' | null;
  published: ProjectCard | null;
  publishedAt: string | null;
  /** The card has been edited since it was published. */
  dirty: boolean;
}

export type DrafterMode = 'fastlane' | 'orchestrator';

export interface FederationSettings {
  name: string;
  drafter: DrafterMode;
}

export interface FederationState {
  self: SwarmInfo;
  settings: FederationSettings;
  /** Where peers reach us (the federation listener), or null when it is switched off. */
  port: number | null;
  /** The account and machine name this daemon runs under, to suggest the SSH target a peer would use. */
  host: { user: string; name: string };
}

// --- requests

export const REQUEST_STATUSES = ['pending', 'accepted', 'in_progress', 'needs_info', 'landed', 'done', 'declined', 'cannot_reproduce', 'cancelled'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export const REQUEST_FINAL: RequestStatus[] = ['done', 'declined', 'cannot_reproduce', 'cancelled'];

export interface RequestBudget {
  maxUsd?: number;
  maxTokens?: number;
}

/** How a landed request ended: what to take. */
export interface RequestResolution {
  /** Commit, PR URL or version the sender should use. */
  ref?: string;
  note?: string;
}

export interface ThreadEntry {
  /** `sender` is the swarm that filed the request. */
  side: 'sender' | 'receiver';
  at: string;
  text: string;
}

export interface RequestOrigin {
  swarmId: string;
  cardId: string | null;
  /** Swarms the request has passed through, oldest first; it is refused when the receiver is already in it. */
  hops: string[];
}

export interface FedRequest {
  id: string;
  /** `in`: a peer asked us; `out`: we asked a peer. */
  direction: 'in' | 'out';
  peerId: string;
  peerName: string | null;
  /** The other swarm's id for it. */
  remoteId: string | null;
  title: string;
  description: string;
  /** The receiving swarm's project id. */
  project: string | null;
  /** The sender's card waits for the answer. */
  blocking: boolean;
  acceptance: string[];
  milestones: string[];
  budget: RequestBudget | null;
  status: RequestStatus;
  resolution: RequestResolution | null;
  thread: ThreadEntry[];
  /** Indexes into `milestones` the receiver has reached. */
  milestonesDone: number[];
  origin: RequestOrigin;
  /** Outbound, filed by an agent: the approval that must be granted before it is sent. */
  approvalId: string | null;
  /** Inbound: started without a person's approval, because the peer is trusted and has auto-accept. */
  auto: boolean;
  /** Inbound, once approved: what the goal has used so far against the budget. */
  spent?: { usd: number; tokens: number; pct: number | null };
  /** Inbound: the board and the goal card the request became. Outbound: the sender's own card that waits (later stage). */
  boardId: string | null;
  cardId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const REQUEST_LIMITS = { title: 200, description: 20000, comment: 4000, acceptance: 20, milestones: 20, item: 500, hops: 6, thread: 100 } as const;

/** What a sender puts on the wire. */
export interface RequestWire {
  id: string;
  title: string;
  description: string;
  project: string | null;
  blocking: boolean;
  acceptance: string[];
  milestones: string[];
  budget: RequestBudget | null;
  origin: { cardId: string | null; hops: string[] };
}

/** What a receiver answers when asked how a request stands. */
export interface RequestStatusWire {
  id: string;
  status: RequestStatus;
  resolution: RequestResolution | null;
  thread: ThreadEntry[];
  milestonesDone: number[];
  updatedAt: string;
}

/** The peer-related things waiting for a person (a knock, a request to approve), for "Needs you". */
export interface FederationNeeds {
  knocks: Peer[];
  requests: FedRequest[];
  /** Requests we sent that wait for us: a question to answer, or a landed result to confirm or reopen. */
  replies: FedRequest[];
}

/** A project of another swarm that can be named in a prompt as `@swarm/project` (autocompleted by the clients). */
export interface Mention {
  /** What is typed: `@beta/textkit`. */
  token: string;
  /** The peer's label (the part after the `@`) and the swarm's own name. */
  label: string;
  swarm: string;
  peerId: string;
  /** The project's name and id at that swarm. */
  project: string;
  projectId: string;
  oneLine: string;
  provides: string[];
  takesRequests: boolean;
}

// --- the project's files, read-only (the clients' file tree)

export interface FileEntry {
  name: string;
  /** Relative to the root, with `/`. */
  path: string;
  type: 'dir' | 'file' | 'link';
  size: number | null;
  /** For a file in a git repository: `M` modified, `A` added, `D` deleted, `U` untracked. For a folder: `M` when something inside changed. */
  status: 'M' | 'A' | 'D' | 'U' | null;
}

export interface DirListing {
  root: string;
  path: string;
  entries: FileEntry[];
  /** More entries than the cap: the rest are not listed. */
  truncated: boolean;
}

export interface FileContent {
  path: string;
  size: number;
  binary: boolean;
  /** The first part of a file larger than the cap. */
  truncated: boolean;
  content: string;
}
