#!/usr/bin/env node
// A stdio MCP server for hub tests: `look` only reads (readOnlyHint), `change` writes and reports how many writes were
// running at once, `unmarked` carries no annotations at all.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'fake-studio', version: '1' });
let running = 0;
let peak = 0;
let changes = 0;
let downs = 0;

server.registerTool('look', { description: 'Reads a thing', inputSchema: { what: z.string().optional() }, annotations: { readOnlyHint: true } }, async ({ what }) => ({
  content: [{ type: 'text', text: `saw ${what ?? 'nothing'} after ${changes} change(s)` }],
}));
server.registerTool('change', { description: 'Changes a thing', inputSchema: { what: z.string().optional() }, annotations: { readOnlyHint: false, destructiveHint: true } }, async ({ what }) => {
  running++;
  peak = Math.max(peak, running);
  await new Promise((r) => setTimeout(r, 150));
  running--;
  changes++;
  return { content: [{ type: 'text', text: `changed ${what ?? 'it'}; peak concurrent writes ${peak}` }] };
});
// With FAKE_DOWN set: a tool whose server cannot reach what it drives, the way Studio's does when no plugin is connected.
if (process.env.FAKE_DOWN) {
  server.registerTool('down', { description: 'Fails: not connected', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({
    isError: true,
    content: [{ type: 'text', text: `Studio is not connected (upstream call #${++downs})` }],
  }));
}
server.registerTool('unmarked', { description: 'No annotations', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'unmarked ran' }] }));

await server.connect(new StdioServerTransport());
