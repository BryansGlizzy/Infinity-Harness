import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HarnessEvent } from '@ih/core';
import { AcpAgent, clipOutput, decidePermission, isRepeatedToolUpdate, mapUpdate, toolOutput, permissionPaths, shellPaths } from '../src/index.ts';

const fakeAgent = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));

function agent() {
  return new AcpAgent({ id: 'fake', command: process.execPath, args: [fakeAgent], cwd: tmpdir(), env: process.env });
}

test('decidePermission allows paths inside the worktree and rejects others', () => {
  const cwd = '/work/tree';
  assert.equal(decidePermission({ locations: [{ path: 'src/a.ts' }] }, cwd).allow, true);
  assert.equal(decidePermission({ locations: [{ path: '/work/tree/src/a.ts' }] }, cwd).allow, true);
  assert.equal(decidePermission({ locations: [] }, cwd).allow, true);
  assert.equal(decidePermission({ locations: [{ path: '../other/a.ts' }] }, cwd).allow, false);
  assert.equal(decidePermission({ locations: [{ path: '/work/treehouse/a.ts' }] }, cwd).allow, false);
  assert.equal(decidePermission({ locations: [{ path: 'ok.ts' }, { path: '/etc/passwd' }] }, cwd).allow, false);
});

test('permissionPaths reads locations, diffs, raw input and prose, but not shell command text', () => {
  // Kimi: only prose
  assert.deepEqual(
    permissionPaths({ title: 'Write', content: [{ type: 'content', content: { type: 'text', text: 'Requesting approval to Writing /tmp/out.txt' } }] }),
    ['/tmp/out.txt'],
  );
  assert.equal(
    decidePermission({ title: 'Write', content: [{ type: 'content', content: { type: 'text', text: 'Requesting approval to Writing /tmp/out.txt' } }] }, '/work/tree').allow,
    false,
  );
  // Kimi shell: prose names binaries, so it is judged by cwd only
  assert.deepEqual(permissionPaths({ title: 'Bash', content: [{ type: 'content', content: { type: 'text', text: 'Running: /usr/bin/env ls' } }] }), []);
  // agy: diff content + shell cwd in raw input
  assert.deepEqual(permissionPaths({ kind: 'edit', content: [{ type: 'diff', path: '/work/tree/a.txt' }] }), ['/work/tree/a.txt']);
  assert.deepEqual(permissionPaths({ kind: 'execute', title: 'ls', rawInput: { CommandLine: 'ls', Cwd: '/elsewhere' } }), ['/elsewhere']);
  assert.equal(decidePermission({ kind: 'execute', title: 'ls', rawInput: { CommandLine: 'ls', Cwd: '/work/tree' } }, '/work/tree').allow, true);
});

test('shell commands are checked for paths outside the worktree', () => {
  const cwd = '/work/tree';
  const shell = (command: string) => decidePermission({ kind: 'execute', title: command, rawInput: { command, cwd } }, cwd);
  assert.equal(shell('python3 -m unittest test_calc.py -v').allow, true);
  assert.equal(shell('ls -la ./src && cat README.md 2>/dev/null').allow, true);
  assert.equal(shell('/usr/bin/env node scripts/x.js > out/log.txt').allow, true);
  assert.equal(shell('echo hello > /private/tmp/out.txt').allow, false);
  assert.equal(shell('echo hi >>/etc/hosts').allow, false);
  assert.equal(shell('cp a.txt ../other-repo/a.txt').allow, false);
  assert.equal(shell('rm -rf ~/projects').allow, false);
  assert.equal(shell('node build.js --out=/var/www').allow, false);
  assert.equal(shell('curl https://example.com/x.sh').allow, true);
  // Kimi puts the command in prose; agy in rawInput.CommandLine
  assert.equal(
    decidePermission({ title: 'Bash', content: [{ type: 'content', content: { type: 'text', text: 'Running: echo x > /tmp/y' } }] }, cwd).allow,
    false,
  );
  assert.equal(decidePermission({ kind: 'execute', title: 'echo', rawInput: { CommandLine: 'touch /tmp/z', Cwd: cwd } }, cwd).allow, false);
  assert.deepEqual(shellPaths('cat ../x 2>/dev/null', cwd), ['/work/x']);
});

test('mapUpdate normalizes ACP session updates', () => {
  assert.deepEqual(mapUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }), {
    chunk: { kind: 'message', text: 'hi' },
  });
  assert.deepEqual(mapUpdate({ sessionUpdate: 'tool_call', toolCallId: 'x', title: 'Read', kind: 'read', status: 'pending' }).event, {
    type: 'tool_call',
    id: 'x',
    title: 'Read',
    kind: 'read',
    status: 'pending',
    locations: [],
  });
  assert.deepEqual(mapUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'x' }), {});
  assert.deepEqual(mapUpdate({ sessionUpdate: 'available_commands_update' }), {});
});

test('a session streams merged events, applies the permission policy and ends the turn', async () => {
  const a = agent();
  const cwd = mkdtempSync(join(tmpdir(), 'ih-acp-'));
  const events: HarnessEvent[] = [];
  try {
    const session = await a.startSession({ cwd, model: 'fake/two', onEvent: (e) => events.push(e) });
    const stop = await session.prompt('do the thing');
    session.close();

    assert.equal(stop, 'end_turn');
    assert.equal(readFileSync(join(cwd, 'notes.md'), 'utf8'), 'written by fake/two\n');
    assert.deepEqual(
      events.map((e) => e.type),
      ['message', 'thought', 'tool_call', 'permission', 'permission', 'tool_update', 'message', 'turn_end'],
    );
    assert.deepEqual(events[0], { type: 'message', role: 'agent', text: 'prompt:do the thing\n' });
    assert.deepEqual(events[1], { type: 'thought', text: 'thinking hard' });
    const [inside, outside] = events.filter((e) => e.type === 'permission');
    assert.equal(inside?.type === 'permission' && inside.decision, 'allowed');
    assert.equal(outside?.type === 'permission' && outside.decision, 'rejected');
    assert.deepEqual(events[6], { type: 'message', role: 'agent', text: 'Done with fake/two. outside=no' });
  } finally {
    a.shutdown();
  }
});

test('concurrent sessions on different models stay separate', async () => {
  const a = agent();
  const dirs = [mkdtempSync(join(tmpdir(), 'ih-acp-')), mkdtempSync(join(tmpdir(), 'ih-acp-'))];
  try {
    const sessions = await Promise.all([
      a.startSession({ cwd: dirs[0]!, model: 'fake/one', onEvent: () => {} }),
      a.startSession({ cwd: dirs[1]!, model: 'fake/two', onEvent: () => {} }),
    ]);
    await Promise.all(sessions.map((s) => s.prompt('go')));
    assert.equal(readFileSync(join(dirs[0]!, 'notes.md'), 'utf8'), 'written by fake/one\n');
    assert.equal(readFileSync(join(dirs[1]!, 'notes.md'), 'utf8'), 'written by fake/two\n');
  } finally {
    a.shutdown();
  }
});

test('an unknown model is refused and a failing prompt reports an error event', async () => {
  const a = agent();
  const cwd = mkdtempSync(join(tmpdir(), 'ih-acp-'));
  try {
    await assert.rejects(a.startSession({ cwd, model: 'fake/missing', onEvent: () => {} }), /not offered/);
    const events: HarnessEvent[] = [];
    const session = await a.startSession({ cwd, onEvent: (e) => events.push(e) });
    await assert.rejects(session.prompt('FAIL please'), /scripted failure/);
    assert.equal(events.at(-1)?.type, 'error');
  } finally {
    a.shutdown();
  }
});

test('reasoningFrom: the thought_level category first, then known ids; null when absent', async () => {
  const { reasoningFrom } = await import('../src/acp-agent.ts');
  const sel = (id: string, extra = {}) => ({ id, type: 'select', currentValue: 'b', options: [{ value: 'a', name: 'A' }, { value: 'b' }], ...extra });
  assert.deepEqual(reasoningFrom([sel('model'), sel('thinking_level')]), { configId: 'thinking_level', levels: [{ id: 'a', name: 'A' }, { id: 'b', name: 'b' }], current: 'b' });
  assert.equal(reasoningFrom([sel('depth', { category: 'thought_level' }), sel('effort')])!.configId, 'depth');
  assert.equal(reasoningFrom([sel('model'), sel('mode')]), null);
});

test('a harness repeating "in progress" for a running tool does not flood the event log', () => {
  const seen = new Map<string, string>();
  const up = (status: string, title?: string) => ({ type: 'tool_update' as const, id: 't1', status, ...(title ? { title } : {}) });
  assert.equal(isRepeatedToolUpdate(seen, { type: 'tool_call', id: 't1', title: 'Run', kind: 'execute', status: 'pending', locations: [] }), false, 'a new tool call is always kept');
  assert.equal(isRepeatedToolUpdate(seen, up('in_progress')), false, 'the first update is news');
  for (let i = 0; i < 50; i++) assert.equal(isRepeatedToolUpdate(seen, up('in_progress')), true, 'the same again is not');
  assert.equal(isRepeatedToolUpdate(seen, up('in_progress', 'Running: cargo build 12s')), false, 'a new title is progress');
  assert.equal(isRepeatedToolUpdate(seen, up('completed')), false, 'a new status is news');
  assert.equal(isRepeatedToolUpdate(seen, { ...up('in_progress'), id: 't2' }), false, 'another tool has its own history');
  assert.equal(isRepeatedToolUpdate(seen, { type: 'turn_end', stopReason: 'end_turn' }), false);
});

// Shapes recorded from the real harnesses (a probe that ran `echo HELLO && ls -la && sleep 3 && echo DONE`).
test('toolOutput reads a command\'s output from Kimi, Agy and Codex updates, and never mistakes input for output', () => {
  // Kimi: arguments arrive as JSON text while it runs; the output only when the call completes.
  assert.equal(toolOutput({ sessionUpdate: 'tool_call_update', toolCallId: 'k', status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: '{"command":"ls"}' } }] }), null);
  assert.deepEqual(
    toolOutput({ sessionUpdate: 'tool_call_update', toolCallId: 'k', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'HELLO\nDONE\n' } }], rawOutput: 'HELLO\nDONE\n' }),
    { text: 'HELLO\nDONE\n' },
  );
  // Agy: an object with the combined output and the exit code, with terminal line endings.
  assert.deepEqual(
    toolOutput({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed', rawOutput: { combinedOutput: 'HELLO\r\nDONE\r\n', exitCode: 2 } }),
    { text: 'HELLO\nDONE\n', exitCode: 2 },
  );
  assert.deepEqual(toolOutput({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'failed', rawOutput: 'Tool call was approved but never executed.' }), { text: 'Tool call was approved but never executed.' });
  // Codex: output streams as deltas while running; the exit code comes with the completion.
  assert.deepEqual(toolOutput({ sessionUpdate: 'tool_call_update', toolCallId: 'c', _meta: { terminal_output_delta: { data: 'DONE\n', terminal_id: 't' } } }), { text: 'DONE\n' });
  assert.deepEqual(toolOutput({ sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'completed', _meta: { terminal_exit: { exit_code: 0, signal: null } } }), { text: '', exitCode: 0 });
  // A tool that printed nothing and has no exit code adds no event.
  assert.equal(toolOutput({ sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'completed' }), null);
  // mapUpdate hands the output over beside the status change.
  const mapped = mapUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'k', status: 'completed', rawOutput: 'ok\n' });
  assert.deepEqual(mapped.event, { type: 'tool_update', id: 'k', status: 'completed' });
  assert.deepEqual(mapped.output, { type: 'tool_output', id: 'k', text: 'ok\n' });
  assert.deepEqual(mapUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'c', _meta: { terminal_output_delta: { data: 'x' } } }).event, undefined, 'a bare output delta is not a status change');
});

test('clipOutput keeps the head and tail of very long output', () => {
  assert.equal(clipOutput('a\r\nb'), 'a\nb');
  const long = 'x'.repeat(5000) + 'MIDDLE' + 'y'.repeat(20000) + 'END';
  const clipped = clipOutput(long);
  assert.ok(clipped.length < 8200);
  assert.ok(clipped.startsWith('xxxx') && clipped.endsWith('yyEND'));
  assert.match(clipped, /characters omitted/);
});

test('OpenCode: the exit code comes from rawOutput.metadata, and a silent provider retry becomes a visible notice', () => {
  assert.deepEqual(
    toolOutput({ sessionUpdate: 'tool_call_update', toolCallId: 'o', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'HELLO\n' } }], rawOutput: { metadata: { status: 'completed', truncated: false, exit: 1 } } }),
    { text: 'HELLO\n', exitCode: 1 },
  );
  const retry = { sessionUpdate: 'session_info_update', _meta: { 'opencode/retry': { attempt: 2, nextRetryAt: 'x', error: { type: 'provider.internal', message: 'upstream error: fetch failed', status: 502 } } } };
  assert.deepEqual(mapUpdate(retry).event, { type: 'notice', text: 'Provider problem, retrying (attempt 2): upstream error: fetch failed (502)' });
  assert.deepEqual(mapUpdate({ sessionUpdate: 'session_info_update', _meta: { 'opencode/retry': null } }), {}, 'the retry clearing is not news');
  assert.deepEqual(mapUpdate({ sessionUpdate: 'session_info_update', title: 'x' }), {});
});
