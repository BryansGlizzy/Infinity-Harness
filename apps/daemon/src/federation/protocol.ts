// What may be on the wire between swarms, and how it is cleaned on arrival. Everything a peer sends is untrusted text:
// it is size-capped, stripped of control characters and rebuilt field by field, never stored or passed on as received.
import { createHash } from 'node:crypto';
import { PROJECT_LIMITS, REQUEST_LIMITS, type ProjectCard, type RequestBudget, type RequestResolution, type RequestStatus, type RequestStatusWire, type RequestWire, type ThreadEntry, type Visibility, REQUEST_STATUSES } from '@ih/core';

const L = PROJECT_LIMITS;

/** Text with control characters removed (newlines and tabs kept), trimmed and capped. */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, max);
}

/** One line: whitespace collapsed. */
export const cleanLine = (v: unknown, max: number = L.line) => cleanText(v, max).replace(/\s+/g, ' ');

export function cleanList(v: unknown, maxItems: number = L.list, maxItem: number = L.item): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => cleanLine(x, maxItem))
    .filter(Boolean)
    .slice(0, maxItems);
}

const ID = /^[A-Za-z0-9_.:-]{1,80}$/;
export const validId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);

export function cleanProjectCard(raw: unknown): ProjectCard | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!validId(r.id)) return null;
  const name = cleanLine(r.name, 120);
  if (!name) return null;
  const accepts = (r.accepts && typeof r.accepts === 'object' ? r.accepts : {}) as Record<string, unknown>;
  return {
    id: r.id,
    name,
    oneLine: cleanLine(r.oneLine),
    about: cleanText(r.about, L.text),
    provides: cleanList(r.provides),
    uses: cleanList(r.uses),
    stack: cleanList(r.stack, 20, 60),
    accepts: { requests: accepts.requests === true, note: cleanLine(accepts.note, 400) },
    version: r.version == null ? null : cleanLine(r.version, 60) || null,
    lastCommit: r.lastCommit == null ? null : cleanLine(r.lastCommit, 60) || null,
    recent: cleanList(r.recent, 20, 140),
    updatedAt: cleanLine(r.updatedAt, 40),
  };
}

export function cleanProjects(raw: unknown): ProjectCard[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ProjectCard[] = [];
  for (const item of raw.slice(0, L.projects)) {
    const card = cleanProjectCard(item);
    if (card && !seen.has(card.id)) (seen.add(card.id), out.push(card));
  }
  return out;
}

export interface Hello {
  name: string;
  projects: ProjectCard[];
}

export function cleanHello(raw: unknown): Hello | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = cleanLine(r.name, 60);
  if (!name) return null;
  return { name, projects: cleanProjects(r.projects) };
}

// --- visibility

const ORDER: Record<Visibility, number> = { none: 0, basic: 1, full: 2 };
export const minVisibility = (a: Visibility, b: Visibility): Visibility => (ORDER[a] <= ORDER[b] ? a : b);

/** The card as a peer with `vis` may see it. Basic: id, name, one line, what it provides, whether it takes requests. */
export function redact(card: ProjectCard, vis: Visibility): ProjectCard | null {
  if (vis === 'none') return null;
  if (vis === 'full') return card;
  return {
    id: card.id,
    name: card.name,
    oneLine: card.oneLine,
    about: '',
    provides: card.provides,
    uses: [],
    stack: [],
    accepts: { requests: card.accepts.requests, note: '' },
    version: null,
    lastCommit: null,
    recent: [],
    updatedAt: card.updatedAt,
  };
}

export function directoryHash(cards: ProjectCard[]): string {
  return createHash('sha256').update(JSON.stringify(cards.map((c) => [c.id, { ...c, updatedAt: '' }]))).digest('hex').slice(0, 24);
}

// --- requests

export function cleanBudget(raw: unknown): RequestBudget | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
  const budget: RequestBudget = {};
  const usd = num(r.maxUsd);
  const tokens = num(r.maxTokens);
  if (usd !== undefined) budget.maxUsd = usd;
  if (tokens !== undefined) budget.maxTokens = Math.floor(tokens);
  return Object.keys(budget).length ? budget : null;
}

/** A request as a peer sent it, or why it is refused. */
export function cleanRequestWire(raw: unknown): RequestWire | string {
  if (!raw || typeof raw !== 'object') return 'a request is a JSON object';
  const r = raw as Record<string, unknown>;
  if (!validId(r.id)) return 'the request needs an id';
  const title = cleanLine(r.title, REQUEST_LIMITS.title);
  const description = cleanText(r.description, REQUEST_LIMITS.description);
  if (title.length < 3) return 'the request needs a title';
  if (!description) return 'the request needs a description';
  const origin = (r.origin && typeof r.origin === 'object' ? r.origin : {}) as Record<string, unknown>;
  const hops = Array.isArray(origin.hops) ? origin.hops.filter(validId).slice(0, REQUEST_LIMITS.hops + 1) : [];
  if (Array.isArray(origin.hops) && origin.hops.length > REQUEST_LIMITS.hops) return `the request has passed through too many swarms (limit ${REQUEST_LIMITS.hops})`;
  return {
    id: r.id,
    title,
    description,
    project: r.project == null ? null : validId(r.project) ? r.project : null,
    blocking: r.blocking === true,
    acceptance: cleanList(r.acceptance, REQUEST_LIMITS.acceptance, REQUEST_LIMITS.item),
    milestones: cleanList(r.milestones, REQUEST_LIMITS.milestones, REQUEST_LIMITS.item),
    budget: cleanBudget(r.budget),
    origin: { cardId: validId(origin.cardId) ? origin.cardId : null, hops },
  };
}

export function cleanResolution(raw: unknown): RequestResolution | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const ref = cleanLine(r.ref, 300);
  const note = cleanText(r.note, REQUEST_LIMITS.description); // an answer can be a whole document
  if (!ref && !note) return null;
  return { ...(ref ? { ref } : {}), ...(note ? { note } : {}) };
}

export function cleanThread(raw: unknown): ThreadEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(-REQUEST_LIMITS.thread)
    .map((e): ThreadEntry | null => {
      if (!e || typeof e !== 'object') return null;
      const x = e as Record<string, unknown>;
      const text = cleanText(x.text, REQUEST_LIMITS.comment);
      if (!text || (x.side !== 'sender' && x.side !== 'receiver')) return null;
      return { side: x.side, at: cleanLine(x.at, 40), text };
    })
    .filter((e): e is ThreadEntry => !!e);
}

export function cleanStatusWire(raw: unknown): RequestStatusWire | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!validId(r.id) || !REQUEST_STATUSES.includes(r.status as RequestStatus)) return null;
  const done = Array.isArray(r.milestonesDone) ? [...new Set(r.milestonesDone.filter((n): n is number => Number.isInteger(n) && n >= 0 && n < REQUEST_LIMITS.milestones))].sort((a, b) => a - b) : [];
  return { id: r.id, status: r.status as RequestStatus, resolution: cleanResolution(r.resolution), thread: cleanThread(r.thread), milestonesDone: done, updatedAt: cleanLine(r.updatedAt, 40) };
}
