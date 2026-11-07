#!/usr/bin/env node
// One-time Google login for the agy ACP server. On macOS it reuses the agy CLI's keychain login; on Linux
// it runs its own OAuth flow, so open the printed link in a browser. The server caches the login afterwards.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../.meta-harness/bin/agy-acp/agy_acp_server.par', import.meta.url));
if (!existsSync(bin)) {
  console.error('agy ACP server not installed; run scripts/install-agy-acp.sh first');
  process.exit(1);
}

const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', (d) => {
  const link = /https:\/\/accounts\.google\.com\S+/.exec(String(d))?.[0];
  if (link) console.log(`\nOpen this link in a browser and sign in with your Google AI Pro account:\n\n${link}\n`);
});

let buf = '';
const waiting = new Map();
child.stdout.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0; ) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
  }
});
let next = 0;
const request = (method, params) =>
  new Promise((resolve) => {
    const id = ++next;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
console.log('Waiting for the Google sign-in to finish (Ctrl-C to give up)...');
const auth = await request('authenticate', { methodId: 'oauth-personal' });
const session = auth.error ? null : await request('session/new', { cwd: process.cwd(), mcpServers: [] });
child.kill();
if (auth.error || session?.error) {
  console.error('Login failed:', JSON.stringify(auth.error ?? session.error));
  process.exit(1);
}
console.log('Signed in. The agy pool will now authenticate on its own.');
