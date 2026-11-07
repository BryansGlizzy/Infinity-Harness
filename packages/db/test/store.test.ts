import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonEvent } from '@mh/core';
import { Store } from '../src/index.ts';

test('boards, cards and sessions round-trip and every mutation is logged', () => {
  const store = new Store(':memory:');
  const seen: DaemonEvent[] = [];
  store.onEvent((e) => seen.push(e));

  const board = store.createBoard({ name: 'Demo', repoPath: '/tmp/repo', defaultBranch: 'main' });
  const card = store.createCard({ boardId: board.id, title: 'Add login', description: 'JWT' });
  assert.equal(card.status, 'backlog');

  const moved = store.updateCard(card.id, { status: 'ready', branch: 'mh/add-login' });
  assert.equal(moved.status, 'ready');
  assert.equal(moved.branch, 'mh/add-login');
  assert.equal(moved.title, 'Add login');

  const session = store.createSession({ cardId: card.id, poolId: 'nim', harness: 'opencode', model: 'nvidia/x' });
  store.updateSession(session.id, { state: 'running', vendorSessionId: 'v1' });
  const ended = store.updateSession(session.id, { state: 'ended' });
  assert.equal(ended.vendorSessionId, 'v1');
  assert.ok(ended.endedAt);

  store.append('session.event', card.id, { sessionId: session.id, event: { type: 'message', role: 'agent', text: 'hi' } });

  assert.deepEqual(
    seen.map((e) => e.type),
    ['board.created', 'card.created', 'card.updated', 'session.started', 'session.ended', 'session.event'],
  );
  const cardEvents = store.eventsFor(card.id);
  assert.equal(cardEvents.length, 5);
  assert.deepEqual(store.eventsFor(card.id, cardEvents[2]!.seq).map((e) => e.type), ['session.ended', 'session.event']);
  assert.deepEqual(store.listCards(board.id).map((c) => c.id), [card.id]);
});

test('a failed mutation rolls back and emits nothing', () => {
  const store = new Store(':memory:');
  const seen: DaemonEvent[] = [];
  store.onEvent((e) => seen.push(e));
  assert.throws(() => store.updateCard('c_missing', { status: 'done' }), /not found/);
  assert.equal(seen.length, 0);
  assert.equal(store.eventsFor('c_missing').length, 0);
});

test('tree: depth, children, inherited routing rules, and acyclic dependencies', () => {
  const store = new Store(':memory:');
  const board = store.createBoard({ name: 'Tree', repoPath: '/r', defaultBranch: 'main' });
  const root = store.createCard({ boardId: board.id, title: 'Goal', role: 'orchestrator', routing: { avoid: ['claude'] } });
  const a = store.createCard({ boardId: board.id, title: 'A', parentId: root.id, workType: 'feature', createdBy: `card:${root.id}` });
  const b = store.createCard({ boardId: board.id, title: 'B', parentId: root.id });
  const a1 = store.createCard({ boardId: board.id, title: 'A1', parentId: a.id, routing: { pools: ['nim'] } });

  assert.equal(root.role, 'orchestrator');
  assert.deepEqual([root.depth, a.depth, a1.depth], [0, 1, 2]);
  assert.deepEqual(store.children(root.id).map((c) => c.title), ['A', 'B']);
  assert.equal(store.getCard(a.id)!.workType, 'feature');
  assert.equal(store.countCreatedBy(`card:${root.id}`, new Date(0).toISOString()), 1);
  assert.deepEqual(store.effectiveRouting(b.id), { avoid: ['claude'] });
  assert.deepEqual(store.effectiveRouting(a1.id), { pools: ['nim'] });
  assert.throws(() => store.createCard({ boardId: board.id, title: 'orphan', parentId: 'c_nope' }), /parent card/);

  store.addDependency(b.id, a.id);
  store.addDependency(a1.id, b.id);
  assert.throws(() => store.addDependency(a.id, a1.id), /cycle/);
  assert.throws(() => store.addDependency(a.id, a.id), /cannot block itself/);
  assert.deepEqual(store.blockers(b.id).map((c) => c.id), [a.id]);
  assert.equal(store.dependencies(board.id).length, 2);

  const classification = { workType: 'bugfix' as const, workTypeProbs: {}, complexity: 1.2, complexityProbs: {}, needsReview: 0.3, source: 'kev' as const, at: 'now' };
  assert.deepEqual(store.updateCard(b.id, { classification }).classification, classification);
  assert.equal(store.updateCard(b.id, { classification: null }).classification, null);
});

test('settings default per board and merge partial updates', () => {
  const store = new Store(':memory:');
  const board = store.createBoard({ name: 'S', repoPath: '/r', defaultBranch: 'main' });
  assert.equal(store.getSettings(board.id).maxDepth, 5);
  const s = store.updateSettings(board.id, { poolSlots: { nim: 7 }, permissions: { worker: { canCreateCards: true, canAddDependencies: false } } as any });
  assert.equal(s.poolSlots.nim, 7);
  assert.equal(s.poolSlots.kimi, 2);
  assert.equal(s.permissions.worker.canCreateCards, true);
  assert.equal(s.permissions.orchestrator.canCreateCards, true);
  assert.equal(store.getSettings(board.id).poolSlots.nim, 7);
});

test('settings saved before agent profiles: the old orchestrator pool and model become the orchestrator agent', () => {
  const store = new Store(':memory:');
  const board = store.createBoard({ name: 'L', repoPath: '/r', defaultBranch: 'main' });
  store.db.prepare('INSERT INTO settings (board_id, settings_json) VALUES (?, ?)').run(board.id, JSON.stringify({ orchestrator: { poolId: 'agy', model: 'gemini-4-argon' } }));
  const s = store.getSettings(board.id);
  assert.deepEqual(s.agents, [{ id: 'orchestrator', poolId: 'agy', model: 'gemini-4-argon', role: 'orchestrator', delegatesTo: [], enabled: true }]);
  assert.equal('orchestrator' in s, false);
  assert.equal(s.permissions.lead.canCreateCards, true);
  const card = store.createCard({ boardId: board.id, title: 'x', role: 'lead' });
  assert.equal(store.updateCard(card.id, { agentId: 'sonnet-lead' }).agentId, 'sonnet-lead');
});

test('migrations are applied once and data survives reopening', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mh-db-')), 'test.db');
  const first = new Store(file);
  const board = first.createBoard({ name: 'Persist', repoPath: '/r', defaultBranch: 'main' });
  first.close();
  const second = new Store(file);
  assert.equal(second.getBoard(board.id)?.name, 'Persist');
  second.close();
});
