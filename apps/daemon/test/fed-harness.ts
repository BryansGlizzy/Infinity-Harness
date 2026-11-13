// Shared setup for the federation tests: a "swarm" is a real store, a real Federation and a real listener on its own port.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import type { Card, Peer } from '@ih/core';
import { Store } from '@ih/db';
import { generateIdentity } from '../src/federation/identity.ts';
import { buildFedServer } from '../src/federation/routes.ts';
import { Federation, type FederationOptions } from '../src/federation/service.ts';

export async function swarm(name: string, opts: Partial<FederationOptions> = {}) {
  const store = new Store(':memory:');
  const identity = generateIdentity();
  const goals: { boardId: string; title: string; description: string; card: Card }[] = [];
  const cancelled: string[] = [];
  const fed = new Federation({
    store,
    identity,
    eager: false,
    pollMs: 3_600_000,
    startGoal: async (boardId, title, description) => {
      const card = store.createCard({ boardId, title, description, role: 'orchestrator', status: 'in_progress' });
      goals.push({ boardId, title, description, card });
      return card;
    },
    cancelCard: (id) => cancelled.push(id),
    ...opts,
  });
  fed.updateSettings({ name });
  const app = await buildFedServer(fed);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const board = store.createBoard({ name: `${name} project`, repoPath: tmpdir(), defaultBranch: 'main' });
  return {
    name,
    store,
    fed,
    app,
    url,
    goals,
    cancelled,
    board,
    identity,
    close: async () => {
      fed.stop();
      await app.close();
    },
  };
}
export type Swarm = Awaited<ReturnType<typeof swarm>>;

/** Gives a swarm a project card and publishes it. */
export function share(s: Swarm, visibility: 'basic' | 'full', card: Record<string, unknown> = {}) {
  s.fed.saveDraft(s.board.id, { name: s.name, oneLine: `${s.name} does things`, about: `About ${s.name}. Private detail.`, provides: [`@${s.name}/pkg`], uses: ['left-pad'], stack: ['node'], accepts: { requests: true, note: 'bugs welcome' }, version: '1.2.3', lastCommit: 'abc123', recent: ['Fix a thing'], ...card }, 'manual');
  return s.fed.publish(s.board.id, visibility);
}

/** A connects out to B; B's operator accepts; A's next round is answered. */
export async function connect(a: Swarm, b: Swarm, opts: { label?: string } = {}): Promise<{ onA: Peer; onB: Peer }> {
  const added = a.fed.addPeer({ label: opts.label ?? b.name, url: b.url });
  await a.fed.pollPeer(added.id);
  const knock = b.fed.listPeers().find((p) => p.trust === 'pending');
  assert.ok(knock, 'B got a knock');
  b.fed.decideKnock(knock.id, 'approve');
  await a.fed.pollPeer(added.id);
  return { onA: a.fed.getPeer(added.id), onB: b.fed.getPeer(knock.id) };
}

