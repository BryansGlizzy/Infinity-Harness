import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FastLane, cleanNarration, narratorJob, readLint, specLintJob, trimInput } from '../src/index.ts';

const reply = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }));

test('falls back past pools that are not open and pools that fail', async () => {
  const hits: string[] = [];
  const lane = new FastLane({
    gatewayUrl: 'http://gw',
    token: 't',
    chain: [
      { poolId: 'groq', model: 'g' },
      { poolId: 'nim', model: 'n' },
      { poolId: 'local', model: 'l' },
    ],
    poolState: (id) => (id === 'groq' ? 'halted' : 'open'),
    fetch: (async (url: string, init: RequestInit) => {
      hits.push(`${url} ${JSON.parse(String(init.body)).model}`);
      if (url.includes('/p/nim/')) return new Response('busy', { status: 500 });
      return reply('Writing tests for the parser');
    }) as typeof fetch,
  });
  const r = await lane.run(narratorJob('Parser', ['tool edit: parser.ts']));
  assert.deepEqual(r, { text: 'Writing tests for the parser', poolId: 'local', model: 'l' });
  assert.deepEqual(hits, ['http://gw/p/nim/v1/chat/completions n', 'http://gw/p/local/v1/chat/completions l']);
});

test('returns null when nothing is usable, and runs higher-priority jobs first', async () => {
  const none = new FastLane({ gatewayUrl: 'http://gw', token: 't', chain: [{ poolId: 'groq', model: 'g' }], poolState: () => 'locked' });
  assert.equal(await none.run(narratorJob('x', ['a'])), null);

  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const lane = new FastLane({
    gatewayUrl: 'http://gw',
    token: 't',
    concurrency: 1,
    chain: [{ poolId: 'groq', model: 'g' }],
    poolState: () => 'open',
    fetch: (async (_url: string, init: RequestInit) => {
      const system = JSON.parse(String(init.body)).messages[0].content as string;
      order.push(system.startsWith('You narrate') ? 'narrator' : 'lint');
      if (order.length === 1) await gate;
      return reply('{"ok": true}');
    }) as typeof fetch,
  });
  const first = lane.run(specLintJob('a', 'b'));
  const lint = lane.run(specLintJob('c', 'd'));
  const narr = lane.run(narratorJob('e', ['f']));
  release();
  await Promise.all([first, lint, narr]);
  assert.deepEqual(order, ['lint', 'narrator', 'lint']);
});

test('helpers: trimming, narration cleanup, lint parsing fails open', () => {
  const long = 'a'.repeat(50) + 'b'.repeat(50);
  const t = trimInput(long, 40);
  assert.ok(t.length <= 41 && t.startsWith('a') && t.endsWith('b'));
  assert.equal(cleanNarration('"Refactoring the router"\nextra'), 'Refactoring the router');
  assert.deepEqual(readLint('```json\n{"ok": false, "problem": "No acceptance criteria."}\n```'), { ok: false, problem: 'No acceptance criteria.' });
  assert.deepEqual(readLint('I think it is fine'), { ok: true, problem: '' });
});
