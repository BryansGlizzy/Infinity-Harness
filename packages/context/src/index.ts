// Context store (master plan §5.7): artifacts attached to cards, searched with FTS5 and embeddings (hybrid), with
// fast-lane query rewrite (#3) and tagging (#4). FTS alone keeps working whenever the embeddings endpoint is down.
import type { Artifact, ArtifactKind, Settings } from '@mh/core';
import type { NewArtifact, Store } from '@mh/db';
import { queryRewriteJob, readQueryRewrite, readTagging, taggingJob, type FastLane } from '@mh/fast-lane';

export interface EmbedderOptions {
  /** OpenAI-compatible base URL, e.g. http://host:8889/v1 */
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** EmbeddingGemma's task prefixes (master plan §3). */
export const QUERY_PREFIX = 'task: search result | query: ';
export const documentText = (title: string, text: string) => `title: ${title.replace(/\s+/g, ' ').trim() || 'none'} | text: ${text}`;
/** EmbeddingGemma takes 8k tokens; a 20k-character input took ~4 s. */
const MAX_DOC_CHARS = 12_000;

/** Client for an OpenAI-compatible /embeddings endpoint. Vectors are L2-normalized. */
export class Embedder {
  readonly model: string;
  private opts: EmbedderOptions;
  private fetch: typeof fetch;
  /** After a failure, calls are skipped until this time (FTS carries search meanwhile). */
  private downUntil = 0;

  constructor(opts: EmbedderOptions) {
    this.opts = opts;
    this.model = opts.model;
    this.fetch = opts.fetch ?? fetch;
  }

  get up(): boolean {
    return Date.now() >= this.downUntil;
  }

  async embed(inputs: string[]): Promise<Float32Array[]> {
    if (!inputs.length) return [];
    try {
      const res = await this.fetch(`${this.opts.baseUrl.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}) },
        body: JSON.stringify({ model: this.opts.model, input: inputs }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
      });
      if (!res.ok) throw new Error(`embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { data?: { embedding: number[]; index?: number }[] };
      const data = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (data.length !== inputs.length) throw new Error(`embeddings: got ${data.length} vectors for ${inputs.length} inputs`);
      return data.map((d) => normalize(Float32Array.from(d.embedding)));
    } catch (err) {
      this.downUntil = Date.now() + 60_000;
      throw err;
    }
  }

  embedQueries(queries: string[]) {
    return this.embed(queries.map((q) => QUERY_PREFIX + q));
  }

  embedDocuments(docs: { title: string; text: string }[]) {
    return this.embed(docs.map((d) => documentText(d.title, d.text.slice(0, MAX_DOC_CHARS))));
  }
}

export function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  const n = Math.sqrt(sum) || 1;
  for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}

/** Cosine similarity of two normalized vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

const STOPWORDS = new Set(
  'a an and are as at be by for from has have how i in is it its of on or that the this to was we what when where which who why will with do does did you your our use used using should'.split(' '),
);

/** An FTS5 expression: the query's words (and extra keywords) OR-ed, each quoted so punctuation can't break the syntax. */
export function ftsQuery(query: string, extra: string[] = []): string | null {
  const words = [query, ...extra]
    .join(' ')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  const unique = [...new Set(words)].slice(0, 24);
  return unique.length ? unique.map((w) => `"${w}"`).join(' OR ') : null;
}

export type SearchScope = 'card' | 'subtree' | 'board';

export interface SearchQuery {
  boardId: string;
  query: string;
  /** The card searching; scopes are relative to it. */
  cardId?: string | null;
  /** card: that card only; subtree: the card's parent and everything under it (its siblings' work); board: everything. */
  scope?: SearchScope;
  kinds?: ArtifactKind[];
  limit?: number;
}

export interface SearchHit {
  artifact: Artifact;
  /** Fused rank score (reciprocal rank fusion of text and vector ranks). */
  score: number;
  /** Which searches found it. */
  via: ('text' | 'vector')[];
  /** Best cosine similarity, when found by vector search. */
  similarity?: number;
}

export interface ContextDeps {
  store: Store;
  embedder: Embedder | null;
  fastLane: FastLane | null;
  /**
   * Vector hits below this cosine similarity are dropped unless text search also found them. EmbeddingGemma scores
   * unrelated project notes around 0.5–0.65 and real matches about 0.69–0.82 (measured 2026-11-04), hence 0.65.
   */
  minSimilarity?: number;
}

/** See ContextDeps.minSimilarity. */
export const DEFAULT_MIN_SIMILARITY = 0.65;
/** Reciprocal rank fusion constant (the usual 60). */
const RRF_K = 60;

/** Saves artifacts (then tags and embeds them in the background) and searches them. */
export class ContextService {
  private deps: ContextDeps;
  private pending = new Set<Promise<unknown>>();

  constructor(deps: ContextDeps) {
    this.deps = deps;
  }

  private settings(boardId: string): Settings {
    return this.deps.store.getSettings(boardId);
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p)).catch(() => {});
    return p;
  }

  /** Resolves when background tagging and embedding are done (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** Saves an artifact now; tagging (fast lane #4) and its embedding follow in the background. */
  put(input: NewArtifact): Artifact {
    const artifact = this.deps.store.putArtifact(input);
    void this.track(this.enrich(artifact));
    return artifact;
  }

  private async enrich(artifact: Artifact): Promise<void> {
    const { store, fastLane } = this.deps;
    let summary = '';
    if (fastLane?.available && this.settings(artifact.boardId).artifactTagging) {
      const result = await fastLane.run(taggingJob(artifact.kind, artifact.title, artifact.body));
      const meta = result ? readTagging(result.text) : null;
      if (meta) {
        const tags = [...new Set([...artifact.tags, ...meta.tags])];
        store.setArtifactMeta(artifact.id, { tags, summary: meta.summary });
        summary = meta.summary;
      }
    }
    await this.embed([{ ...artifact, summary: summary || artifact.summary }]).catch(() => {});
  }

  private async embed(artifacts: Pick<Artifact, 'id' | 'title' | 'body' | 'summary' | 'tags'>[]): Promise<void> {
    const { embedder, store } = this.deps;
    if (!embedder?.up || !artifacts.length) return;
    const vectors = await embedder.embedDocuments(
      artifacts.map((a) => ({ title: a.title, text: [a.summary, a.tags.length ? `tags: ${a.tags.join(', ')}` : '', a.body].filter(Boolean).join('\n') })),
    );
    artifacts.forEach((a, i) => store.setArtifactEmbedding(a.id, vectors[i]!, embedder.model));
  }

  /** Embeds artifacts saved while the endpoint was down (or with another model). */
  async backfill(batch = 16): Promise<number> {
    const { embedder, store } = this.deps;
    if (!embedder?.up) return 0;
    let done = 0;
    for (;;) {
      const todo = store.unembeddedArtifacts(embedder.model, batch);
      if (!todo.length) return done;
      try {
        await this.embed(todo);
      } catch {
        return done;
      }
      done += todo.length;
      if (todo.length < batch) return done;
    }
  }

  /** Card ids a scope covers, or undefined for the whole board. */
  scopeCards(query: Pick<SearchQuery, 'cardId' | 'scope'>): string[] | undefined {
    const { store } = this.deps;
    const card = query.cardId ? store.getCard(query.cardId) : undefined;
    if (!card || !query.scope || query.scope === 'board') return undefined;
    if (query.scope === 'card') return [card.id];
    return store.subtreeIds(card.parentId ?? card.id);
  }

  /**
   * Hybrid search: FTS5 over title/body/tags/summary and cosine similarity over embeddings, fused by reciprocal
   * rank. The fast lane may add keywords and a hypothetical answer (job #3) to widen both searches.
   */
  async search(q: SearchQuery): Promise<SearchHit[]> {
    const { store, embedder, fastLane } = this.deps;
    const limit = Math.min(q.limit ?? 8, 30);
    const cardIds = this.scopeCards(q);
    const opts = { cardIds, kinds: q.kinds };

    let rewrite: { keywords: string[]; hypothetical: string } | null = null;
    if (fastLane?.available && this.settings(q.boardId).queryRewrite) {
      const result = await fastLane.run(queryRewriteJob(q.query)).catch(() => null);
      rewrite = result ? readQueryRewrite(result.text) : null;
    }

    const ranks = new Map<string, { score: number; via: Set<'text' | 'vector'>; similarity?: number }>();
    const add = (id: string, rank: number, via: 'text' | 'vector', similarity?: number) => {
      const r = ranks.get(id) ?? { score: 0, via: new Set() };
      r.score += 1 / (RRF_K + rank);
      r.via.add(via);
      if (similarity !== undefined) r.similarity = Math.max(r.similarity ?? -1, similarity);
      ranks.set(id, r);
    };

    // The user's own words first; rewrite keywords only widen recall.
    const strict = ftsQuery(q.query);
    const wide = rewrite?.keywords.length ? ftsQuery(q.query, rewrite.keywords) : null;
    const seen = new Set<string>();
    let rank = 0;
    for (const match of [strict, wide]) {
      if (!match) continue;
      for (const hit of store.searchArtifactsText(q.boardId, match, { ...opts, limit: 30 })) {
        if (seen.has(hit.id)) continue;
        seen.add(hit.id);
        add(hit.id, rank++, 'text');
      }
    }

    if (embedder?.up) {
      try {
        const docs = store.artifactEmbeddings(q.boardId, embedder.model, cardIds);
        if (docs.length) {
          const [queryVec] = await embedder.embedQueries([q.query]);
          const probes = [queryVec!];
          if (rewrite?.hypothetical) probes.push(...(await embedder.embedDocuments([{ title: 'none', text: rewrite.hypothetical }])));
          const kinds = q.kinds?.length ? new Set(q.kinds) : null;
          const scored = docs
            .map((d) => ({ id: d.id, sim: Math.max(...probes.map((p) => cosine(p, d.vector))) }))
            .sort((a, b) => b.sim - a.sim);
          const min = this.deps.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
          let vr = 0;
          for (const { id, sim } of scored) {
            if (vr >= 30) break;
            if (kinds && !kinds.has(store.getArtifact(id)!.kind)) continue;
            if (sim < min && !ranks.has(id)) continue;
            add(id, vr++, 'vector', sim);
          }
        }
      } catch {
        // embeddings down: text results stand on their own
      }
    }

    return [...ranks.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, limit)
      .map(([id, r]) => ({
        artifact: store.getArtifact(id)!,
        score: Math.round(r.score * 10_000) / 10_000,
        via: [...r.via],
        ...(r.similarity !== undefined ? { similarity: Math.round(r.similarity * 1000) / 1000 } : {}),
      }));
  }
}
