#!/usr/bin/env node
// A scripted ACP agent for tests. On each prompt it streams thoughts and text, makes a tool call,
// asks permission to edit a file inside the session cwd and one outside it, writes the allowed
// file, and ends the turn. Prompt keywords change the script:
//   FAIL    → JSON-RPC error            STRICT → a rejected permission ends the turn as cancelled
//   SLOW    → waits up to 5 s; session/cancel ends the turn as cancelled
//   CALL <tool> <json>  (one per line) → calls that tool on the session's "board" MCP server
//   CALL <server>:<tool> <json> → the same on another of the session's MCP servers (e.g. a hub entry)
//   LISTTOOLS <server> → replies tools=<names the server lists to this session>
//   CALL[<model>] … / FAIL[<model>] → only when the session runs that model
//   FAILMSG(<text>)  → the message of a scripted failure (default `scripted failure`)
//   WHEN(<text>) CALL … → only when the prompt contains <text>
//   SHELL <command>  (one per line) → asks permission to run it as a shell command; replies shell=<optionId>
//   DIRS             → replies dirs=<JSON of the session's additionalDirectories>
//   USAGE            → the turn's result carries a usage block (1200 in, 340 out, 100 cached)
//   Every prompt is echoed back as `prompt:<first 200 chars>` so tests can see what was delivered.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const sessions = new Map();
let nextId = 1000;
const waiting = new Map();
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const update = (sessionId, u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = ++nextId;
    waiting.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
const permissionOptions = [
  { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' },
];

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return send({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: process.env.FAKE_NO_LOAD ? {} : { loadSession: true } } });
    case 'session/new': {
      const sessionId = `fake-${sessions.size + 1}`;
      sessions.set(sessionId, {
        cwd: params.cwd,
        model: 'fake/one',
        mcp: (params.mcpServers ?? []).find((m) => m.name === 'board'),
        servers: params.mcpServers ?? [],
        dirs: params.additionalDirectories ?? null,
        cancelled: false,
      });
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          sessionId,
          configOptions: [
            { id: 'model', type: 'select', currentValue: 'fake/one', options: [{ value: 'fake/one' }, { value: 'fake/two' }] },
            { id: 'thinking', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Thinking Low' }, { value: 'high', name: 'Thinking High' }] },
          ],
        },
      });
    }
    case 'session/load': {
      // Like a real agent: replay the old conversation as updates, then answer. FAKE_LOAD_FAILS rejects the load.
      if (process.env.FAKE_LOAD_FAILS) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown session' } });
      sessions.set(params.sessionId, {
        cwd: params.cwd,
        model: 'fake/one',
        mcp: (params.mcpServers ?? []).find((m) => m.name === 'board'),
        servers: params.mcpServers ?? [],
        dirs: params.additionalDirectories ?? null,
        cancelled: false,
        loaded: true,
      });
      update(params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'REPLAYED-OLD-PROMPT' } });
      update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED-OLD-ANSWER' } });
      return send({ jsonrpc: '2.0', id, result: {} });
    }
    case 'session/set_config_option':
      sessions.get(params.sessionId)[params.configId === 'thinking' ? 'thinking' : 'model'] = params.value;
      return send({ jsonrpc: '2.0', id, result: {} });
    case 'session/prompt': {
      const s = sessions.get(params.sessionId);
      const text = params.prompt.map((p) => p.text).join('');
      const failFor = /FAIL\[([^\]]+)\]/.exec(text);
      const late = failFor && failFor[1] === s.model;
      const failMessage = /FAILMSG\(([^)]*)\)/.exec(text)?.[1] ?? 'scripted failure';
      if (failFor ? false : text.includes('FAIL')) return send({ jsonrpc: '2.0', id, error: { code: -32603, message: failMessage } });
      s.cancelled = false;
      update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${s.loaded ? 'loaded ' : ''}prompt:${text.slice(0, 200)}\n` } });
      if (s.thinking) update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `thinking=${s.thinking}\n` } });
      if (text.includes('DIRS')) update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `dirs=${JSON.stringify(s.dirs)}\n` } });
      for (const line of text.split('\n')) {
        const shell = /^SHELL (.+)$/.exec(line.trim());
        if (shell) {
          const answer = await ask('session/request_permission', {
            sessionId: params.sessionId,
            toolCall: { toolCallId: 'sh', title: shell[1], kind: 'execute', rawInput: { command: shell[1], cwd: s.cwd } },
            options: permissionOptions,
          });
          update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `shell=${answer.outcome?.optionId}\n` } });
          continue;
        }
        const list = /^LISTTOOLS (\S+)$/.exec(line.trim());
        if (list) {
          const names = await callBoard((s.servers ?? []).find((m) => m.name === list[1]), '', {}, 'tools/list');
          update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `tools=${names}\n` } });
          continue;
        }
        const call = /^(?:WHEN\(([^)]*)\)\s+)?CALL(?:\[([^\]]+)\])? ([\w.-]+(?::[\w.-]+)?) (.*)$/.exec(line.trim());
        // WHEN markers don't count as prompt text (a prompt may quote a scripted line, marker and all).
        if (!call || (call[1] && !text.replace(/WHEN\([^)]*\)/g, '').includes(call[1])) || (call[2] && call[2] !== s.model)) continue;
        const [server, tool] = call[3].includes(':') ? call[3].split(':') : [null, call[3]];
        const result = await callBoard(server ? (s.servers ?? []).find((m) => m.name === server) : s.mcp, tool, JSON.parse(call[4]));
        update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${call[3]} -> ${result}\n` } });
      }
      // A model-specific failure happens after its board calls, so it can leave notes behind first.
      if (late) return send({ jsonrpc: '2.0', id, error: { code: -32603, message: failMessage } });
      if (text.includes('SLOW')) {
        for (let i = 0; i < 100 && !s.cancelled; i++) await new Promise((r) => setTimeout(r, 50));
        if (s.cancelled) return send({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } });
      }
      update(params.sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking ' } });
      update(params.sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hard' } });
      update(params.sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Write notes.md', kind: 'edit', status: 'pending', locations: [{ path: 'notes.md' }] });
      const inside = await ask('session/request_permission', {
        sessionId: params.sessionId,
        toolCall: { toolCallId: 't1', title: 'Write notes.md', locations: [{ path: join(s.cwd, 'notes.md') }] },
        options: permissionOptions,
      });
      const outside = await ask('session/request_permission', {
        sessionId: params.sessionId,
        toolCall: { toolCallId: 't2', title: 'Write /etc/hosts', locations: [{ path: '/etc/hosts' }] },
        options: permissionOptions,
      });
      if (inside.outcome?.optionId === 'yes') writeFileSync(join(s.cwd, 'notes.md'), `written by ${s.model}\n`);
      // Like OpenCode: a rejected permission ends the turn as cancelled.
      if (text.includes('STRICT') && outside.outcome?.optionId === 'no') {
        return send({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } });
      }
      update(params.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
      update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Done with ${s.model}. ` } });
      update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `outside=${outside.outcome?.optionId}` } });
      return send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn', ...(text.includes('USAGE') ? { usage: { inputTokens: 1200, outputTokens: 340, cachedReadTokens: 100 } } : {}) } });
    }
    case 'session/cancel':
      if (sessions.has(params.sessionId)) sessions.get(params.sessionId).cancelled = true;
      return;
    case 'session/close':
      sessions.delete(params.sessionId);
      return send({ jsonrpc: '2.0', id, result: {} });
    default:
      if (id != null) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown ${method}` } });
  }
}

/** Minimal MCP client: stateless Streamable HTTP, JSON responses. */
async function callBoard(server, name, args, method = 'tools/call') {
  if (!server) return 'no board server';
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  for (const h of server.headers ?? []) headers[h.name] = h.value;
  const rpc = async (method, params, id) => {
    const res = await fetch(server.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    if (res.status === 202) return null;
    const body = await res.json();
    if (body.error) throw new Error(body.error.message);
    return body.result;
  };
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '0' } }, 1);
  await rpc('notifications/initialized', {}, undefined);
  if (method === 'tools/list') return (await rpc('tools/list', {}, 2)).tools.map((t) => t.name).join(',');
  const result = await rpc('tools/call', { name, arguments: args }, 2);
  return `${result.isError ? 'ERROR ' : ''}${result.content.map((c) => c.text).join('')}`.replace(/\s+/g, ' ');
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === undefined && waiting.has(msg.id)) {
    waiting.get(msg.id)(msg.result);
    waiting.delete(msg.id);
    return;
  }
  void handle(msg);
});
