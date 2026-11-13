// Where a click on a "Messages for you" entry goes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageTarget } from '../src/messageTarget.ts';

const cards = [{ id: 'c_0123456789ab' }, { id: 'c_ba9876543210' }];

test('an agent\'s message opens its own card', () => {
  assert.deepEqual(messageTarget({ fromActor: 'card:c_0123456789ab', body: 'Blocked: no network' }, cards), { kind: 'card', cardId: 'c_0123456789ab', label: 'Open the card' });
});

test('a daemon message opens the card named in its text, even when the sender is not a card', () => {
  const t = messageTarget({ fromActor: 'daemon:refinery', body: 'Card "Add login" (c_ba9876543210) needs you: tests fail' }, cards);
  assert.deepEqual(t, { kind: 'card', cardId: 'c_ba9876543210', label: 'Open the card' });
  assert.equal(messageTarget({ fromActor: 'daemon:refinery', body: 'Card (c_ffffffffffff) was removed' }, cards).kind, 'none', 'a card that no longer exists is not a target');
});

test('daemon messages without a card go to the place that fixes them', () => {
  assert.deepEqual(messageTarget({ fromActor: 'daemon:setup', body: 'The worktree setup command failed' }, cards), { kind: 'settings', tab: 'refinery', label: 'Open Settings → Refinery' });
  assert.equal(messageTarget({ fromActor: 'daemon:budget', body: 'Board budget at 80%' }, cards).kind, 'settings');
  assert.equal(messageTarget({ fromActor: 'daemon:approvals', body: 'Could not install x' }, cards).kind, 'approvals');
  assert.equal(messageTarget({ fromActor: 'daemon:federation', body: 'A peer asked' }, cards).kind, 'swarms');
  assert.equal(messageTarget({ fromActor: 'daemon:health', body: 'Local LLM stopped answering and was taken out of rotation' }, cards).kind, 'agents');
  assert.equal(messageTarget({ fromActor: 'daemon:recovery', body: 'The daemon restarted' }, cards).kind, 'none');
});
