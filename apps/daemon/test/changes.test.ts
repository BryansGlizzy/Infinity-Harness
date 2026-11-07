import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './harness.ts';

async function until(check: () => boolean, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("changes API: a card's files, diff and file contents, before and after it lands", async () => {
  const { store, scheduler, refinery, board, cfg, close } = await setup();
  try {
    const base = `http://127.0.0.1:${cfg.port}/api`;
    const get = async (path: string) => {
      const res = await fetch(`${base}${path}`);
      return { status: res.status, body: (await res.json()) as any };
    };
    store.updateSettings(board.id, { agents: [{ id: 'fa', poolId: 'fa', model: '', role: 'worker', delegatesTo: [], enabled: true }], crossReview: false, autoLand: false, landMode: 'local' });
    const card = store.createCard({ boardId: board.id, title: 'Write notes', status: 'ready' });

    const empty = await get(`/cards/${card.id}/changes`);
    assert.equal(empty.body.to, null, 'no commits yet');

    scheduler.start();
    await until(() => store.getCard(card.id)!.status === 'review');
    const open = await get(`/cards/${card.id}/changes`);
    assert.equal(open.body.landed, false);
    assert.equal(open.body.base, 'main');
    assert.deepEqual(open.body.files, [{ path: 'notes.md', status: 'A', additions: 1, deletions: 0 }]);
    assert.equal(open.body.commits.length, 1);
    assert.match((await get(`/cards/${card.id}/diff?path=notes.md`)).body.diff, /^\+written by fake\/two$/m);
    assert.equal((await get(`/cards/${card.id}/file?path=notes.md`)).body.content, 'written by fake/two\n', 'exact contents, final newline kept');
    assert.equal((await get(`/cards/${card.id}/file?path=../etc/passwd`)).status, 400);
    assert.equal((await get(`/cards/${card.id}/file?path=missing.md`)).status, 404);

    store.updateSettings(board.id, { autoLand: true });
    refinery.start();
    await until(() => store.getCard(card.id)!.status === 'done');
    const landed = await get(`/cards/${card.id}/changes`);
    assert.equal(landed.body.landed, true);
    assert.equal(landed.body.to, store.getCard(card.id)!.pipeline.landedSha);
    assert.deepEqual(landed.body.files.map((f: { path: string }) => f.path), ['notes.md']);
  } finally {
    await close();
  }
});

test('reasoning: an agent\'s level is set on its sessions; one the harness does not offer is reported and skipped', async () => {
  const { store, scheduler, board, cfg, close } = await setup();
  try {
    const base = `http://127.0.0.1:${cfg.port}/api`;
    const catalog = (await (await fetch(`${base}/models`)).json()) as any;
    assert.deepEqual(catalog.fa.reasoning, { configId: 'thinking', levels: [{ id: 'low', name: 'Thinking Low' }, { id: 'high', name: 'Thinking High' }], current: 'low' });
    store.updateSettings(board.id, {
      agents: [
        { id: 'deep', poolId: 'fa', model: '', reasoning: 'high', role: 'worker', delegatesTo: [], enabled: true },
        { id: 'odd', poolId: 'fb', model: '', reasoning: 'ultra', role: 'worker', delegatesTo: [], enabled: true },
      ],
      crossReview: false,
      autoLand: false,
    });
    assert.equal(store.getSettings(board.id).agents[0]!.reasoning, 'high', 'saved with the agent');
    const a = store.createCard({ boardId: board.id, title: 'Deep one', status: 'ready', routing: { pools: ['deep'] } });
    const b = store.createCard({ boardId: board.id, title: 'Odd one', status: 'ready', routing: { pools: ['odd'] } });
    scheduler.start();
    await until(() => [a, b].every((c) => store.getCard(c.id)!.status === 'review'));
    const text = (id: string) => JSON.stringify(store.eventsFor(id).filter((e) => e.type === 'session.event').map((e) => e.payload));
    assert.match(text(a.id), /thinking=high/);
    assert.doesNotMatch(text(b.id), /thinking=/);
    assert.match(text(b.id), /reasoning level \\"ultra\\" is not offered here \(low, high\); using low/);
  } finally {
    await close();
  }
});
