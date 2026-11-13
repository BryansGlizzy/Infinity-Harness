// The text rules of @swarm/project completion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Mention } from '@ih/core';
import { matchMentions, mentionAt } from '../src/mentionText.ts';

const m = (token: string, swarm: string, project: string): Mention => ({ token, label: swarm.toLowerCase(), swarm, peerId: 'pr_1', project, projectId: 'b_1', oneLine: '', provides: [], takesRequests: false });
const all = [m('@beta/beta-lib', 'Beta', 'Beta Lib'), m('@beta/cli', 'Beta', 'CLI'), m('@gamma/textkit', 'Gamma', 'textkit')];

test('an @ starts a mention only at the start of a word, and only right before the caret', () => {
  assert.deepEqual(mentionAt('check @', 7), { start: 6, query: '' });
  assert.deepEqual(mentionAt('check @be', 9), { start: 6, query: 'be' });
  assert.deepEqual(mentionAt('@beta/be', 8), { start: 0, query: 'beta/be' });
  assert.equal(mentionAt('mail me at a@be', 15), null, 'an e-mail address is not a mention');
  assert.equal(mentionAt('check @beta/beta-lib for deps', 29), null, 'the caret is past the word');
  assert.deepEqual(mentionAt('check @beta/beta-lib for deps', 20), { start: 6, query: 'beta/beta-lib' }, 'the caret inside a word');
  assert.equal(mentionAt('no mention here', 5), null);
  assert.deepEqual(mentionAt('first line\n@g', 13), { start: 11, query: 'g' }, 'after a newline');
});

test('completion offers names that start with what was typed, then names that contain it', () => {
  assert.deepEqual(matchMentions(all, '').map((x) => x.token), ['@beta/beta-lib', '@beta/cli', '@gamma/textkit']);
  assert.deepEqual(matchMentions(all, 'be').map((x) => x.token), ['@beta/beta-lib', '@beta/cli']);
  assert.deepEqual(matchMentions(all, 'beta/c').map((x) => x.token), ['@beta/cli']);
  assert.deepEqual(matchMentions(all, 'text').map((x) => x.token), ['@gamma/textkit'], 'a match inside the name still shows');
  assert.deepEqual(matchMentions(all, 'BETA/BETA').map((x) => x.token), ['@beta/beta-lib'], 'case does not matter');
  assert.deepEqual(matchMentions(all, 'nothing'), []);
  assert.equal(matchMentions(Array.from({ length: 20 }, (_, i) => m(`@b/p${i}`, 'B', `p${i}`)), '').length, 8, 'at most eight');
});
