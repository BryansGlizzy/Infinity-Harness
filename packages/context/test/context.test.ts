import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '@mh/db';
import { FastLane } from '@mh/fast-lane';
import { ContextService, Embedder, QUERY_PREFIX, cosine, ftsQuery } from '../src/index.ts';

/** Bag-of-words vectors: texts sharing words (or listed synonyms) are similar. Counts calls; can be switched off. */
function fakeEmbeddings(synonyms: Record<string, string> = {}) {
  const state = { calls: 0, down: false, inputs: [] as string[] };
  const dims = 128;
  const vec = (text: string) => {
    const v = new Array(dims).fill(0);
    const body = text.replace(/^task: search result \| query: |^title: [^|]* \| text: /, '');
    for (let w of body.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 2)) {
      w = synonyms[w] ?? w;
      let h = 0;
      for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % dims;
      v[h] += 1;
    }
    return v;
  };
  const fetch = (async (_url: string, init: RequestInit) => {
    state.calls++;
    if (state.down) return new Response('down', { status: 503 });
    const { input } = JSON.parse(String(init.body)) as { input: string[] };
    state.inputs.push(...input);
    return new Response(JSON.stringify({ data: input.map((t, index) => ({ embedding: vec(t), index })) }));
  }) as typeof globalThis.fetch;
  return { state, fetch };
}

function lane(handler: (system: string, input: string) => string) {
  return new FastLane({
    gatewayUrl: 'http://gw',
    token: 't',
    chain: [{ poolId: 'groq', model: 'g' }],
    poolState: () => 'open',
    fetch: (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: handler(body.messages[0].content, body.messages[1].content) } }] }));
    }) as typeof fetch,
  });
}

function boardWithCards(store: Store) {
  const board = store.createBoard({ name: 'b', repoPath: '/tmp/x', defaultBranch: 'main' });
  const root = store.createCard({ boardId: board.id, title: 'Goal', role: 'orchestrator' });
  const a = store.createCard({ boardId: board.id, title: 'Auth module', parentId: root.id });
  const b = store.createCard({ boardId: board.id, title: 'Session API', parentId: root.id });
  const other = store.createCard({ boardId: board.id, title: 'Unrelated goal', role: 'orchestrator' });
  const c = store.createCard({ boardId: board.id, title: 'Docs', parentId: other.id });
  return { board, root, a, b, c };
}

test('ftsQuery: words OR-ed and quoted, stopwords and punctuation dropped', () => {
  assert.equal(ftsQuery('How do we store the JWT token?'), '"store" OR "jwt" OR "token"');
  assert.equal(ftsQuery('a the of'), null);
  assert.equal(ftsQuery('auth', ['login', 'auth']), '"auth" OR "login"');
});

test('artifacts: versions supersede, FTS finds current ones, scopes narrow to the card or its siblings', async () => {
  const store = new Store(':memory:');
  const { board, a, b, c } = boardWithCards(store);
  const ctx = new ContextService({ store, embedder: null, fastLane: null });
  const v1 = ctx.put({ boardId: board.id, cardId: a.id, kind: 'decision', title: 'Token format', body: 'Sessions use opaque tokens stored in redis.', author: `card:${a.id}` });
  const v2 = ctx.put({ boardId: board.id, cardId: a.id, kind: 'decision', title: 'Token format', body: 'Sessions use signed JWT tokens; no redis.', author: `card:${a.id}`, supersedes: v1.id });
  ctx.put({ boardId: board.id, cardId: b.id, kind: 'contract', title: 'Session endpoint', body: 'POST /session returns {token}.', author: `card:${b.id}` });
  ctx.put({ boardId: board.id, cardId: c.id, kind: 'finding', title: 'Docs build', body: 'mkdocs needs the token plugin.', author: `card:${c.id}` });
  await ctx.idle();

  assert.equal(store.getArtifact(v1.id)!.supersededBy, v2.id);
  assert.equal(v2.version, 2);
  const redis = await ctx.search({ boardId: board.id, query: 'redis' });
  assert.deepEqual(redis.map((h) => h.artifact.id), [v2.id], 'the old version is not returned');

  const board_ = await ctx.search({ boardId: board.id, query: 'token', scope: 'board' });
  assert.equal(board_.length, 3);
  const siblings = await ctx.search({ boardId: board.id, query: 'token', cardId: b.id, scope: 'subtree' });
  assert.deepEqual(siblings.map((h) => h.artifact.cardId).sort(), [a.id, b.id].sort());
  const own = await ctx.search({ boardId: board.id, query: 'token', cardId: b.id, scope: 'card' });
  assert.deepEqual(own.map((h) => h.artifact.cardId), [b.id]);
  const kinds = await ctx.search({ boardId: board.id, query: 'token', kinds: ['contract'] });
  assert.deepEqual(kinds.map((h) => h.artifact.kind), ['contract']);
  assert.ok(store.eventsFor(a.id).some((e) => e.type === 'artifact.saved'));
});

test('hybrid search: vectors find a note with no shared words; prefixes are EmbeddingGemma\'s; FTS carries on when embeddings are down', async () => {
  const store = new Store(':memory:');
  const { board, a } = boardWithCards(store);
  const emb = fakeEmbeddings({ login: 'authentication', signin: 'authentication' });
  const embedder = new Embedder({ baseUrl: 'http://emb/v1', model: 'gemma', fetch: emb.fetch });
  const ctx = new ContextService({ store, embedder, fastLane: null, minSimilarity: 0.2 });
  const note = ctx.put({ boardId: board.id, cardId: a.id, kind: 'decision', title: 'Authentication flow', body: 'We chose authentication via OAuth device flow.', author: 'card:x' });
  ctx.put({ boardId: board.id, cardId: a.id, kind: 'finding', title: 'Pagination', body: 'List endpoints page with cursors.', author: 'card:x' });
  await ctx.idle();
  assert.ok(emb.state.inputs.some((t) => t.startsWith('title: Authentication flow | text: ')));

  const hits = await ctx.search({ boardId: board.id, query: 'signin' });
  assert.equal(hits[0]!.artifact.id, note.id);
  assert.deepEqual(hits[0]!.via, ['vector']);
  assert.ok(emb.state.inputs.includes(`${QUERY_PREFIX}signin`));

  emb.state.down = true;
  await assert.rejects(embedder.embedQueries(['x']));
  assert.equal(embedder.up, false);
  const calls = emb.state.calls;
  const text = await ctx.search({ boardId: board.id, query: 'cursors' });
  assert.equal(text[0]!.artifact.title, 'Pagination');
  assert.equal(emb.state.calls, calls, 'no calls while marked down');

  // Saved while down: no vector until a backfill.
  ctx.put({ boardId: board.id, cardId: a.id, kind: 'note', title: 'Later', body: 'Saved while down.', author: 'card:x' });
  await ctx.idle();
  assert.equal(store.unembeddedArtifacts('gemma').length, 1);
  assert.ok(cosine(new Float32Array([1, 0]), new Float32Array([1, 0])) > 0.99);
});

test('fast lane: tagging (#4) adds tags and a summary that search uses; query rewrite (#3) widens recall', async () => {
  const store = new Store(':memory:');
  const { board, a } = boardWithCards(store);
  const seen: string[] = [];
  const fl = lane((system, input) => {
    seen.push(system.slice(0, 20));
    if (system.includes('index notes')) return '{"tags": ["Persistence", "sqlite"], "summary": "Data lives in SQLite via node:sqlite."}';
    if (system.includes('improve search')) return '{"keywords": ["sqlite", "database"], "hypothetical": "We store data in sqlite."}';
    return '';
  });
  const ctx = new ContextService({ store, embedder: null, fastLane: fl });
  const note = ctx.put({ boardId: board.id, cardId: a.id, kind: 'decision', title: 'Storage', body: 'Use the built-in module, no native deps.', author: 'card:x' });
  await ctx.idle();
  const saved = store.getArtifact(note.id)!;
  assert.deepEqual(saved.tags, ['persistence', 'sqlite']);
  assert.equal(saved.summary, 'Data lives in SQLite via node:sqlite.');

  // "where is data persisted" shares no word with the body; the rewrite's keywords hit the tags.
  const hits = await ctx.search({ boardId: board.id, query: 'where is data kept' });
  assert.equal(hits[0]?.artifact.id, note.id);

  store.updateSettings(board.id, { queryRewrite: false, artifactTagging: false });
  const before = seen.length;
  assert.equal((await ctx.search({ boardId: board.id, query: 'kept' })).length, 0);
  ctx.put({ boardId: board.id, cardId: a.id, kind: 'note', title: 'x', body: 'y', author: 'card:x' });
  await ctx.idle();
  assert.equal(seen.length, before, 'both jobs are off');
});
