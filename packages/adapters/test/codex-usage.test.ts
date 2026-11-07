import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexRateLimits } from '../src/index.ts';

const snap = (primary: any, secondary: any, extra: any = {}) => ({ rateLimitsByLimitId: { codex: { primary, secondary, planType: 'plus', ...extra } } });

test('codex usage: 5-hour and weekly windows are told apart by length, resets in ms', () => {
  const rl = parseCodexRateLimits(snap({ usedPercent: 12, windowDurationMins: 300, resetsAt: 1000 }, { usedPercent: 40, windowDurationMins: 10080, resetsAt: 2000 }))!;
  assert.deepEqual(rl.fiveHour, { usedPct: 12, resetsAt: 1_000_000 });
  assert.deepEqual(rl.sevenDay, { usedPct: 40, resetsAt: 2_000_000 });
  assert.equal(rl.reached, false);
  assert.equal(rl.planType, 'plus');
});

test('codex usage: a lone weekly window is not mistaken for the 5-hour one; reached is flagged', () => {
  const rl = parseCodexRateLimits(snap({ usedPercent: 100, windowDurationMins: 10080, resetsAt: 5 }, null, { rateLimitReachedType: 'rate_limit_reached' }))!;
  assert.equal(rl.fiveHour, undefined);
  assert.equal(rl.sevenDay?.usedPct, 100);
  assert.equal(rl.reached, true);
});

test('codex usage: nothing usable gives null', () => {
  assert.equal(parseCodexRateLimits({}), null);
  assert.equal(parseCodexRateLimits(snap(null, null)), null);
});
