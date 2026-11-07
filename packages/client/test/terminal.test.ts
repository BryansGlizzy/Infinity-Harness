import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DaemonApi, DaemonHttp } from '../src/index.ts';
import { attachTerminal } from '../src/node/index.ts';

class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket;
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeSocket.last = this;
    queueMicrotask(() => this.onopen?.());
  }
  send(s: string) {
    this.sent.push(s);
  }
  close() {
    this.closed = true;
  }
}

function fakeTerminal() {
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, isRaw: false, raw: [] as boolean[], setRawMode(v: boolean) { this.raw.push(v); this.isRaw = v; }, resume() {}, pause() {} });
  const written: string[] = [];
  const stdout = Object.assign(new EventEmitter(), { columns: 100, rows: 30, write: (s: string | Buffer) => written.push(String(s)) });
  return { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, raw: stdin.raw, written, emit: (d: string) => stdin.emit('data', Buffer.from(d)), resize: () => stdout.emit('resize') };
}

const apiWith = (available: boolean) =>
  new DaemonApi(new DaemonHttp({ baseUrl: 'http://x:7420', token: 'tok', fetch: (async () => new Response(JSON.stringify({ available }))) as unknown as typeof fetch }));

test('attach: scrollback and output reach the screen, keys and size reach the agent, Ctrl+] detaches and restores the terminal', async () => {
  const term = fakeTerminal();
  const done = attachTerminal(apiWith(true), 'c_1', term, { WebSocket: FakeSocket as unknown as typeof WebSocket });
  await new Promise((r) => setTimeout(r, 10));
  const ws = FakeSocket.last;
  assert.equal(ws.url, 'ws://x:7420/ws/terminal/c_1?token=tok');
  assert.deepEqual(term.raw, [true], 'raw mode while attached');
  assert.deepEqual(ws.sent, ['\x00resize:100x30'], 'the size is sent first');

  ws.onmessage?.({ data: 'scrollback\r\n' });
  assert.deepEqual(term.written, ['scrollback\r\n']);
  term.emit('hello');
  term.emit('\x03');
  assert.deepEqual(ws.sent.slice(1), ['hello', '\x03'], 'Ctrl+C goes to the agent');
  term.resize();
  assert.equal(ws.sent.at(-1), '\x00resize:100x30');

  term.emit('\x1d');
  assert.equal(await done, 'detached');
  assert.deepEqual(term.raw, [true, false], 'the terminal is put back');
  assert.ok(ws.closed);
  term.emit('after');
  assert.ok(!ws.sent.includes('after'), 'no longer listening');
});

test('attach: the agent ending the session ends the attach; a card without a terminal says so', async () => {
  const term = fakeTerminal();
  const done = attachTerminal(apiWith(true), 'c_1', term, { WebSocket: FakeSocket as unknown as typeof WebSocket });
  await new Promise((r) => setTimeout(r, 10));
  FakeSocket.last.onclose?.();
  assert.equal(await done, 'ended');
  assert.deepEqual(term.raw, [true, false]);
  assert.equal(await attachTerminal(apiWith(false), 'c_2', fakeTerminal()), 'unavailable');
});
