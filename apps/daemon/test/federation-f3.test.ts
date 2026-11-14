// Swarm federation F3 and F4: auto-accept for a trusted peer within caps, budgets and holds for requests from peers,
// milestones, reopening a landed result, and what the sender has to answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, share, swarm, type Swarm } from './fed-harness.ts';

async function pair() {
  const [a, b] = await Promise.all([swarm('Alpha'), swarm('Beta')]);
  share(b, 'basic');
  const { onA, onB } = await connect(a, b);
  return { a, b, onA, onB, close: () => Promise.all([a.close(), b.close()]) };
}

const settle = () => new Promise((r) => setTimeout(r, 50));
const send = (a: Swarm, peer: string, b: Swarm, extra: Record<string, unknown> = {}) => a.fed.sendRequest(peer, { title: 'Crash on empty input', description: 'parse("") throws', project: b.board.id, ...extra });
/** Usage by one of a swarm's cards, as the harnesses report it. */
const spend = (s: Swarm, cardId: string, tokens: number, costUsd = 0) => s.store.recordUsage({ poolId: 'fa', source: 'otel', boardId: s.board.id, cardId, inputTokens: tokens, outputTokens: 0, costUsd });

test('auto-accept: only a trusted peer, with limits (sensible ones if none are given), and only within them; the humans are told and can still decline', async () => {
  const { a, b, onA, onB, close } = await pair();
  try {
    // Not for a peer that is merely verified, and not without limits.
    assert.throws(() => b.fed.setAutoAccept(onB.id, true, { perRequest: { tokens: 50_000 }, perDay: { tokens: 200_000 } }), /must be trusted first/);
    b.fed.setTrust(onB.id, 'trusted');
    // Switched on without saying how much: sensible limits are filled in, so it just works.
    const dflt = b.fed.setAutoAccept(onB.id, true);
    assert.deepEqual(dflt.caps, { perRequest: { tokens: 300_000 }, perDay: { tokens: 2_000_000 } });
    assert.equal(b.fed.setAutoAccept(onB.id, false).autoAccept, false);
    assert.deepEqual(b.fed.setAutoAccept(onB.id, true, { perRequest: { tokens: 50_000 } }).caps, { perRequest: { tokens: 50_000 }, perDay: { tokens: 2_000_000 } }, 'what is given is kept, the rest filled in');
    const set = b.fed.setAutoAccept(onB.id, true, { perRequest: { tokens: 50_000, usd: -3 }, perDay: { tokens: 120_000 } });
    assert.deepEqual(set.caps, { perRequest: { tokens: 50_000 }, perDay: { tokens: 120_000 } }, 'nonsense limits are dropped');

    // A request within the limits starts at once, with the cap as its budget; a message tells the humans.
    await send(a, onA.id, b);
    await settle();
    const [auto] = b.fed.listRequests({ direction: 'in' });
    assert.equal(auto!.status, 'in_progress', 'no human was asked');
    assert.equal(auto!.auto, true);
    assert.deepEqual(auto!.budget, { maxTokens: 50_000 });
    assert.equal(b.goals.length, 1);
    assert.match(b.goals[0]!.description, /EXTERNAL REQUEST/, 'still marked as outside text');
    const notice = b.store.boardMessages(b.board.id).find((m) => m.fromActor === 'daemon:federation');
    assert.match(notice!.body, /Auto-accepted a request from "Alpha"/);
    assert.match(notice!.body, /ih request decline/);
    assert.match(auto!.thread.at(-1)!.text, /Accepted automatically/);
    await a.fed.pollPeer(onA.id);
    assert.equal(a.fed.listRequests({ direction: 'out' })[0]!.status, 'in_progress');

    // A request asking for more than the cap waits for a person.
    await send(a, onA.id, b, { title: 'A huge piece of work', budget: { maxTokens: 900_000 } });
    const big = b.fed.listRequests({ direction: 'in' }).find((r) => r.title === 'A huge piece of work')!;
    assert.equal(big.status, 'pending');
    assert.equal(big.auto, false);
    // One that names a smaller budget keeps it.
    await send(a, onA.id, b, { title: 'A small fix', budget: { maxTokens: 10_000 } });
    await settle();
    assert.deepEqual(b.fed.listRequests({ direction: 'in' }).find((r) => r.title === 'A small fix')!.budget, { maxTokens: 10_000 });

    // The humans decline an auto-accepted one afterwards: the sender is told and the goal is stopped.
    b.fed.declineRequest(auto!.id, 'we changed our mind');
    assert.deepEqual(b.cancelled, [auto!.cardId, b.fed.listRequests({ direction: 'in' }).find((r) => r.title === 'A small fix')?.cardId].filter((x) => x === auto!.cardId));
    await a.fed.pollPeer(onA.id);
    assert.equal(a.fed.listRequests({ direction: 'out' }).find((r) => r.title === 'Crash on empty input')!.status, 'declined');

    // The day's limit: once most of it is used, new requests wait for a person.
    const goal = b.fed.listRequests({ direction: 'in' }).find((r) => r.title === 'A small fix')!;
    spend(b, goal.cardId!, 110_000);
    await send(a, onA.id, b, { title: 'After the day was spent' });
    assert.equal(b.fed.listRequests({ direction: 'in' }).find((r) => r.title === 'After the day was spent')!.status, 'pending');

    // Losing trust clears it.
    b.fed.setTrust(onB.id, 'verified');
    assert.equal(b.fed.getPeer(onB.id).autoAccept, false);
  } finally {
    await close();
  }
});

test('an untrusted peer never starts anything by itself, whatever the settings say', async () => {
  const { a, b, onA, onB, close } = await pair();
  try {
    // Force the flag on as if the database had been edited: the check at receipt still refuses.
    b.store.fed.updatePeer(onB.id, { autoAccept: true, caps: { perRequest: { tokens: 1000 }, perDay: { tokens: 5000 } } });
    await send(a, onA.id, b);
    await settle();
    const r = b.fed.listRequests({ direction: 'in' })[0]!;
    assert.equal(r.status, 'pending');
    assert.equal(b.goals.length, 0);
  } finally {
    await close();
  }
});

test('budgets: warn at 80%, hold the goal\'s cards at 95%, resume when it is raised; the peer\'s daily cap holds every request of that peer', async () => {
  const { a, b, onA, onB, close } = await pair();
  try {
    await send(a, onA.id, b, { budget: { maxTokens: 1000 } });
    const inbound = b.fed.needs().requests[0]!;
    await b.fed.approveRequest(inbound.id);
    const goal = b.goals[0]!.card;
    const child = b.store.createCard({ boardId: b.board.id, parentId: goal.id, title: 'Patch', role: 'worker', status: 'ready' });

    assert.equal(b.fed.holdReason(child), null);
    spend(b, child.id, 700);
    assert.equal(b.fed.evaluateBudget(b.fed.getRequest(inbound.id)), null);
    spend(b, child.id, 150);
    assert.equal(b.fed.evaluateBudget(b.fed.getRequest(inbound.id)), 'warn');
    assert.ok(b.store.boardMessages(b.board.id).some((m) => /has used 85% of its budget/.test(m.body)));
    assert.equal(b.fed.holdReason(child), null, 'a warning does not stop work');

    spend(b, child.id, 120);
    assert.equal(b.fed.evaluateBudget(b.fed.getRequest(inbound.id)), 'halted');
    assert.match(b.fed.holdReason(child)!, /budget for the request from Alpha is used up/);
    assert.ok(b.store.boardMessages(b.board.id).some((m) => /ih request budget/.test(m.body)));
    assert.match(b.fed.getRequest(inbound.id).thread.at(-1)!.text, /Work is paused/);
    const shown = b.fed.getRequest(inbound.id);
    assert.equal(shown.spent!.tokens, 970);
    assert.equal(shown.spent!.pct, 97);
    // The same state is not announced again.
    const messages = b.store.boardMessages(b.board.id).length;
    b.fed.evaluateBudget(b.fed.getRequest(inbound.id));
    assert.equal(b.store.boardMessages(b.board.id).length, messages);

    // Raising the budget releases the hold.
    b.fed.setBudget(inbound.id, { maxTokens: 5000 });
    assert.equal(b.fed.holdReason(child), null);
    assert.match(b.fed.getRequest(inbound.id).thread.at(-1)!.text, /budget for this request is now 5000 tokens/);

    // The peer's day: a second request is stopped by the daily cap although its own budget is roomy.
    b.fed.setTrust(onB.id, 'trusted');
    b.fed.setAutoAccept(onB.id, false, { perRequest: { tokens: 100_000 }, perDay: { tokens: 1500 } });
    await send(a, onA.id, b, { title: 'Second', budget: { maxTokens: 100_000 } });
    const second = b.fed.listRequests({ direction: 'in' }).find((r) => r.title === 'Second')!;
    await b.fed.approveRequest(second.id);
    const goal2 = b.goals[1]!.card;
    const child2 = b.store.createCard({ boardId: b.board.id, parentId: goal2.id, title: 'More', role: 'worker', status: 'ready' });
    spend(b, child2.id, 600); // 970 + 600 = 1570 of 1500 today
    assert.equal(b.fed.evaluateBudget(b.fed.getRequest(second.id)), 'halted');
    assert.ok(b.store.boardMessages(b.board.id).some((m) => /daily limit/.test(m.body)));
    assert.ok(b.fed.holdReason(child2));
    assert.ok(b.fed.holdReason(child), 'and the first request is held as well, it is the same peer');
    void onA;
  } finally {
    await close();
  }
});

test('milestones: the receiver reports them, the sender sees them', async () => {
  const { a, b, onA, close } = await pair();
  try {
    const sent = await send(a, onA.id, b, { milestones: ['Design', 'Implementation', 'Docs'] });
    const inbound = b.fed.needs().requests[0]!;
    assert.throws(() => b.fed.markMilestone(inbound.id, 7), /numbered 0 to 2/);
    await b.fed.approveRequest(inbound.id);
    b.fed.markMilestone(inbound.id, 0);
    b.fed.markMilestone(inbound.id, 2);
    b.fed.markMilestone(inbound.id, 2); // again: nothing changes
    assert.deepEqual(b.fed.getRequest(inbound.id).milestonesDone, [0, 2]);
    assert.equal(b.fed.getRequest(inbound.id).thread.filter((e) => /Milestone reached/.test(e.text)).length, 2);
    await a.fed.pollPeer(onA.id);
    assert.deepEqual(a.fed.getRequest(sent.id).milestonesDone, [0, 2]);
    b.fed.markMilestone(inbound.id, 0, false);
    await a.fed.pollPeer(onA.id);
    assert.deepEqual(a.fed.getRequest(sent.id).milestonesDone, [2]);
    b.fed.declineRequest(inbound.id, 'stop');
    assert.throws(() => b.fed.markMilestone(inbound.id, 1), /already declined/);
  } finally {
    await close();
  }
});

test('a landed result that is not right is sent back: the request waits for a decision again, or starts again for a trusted peer', async () => {
  const { a, b, onA, onB, close } = await pair();
  try {
    const sent = await send(a, onA.id, b);
    const inbound = b.fed.needs().requests[0]!;
    assert.deepEqual(a.fed.needs().replies, [], 'nothing to answer yet');
    await b.fed.approveRequest(inbound.id);
    await assert.rejects(a.fed.reopenRequest(sent.id, 'not yet'), /only a landed request/);
    b.fed.markLanded(inbound.id, { ref: 'abc1234' });
    await a.fed.pollPeer(onA.id);
    assert.deepEqual(a.fed.needs().replies.map((r) => r.id), [sent.id], 'a person has to confirm or reopen it');
    await assert.rejects(a.fed.reopenRequest(sent.id, ''), /what is still wrong/);

    const reopened = await a.fed.reopenRequest(sent.id, 'it still throws for whitespace-only input');
    assert.equal(reopened.status, 'pending');
    const again = b.fed.getRequest(inbound.id);
    assert.equal(again.status, 'pending');
    assert.equal(again.cardId, null, 'the old goal is not the answer any more');
    assert.match(again.thread.at(-1)!.text, /Reopened: it still throws/);
    assert.deepEqual(b.fed.needs().requests.map((r) => r.id), [inbound.id], 'and it is on the receiving operator\'s list again');
    assert.deepEqual(a.fed.needs().replies, []);
    await b.fed.approveRequest(inbound.id);
    assert.equal(b.goals.length, 2, 'a new goal');

    // For a trusted peer with limits, a reopened request starts by itself.
    b.fed.setTrust(onB.id, 'trusted');
    b.fed.setAutoAccept(onB.id, true, { perRequest: { tokens: 50_000 }, perDay: { tokens: 200_000 } });
    b.fed.markLanded(inbound.id, { ref: 'def5678' });
    await a.fed.pollPeer(onA.id);
    await a.fed.reopenRequest(sent.id, 'one more thing');
    await settle();
    assert.equal(b.fed.getRequest(inbound.id).status, 'in_progress');
    assert.equal(b.goals.length, 3);
  } finally {
    await close();
  }
});

test('questions from the other swarm are waiting for the sender\'s person', async () => {
  const { a, b, onA, close } = await pair();
  try {
    const sent = await send(a, onA.id, b);
    const inbound = b.fed.needs().requests[0]!;
    b.fed.askForInfo(inbound.id, 'Which node version?');
    await a.fed.pollPeer(onA.id);
    assert.deepEqual(a.fed.needs().replies.map((r) => r.id), [sent.id]);
    await a.fed.commentOnRequest(sent.id, 'Node 24');
    assert.deepEqual(a.fed.needs().replies, []);
  } finally {
    await close();
  }
});

test('boards that saved the old "agents\' requests wait for approval" default follow the new one', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Store } = await import('@ih/db');
  const file = join(mkdtempSync(join(tmpdir(), 'ih-mig-')), 'db.sqlite');
  const first = new Store(file);
  const board = first.createBoard({ name: 'Old', repoPath: '/tmp/old', defaultBranch: 'main' });
  first.updateSettings(board.id, { humanReview: true });
  // As the previous version left it: the old default, written into the saved settings, and a person's own choice on another board.
  const other = first.createBoard({ name: 'Other', repoPath: '/tmp/other', defaultBranch: 'main' });
  first.updateSettings(other.id, { humanReview: false });
  first.db.prepare("UPDATE settings SET settings_json = json_set(settings_json, '$.peerRequestApproval', json('true'))").run();
  // Back to just before that migration; later migrations (a message column) run again, so undo what they added.
  first.db.exec('ALTER TABLE messages DROP COLUMN dismissed_at');
  first.db.exec('DROP TABLE pool_ejections');
  first.db.exec('DROP TABLE mcp_library');
  first.db.exec('PRAGMA user_version = 12');
  first.close();
  const again = new Store(file);
  assert.equal(again.getSettings(board.id).peerRequestApproval, false);
  assert.equal(again.getSettings(board.id).humanReview, true, 'nothing else changes');
  again.updateSettings(board.id, { peerRequestApproval: true });
  assert.equal(again.getSettings(board.id).peerRequestApproval, true, 'and choosing it again sticks');
  again.close();
});
