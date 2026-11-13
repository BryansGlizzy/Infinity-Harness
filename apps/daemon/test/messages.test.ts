// "Messages for you": clearing them from the attention list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsFrom } from '@ih/client';
import { setup } from './harness.ts';

async function post(port: number, path: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
}

test('messages for the humans can be cleared one by one or all at once, and stay in the log', async () => {
  const { store, board, cfg, close } = await setup();
  try {
    const card = store.createCard({ boardId: board.id, title: 'Needs help', status: 'ready' });
    const human = (body: string) => store.postMessage({ boardId: board.id, fromActor: `card:${card.id}`, toCard: null, body, urgent: false });
    const [a, b, c] = [human('first'), human('second'), human('third')];
    const toCard = store.postMessage({ boardId: board.id, fromActor: 'user:local', toCard: card.id, body: 'hello agent', urgent: false });
    const open = () => store.boardMessages(board.id).filter((m) => m.toCard === null && !m.dismissedAt).map((m) => m.body).sort(); // posted in the same millisecond: order is arbitrary
    assert.deepEqual(open(), ['first', 'second', 'third']);

    const one = await post(cfg.port, `/boards/${board.id}/messages/dismiss`, { ids: [b.id, toCard.id, 'm_nope'] });
    assert.deepEqual(one.body.dismissed, [b.id], 'only messages for the humans that exist and are still open');
    assert.deepEqual(open(), ['first', 'third']);
    assert.equal(store.boardMessages(board.id).find((m) => m.id === toCard.id)!.dismissedAt, null, 'a message to a card is not touched');
    assert.ok(store.eventsFor(board.id).some((e) => e.type === 'message.dismissed' && (e.payload as any).ids[0] === b.id), 'clients hear about it');

    // The attention list that the TUI and VS Code share leaves cleared messages out.
    const needs = (msgs: typeof a[]) => needsFrom({ approvals: [], cards: [card], messages: msgs, outcomes: [], humanReview: false }).filter((n) => n.kind === 'message').map((n) => n.title);
    assert.deepEqual(needs(store.boardMessages(board.id)).sort(), ['first', 'third']);

    const all = await post(cfg.port, `/boards/${board.id}/messages/dismiss`, {});
    assert.deepEqual(all.body.dismissed.sort(), [a.id, c.id].sort());
    assert.deepEqual(open(), []);
    assert.deepEqual((await post(cfg.port, `/boards/${board.id}/messages/dismiss`, {})).body.dismissed, [], 'nothing left to clear');
    assert.equal(store.boardMessages(board.id).length, 4, 'nothing is deleted');
    assert.equal((await post(cfg.port, `/boards/b_missing/messages/dismiss`, {})).status, 404);
    assert.equal((await post(cfg.port, `/boards/${board.id}/messages/dismiss`, { ids: 'x' })).status, 400);
  } finally {
    await close();
  }
});
