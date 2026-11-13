// The TUI: input parsing, drawing, and the whole app driven by key presses and mouse clicks against a real daemon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Fleet, MachineCatalog } from '@ih/client/node';
import { setup, status, waitFor } from '../../daemon/test/harness.ts';
import { fakeSsh } from '../../../packages/client/test/fake-ssh.ts';
import { App } from '../src/app.ts';
import { Canvas, fit, wrap } from '../src/canvas.ts';
import { InputParser, type InputEvent } from '../src/input.ts';
import { SeenStore } from '../src/seen.ts';
import { MOUSE_OFF, MOUSE_ON, RealTerminal, type TermIo } from '../src/term.ts';

// --- input

test('input: keys, arrows, SGR mouse reports, wheel, split sequences, UTF-8', () => {
  const p = new InputParser();
  assert.deepEqual(p.push('a\r\t\x7f'), [{ type: 'key', name: 'a', text: 'a' }, { type: 'key', name: 'enter' }, { type: 'key', name: 'tab' }, { type: 'key', name: 'backspace' }]);
  assert.deepEqual(p.push('\x1b[A\x1b[B\x1b[C\x1b[D\x1b[5~\x1b[6~\x1b[Z\x1b[H\x1b[F\x1b[3~').map((e) => (e as { name: string }).name), ['up', 'down', 'right', 'left', 'pageup', 'pagedown', 'backtab', 'home', 'end', 'delete']);
  assert.deepEqual(p.push('\x1bOA'), [{ type: 'key', name: 'up' }]);
  assert.deepEqual(p.push('\x03'), [{ type: 'key', name: 'c', ctrl: true }]);
  assert.deepEqual(p.push('\x1b'), [{ type: 'key', name: 'esc' }]);
  assert.deepEqual(p.push('\x1bx'), [{ type: 'key', name: 'x', alt: true, text: 'x' }]);
  assert.deepEqual(p.push('é→'), [{ type: 'key', name: 'é', text: 'é' }, { type: 'key', name: '→', text: '→' }]);

  assert.deepEqual(p.push('\x1b[<0;12;5M'), [{ type: 'mouse', action: 'down', button: 'left', x: 11, y: 4 }], 'coordinates are 0-based');
  assert.deepEqual(p.push('\x1b[<0;12;5m'), [{ type: 'mouse', action: 'up', button: 'left', x: 11, y: 4 }]);
  assert.deepEqual(p.push('\x1b[<2;1;1M'), [{ type: 'mouse', action: 'down', button: 'right', x: 0, y: 0 }]);
  assert.deepEqual(p.push('\x1b[<32;9;9M'), [{ type: 'mouse', action: 'drag', button: 'left', x: 8, y: 8 }]);
  assert.deepEqual(p.push('\x1b[<64;3;3M\x1b[<65;3;3M'), [{ type: 'mouse', action: 'wheel', button: 'none', dir: 'up', x: 2, y: 2 }, { type: 'mouse', action: 'wheel', button: 'none', dir: 'down', x: 2, y: 2 }]);
  assert.deepEqual(p.push('\x1b[<0;120;4'), [], 'half a report waits');
  assert.deepEqual(p.push('0M'), [{ type: 'mouse', action: 'down', button: 'left', x: 119, y: 39 }], 'and is completed by the next chunk');
});

// --- canvas

test('canvas: clipping, regions (later wins), wrapping, and only changed lines are rewritten', () => {
  assert.equal(fit('hello world', 8), 'hello w…');
  assert.equal(fit('hi', 8), 'hi');
  assert.deepEqual(wrap('one two three four', 8), ['one two', 'three', 'four']);
  const c = new Canvas(10, 3);
  c.put(7, 0, 'abcdef');
  c.put(0, 5, 'off');
  assert.deepEqual(c.lines(), ['       abc', '', '']);
  const w = c.button(0, 1, 'Go', 'go');
  assert.equal(w, 4);
  assert.equal(c.hit(2, 1)?.id, 'go');
  assert.equal(c.hit(5, 1), undefined);
  c.region(0, 0, 10, 3, 'all');
  assert.equal(c.hit(2, 1)?.id, 'all', 'a dialog drawn later covers what is under it');

  const a = new Canvas(10, 3);
  a.put(0, 0, 'same');
  a.put(0, 1, 'same');
  const b = new Canvas(10, 3);
  b.put(0, 0, 'same');
  b.put(0, 1, 'diff');
  const out = b.toAnsi(a);
  assert.ok(!out.includes('\x1b[1;1H'), 'line 1 unchanged');
  assert.ok(out.includes('\x1b[2;1H') && out.includes('diff'));
  assert.ok(b.toAnsi(null).includes('\x1b[1;1H'), 'a first frame writes everything');
});

// --- the real terminal switches mouse reporting on and off

test('terminal: mouse reporting is switched on with the screen and off again, and left alone when capture is off', () => {
  const writes: string[] = [];
  const fake = (mouse: boolean) =>
    new RealTerminal({
      stdin: Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} }) as unknown as NodeJS.ReadStream,
      stdout: Object.assign(new EventEmitter(), { write: (s: string) => writes.push(s), columns: 80, rows: 24 }) as unknown as NodeJS.WriteStream,
      mouse,
    });
  const on = fake(true);
  on.enter();
  assert.ok(writes.join('').includes(MOUSE_ON) && writes.join('').includes('\x1b[?1049h'));
  on.suspend();
  assert.ok(writes.join('').includes(MOUSE_OFF), 'handing the terminal to an agent session turns reporting off');
  on.resume();
  on.leave();
  assert.ok(writes.at(-1)!.startsWith(MOUSE_OFF) && writes.at(-1)!.includes('\x1b[?25h'));
  const mark = writes.length;
  const off = fake(false);
  off.enter();
  off.leave();
  assert.ok(!writes.slice(mark).join('').includes('1000'), 'no mouse sequences at all');
});

// --- the app

class FakeTerm implements TermIo {
  width = 100;
  height = 30;
  color = false;
  frames = 0;
  entered = 0;
  left = 0;
  written = '';
  write(d: string) {
    this.written += d;
    this.frames++;
  }
  size() {
    return { width: this.width, height: this.height };
  }
  onInput() {}
  onResize() {}
  enter() {
    this.entered++;
  }
  leave() {
    this.left++;
  }
  suspend() {}
  resume() {}
}

const key = (name: string, extra: Partial<InputEvent> = {}): InputEvent => ({ type: 'key', name, ...(name.length === 1 ? { text: name } : {}), ...extra }) as InputEvent;
const click = (x: number, y: number): InputEvent => ({ type: 'mouse', action: 'down', button: 'left', x, y });

async function until(cond: () => boolean, ms = 4000) {
  for (let t = 0; !cond(); t += 15) {
    if (t > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** Where a piece of text is on screen. */
function find(app: App, text: string): { x: number; y: number } {
  const lines = app.canvas!.lines();
  for (let y = 0; y < lines.length; y++) {
    const x = lines[y]!.indexOf(text);
    if (x >= 0) return { x, y };
  }
  throw new Error(`"${text}" is not on screen:\n${app.text()}`);
}
/** Clicks on a piece of text, as a person would. */
async function clickOn(app: App, text: string) {
  const { x, y } = find(app, text);
  await app.handle(click(x + 1, y));
}
/** Selects a need by clicking its row (a row that is already selected is left alone: clicking it again would open the card). */
async function select(app: App, text: string) {
  const i = app.state.snap.needs.findIndex((n) => n.title.includes(text));
  if (i < 0) throw new Error(`no need "${text}"`);
  if (app.state.sel.needs !== i) await app.handle(click(30, find(app, text).y));
  assert.equal(app.state.sel.needs, i);
}
async function type(app: App, text: string) {
  for (const ch of text) await app.handle(key(ch));
}

const running: App[] = [];
/** Stops every app a test started, then the daemon. */
async function done(t: Awaited<ReturnType<typeof setup>>) {
  for (const a of running.splice(0)) a.stop();
  await t.close();
}

async function launch(t: Awaited<ReturnType<typeof setup>>, extra: Partial<ConstructorParameters<typeof App>[0]> = {}) {
  const term = new FakeTerm();
  const cat = new MachineCatalog(join(mkdtempSync(join(tmpdir(), 'ih-tui-')), 'machines.json'));
  const fleet = new Fleet({ catalog: cat, localUrl: `http://127.0.0.1:${t.cfg.port}`, connection: { readyTimeoutMs: 1500, checkIntervalMs: 100, checkTimeoutMs: 200, backoff: { minMs: 20, maxMs: 60, healthyMs: 100_000 } } });
  const app = new App({ fleet, term, seenAfterMs: 40, bell: false, ...extra });
  running.push(app);
  await app.start();
  return { app, term, cat, fleet };
}

test('needs you: sorted, shown with what they are, approved and denied by click and by key', async () => {
  const t = await setup();
  try {
    const card = t.store.createCard({ boardId: t.board.id, title: 'Add linting' });
    const skill = t.store.createApproval({ boardId: t.board.id, cardId: card.id, kind: 'install_skill', summary: 'Install the "lint" skill', payload: { skill: { name: 'lint', description: 'Run the linter', body: 'Run `pnpm lint`.' } }, requestedBy: `card:${card.id}` });
    const grant = t.store.createApproval({ boardId: t.board.id, cardId: card.id, kind: 'grant', summary: 'Give the card a browser', payload: { grant: 'browser' }, requestedBy: `card:${card.id}` });
    const ask = t.store.createApproval({ boardId: t.board.id, cardId: card.id, kind: 'escalation', summary: 'Which database should this use?', payload: {}, requestedBy: `card:${card.id}` });
    const stuck = t.store.createCard({ boardId: t.board.id, title: 'Stuck card' });
    t.store.updateCard(stuck.id, { status: 'blocked' });

    const { app, term } = await launch(t);
    assert.equal(term.entered, 1);
    const screen = app.text();
    assert.match(screen, /∞ Infinity Harness\s+● local ▾\s+Demo ▾/);
    assert.match(screen, /Needs you \(4\)\s+Board \(2\)\s+Pools/);
    assert.match(screen, /approve\s+Which database should this use\?/);
    assert.match(screen, /approve\s+Give the card a browser/);
    assert.match(screen, /blocked\s+Blocked: Stuck card/);
    assert.match(screen, /● 4 new/, 'nothing has been looked at yet');
    assert.ok(find(app, 'Which database').y < find(app, 'Stuck card').y, 'approvals before blocked cards');

    // The selected item is shown with its actions; clicking a button does it.
    await select(app, 'Install the "lint" skill');
    assert.match(app.text(), /Approve a\s+Deny d\s+Open card o/);
    await clickOn(app, 'Approve a');
    await until(() => t.store.getSettings(t.board.id).skills.some((s) => s.name === 'lint'));
    await until(() => !app.text().includes('Install the "lint" skill'));
    assert.match(app.text(), /Needs you \(3\)/);
    assert.match(app.text(), /Approved\./, 'a toast says it worked');

    // Deny with a note, by key.
    await select(app, 'Give the card a browser');
    await app.handle(key('d'));
    assert.match(app.text(), /Why not\? \(optional\)/);
    await type(app, 'not for this card');
    await app.handle(key('enter'));
    await until(() => t.store.getApproval(grant.id)!.status === 'denied');
    assert.equal(t.store.getApproval(grant.id)!.note, 'not for this card');

    // A question needs an answer; empty is refused; the answer goes to the agent.
    await select(app, 'Which database');
    await app.handle(key('a'));
    assert.match(app.text(), /Your answer/);
    await app.handle(key('enter'));
    assert.match(app.text(), /Write something first\./);
    await type(app, 'Postgres');
    await clickOn(app, 'Send ⏎');
    await until(() => t.store.getApproval(ask.id)!.status === 'approved');
    assert.equal(t.store.getApproval(ask.id)!.note, 'Postgres');
    void skill;
    app.stop();
  } finally {
    await done(t);
  }
});

test('approving something that runs code on this machine asks once more', async () => {
  const t = await setup({ installer: (await import('../../daemon/test/harness.ts')).fakeInstaller() });
  try {
    const card = t.store.createCard({ boardId: t.board.id, title: 'Needs a browser' });
    const a = t.store.createApproval({ boardId: t.board.id, cardId: card.id, kind: 'install_tool', summary: 'Install browser: npm install -g agent-browser', payload: { grant: 'browser' }, requestedBy: 'daemon:scheduler' });
    const { app } = await launch(t);
    await app.handle(key('a'));
    assert.match(app.text(), /This runs on this machine/);
    assert.equal(t.store.getApproval(a.id)!.status, 'pending', 'not yet');
    await app.handle(key('esc'));
    assert.equal(t.store.getApproval(a.id)!.status, 'pending', 'cancelled');
    await app.handle(key('a'));
    await app.handle(key('up'));
    await app.handle(key('enter'));
    await until(() => t.store.getApproval(a.id)!.status !== 'pending');
    app.stop();
  } finally {
    await done(t);
  }
});

test('a finished card waits for your verdict, and Approve gives it', async () => {
  const t = await setup();
  try {
    t.store.updateSettings(t.board.id, { humanReview: true });
    t.refinery.start(); // the approval hands the card to the merge queue
    const card = t.store.createCard({ boardId: t.board.id, title: 'Write notes' });
    const reached = waitFor(t.store, status(t.store, card.id, 'review'));
    await t.runner.run(card.id, 'fa');
    await reached;
    const { app } = await launch(t);
    assert.match(app.text(), /review\s+Review: Write notes/);
    await app.handle(key('o'));
    assert.match(app.text(), /Review · .*|Review ·/);
    assert.match(app.text(), /Approve a\s+Request changes c\s+Land now l/);
    await app.handle(key('esc'));
    await clickOn(app, 'Approve a');
    await until(() => t.store.getCard(card.id)!.pipeline.humanReview?.verdict === 'approve');
    await until(() => t.store.getCard(card.id)!.status === 'done', 25_000); // the verdict starts landing; let it finish before the daemon closes
    app.stop();
  } finally {
    await done(t);
  }
});

test('board: grouped by what needs attention, folding, and a card opens with its actions', async () => {
  const t = await setup();
  try {
    const a = t.store.createCard({ boardId: t.board.id, title: 'Alpha feature', description: 'Make alpha work.\nSecond line of the spec.' });
    const b = t.store.createCard({ boardId: t.board.id, title: 'Beta fix' });
    const d = t.store.createCard({ boardId: t.board.id, title: 'Old chore' });
    t.store.updateCard(a.id, { status: 'in_progress' });
    t.store.updateCard(b.id, { status: 'blocked' });
    t.store.updateCard(d.id, { status: 'done' });
    const { app } = await launch(t);
    await clickOn(app, 'Board (2)');
    const s = app.text();
    assert.ok(s.indexOf('Blocked (1)') < s.indexOf('In progress (1)') && s.indexOf('In progress (1)') < s.indexOf('Done (1)'), 'blocked first, done last');
    assert.ok(!s.includes('Old chore'), 'done is folded away');
    await clickOn(app, 'Done (1)');
    assert.match(app.text(), /Old chore/);
    await clickOn(app, 'Done (1)');
    assert.ok(!app.text().includes('Old chore'));

    await clickOn(app, 'Alpha feature');
    assert.match(app.text(), /In progress · worker/);
    assert.match(app.text(), /Make alpha work\./);
    assert.match(app.text(), /Message m\s+Move… v\s+Terminal t\s+Stop x/);

    await clickOn(app, 'Message m');
    await type(app, 'looks good so far');
    await app.handle(key('enter'));
    await until(() => t.store.boardMessages(t.board.id).some((m) => m.toCard === a.id && m.body === 'looks good so far'));

    await until(() => app.state.modal?.kind === 'card', 3000); // the card reopens after the message is sent
    await app.handle(key('t'));
    assert.match(app.text(), /Attaching needs a real terminal|Only Claude sessions/, 'a card without a live terminal says so');
    await app.handle(key('v'));
    assert.match(app.text(), /Move to/);
    await clickOn(app, 'backlog');
    await until(() => t.store.getCard(a.id)!.status === 'backlog');
    app.stop();
  } finally {
    await done(t);
  }
});

test('pools: windows and budgets', async () => {
  const t = await setup();
  try {
    t.limiter.report('fa', [{ window: '5h', pct: 82, resetsAt: Date.now() + 3600_000 }]);
    const { app } = await launch(t);
    await app.handle(key('3'));
    assert.match(app.text(), /fa\s+warn\s+▓+░*\s+5h 82%/);
    assert.match(app.text(), /fb\s+open/);
    assert.match(app.text(), /Last 24h: 0 tokens/);
    app.stop();
  } finally {
    await done(t);
  }
});

test('messages for you can be cleared from the TUI, one or all, and stay in the card\'s log', async () => {
  const t = await setup();
  try {
    const card = t.store.createCard({ boardId: t.board.id, title: 'Chatty card' });
    const say = (body: string) => t.store.postMessage({ boardId: t.board.id, fromActor: `card:${card.id}`, toCard: null, body, urgent: false });
    const [a, b, c] = [say('first question'), say('second question'), say('third question')];
    const { app } = await launch(t);
    await until(() => /3 waiting|Needs you \(3\)/.test(app.text()));
    assert.match(app.text(), /Clear x/);
    assert.match(app.text(), /Clear all messages X/);
    const shown = () => ['first', 'second', 'third'].filter((w) => app.text().includes(`${w} question`));
    const selected = t.store.boardMessages(t.board.id).find((m) => app.text().includes(m.body.split('\n')[0]!))!;
    assert.ok(selected);
    await app.handle(key('x'));
    await until(() => t.store.boardMessages(t.board.id).filter((m) => m.dismissedAt).length === 1);
    await until(() => shown().length === 2, 3000);
    await app.handle(key('X'));
    await until(() => [a, b, c].every((m) => t.store.boardMessages(t.board.id).find((x) => x.id === m.id)!.dismissedAt));
    await until(() => shown().length === 0, 3000);
    assert.equal(t.store.boardMessages(t.board.id).length, 3, 'nothing was deleted');
    app.stop();
  } finally {
    await done(t);
  }
});

test('pools: a pool taken out of rotation shows why, can be tested and put back', async () => {
  const t = await setup();
  try {
    t.health.eject('fa', 'no answer within 8 s');
    const { app } = await launch(t);
    await app.handle(key('3'));
    await until(() => /OUT/.test(app.text()));
    assert.match(app.text(), /fa\s+OUT\s+.*out of rotation/);
    assert.match(app.text(), /Out since .*no answer within 8 s\. Not held against the model\./);
    assert.match(app.text(), /Put back in rotation b/);

    await app.handle(key('t'));
    await until(() => /Fake A: online/.test(app.text()), 3000);
    assert.ok(t.health.ejection('fa'), 'a passing test does not put it back');

    await app.handle(key('b'));
    await until(() => !t.health.ejection('fa'), 3000);
    await until(() => !/OUT/.test(app.text()), 3000);
    assert.match(app.text(), /fa\s+open\s+.*online/);
    assert.doesNotMatch(app.text(), /Put back in rotation/);
    app.stop();
  } finally {
    await done(t);
  }
});

test('seen is per device: items count as new until looked at, and another device starts fresh', async () => {
  const t = await setup();
  try {
    const card = t.store.createCard({ boardId: t.board.id, title: 'Look at me' });
    t.store.createApproval({ boardId: t.board.id, cardId: card.id, kind: 'grant', summary: 'First request', payload: { grant: 'browser' }, requestedBy: 'x' });
    t.store.createApproval({ boardId: t.board.id, cardId: card.id, kind: 'grant', summary: 'Second request', payload: { grant: 'computer' }, requestedBy: 'x' });
    const dir = mkdtempSync(join(tmpdir(), 'ih-seen-'));
    const phone = join(dir, 'phone.json');
    const desk = join(dir, 'desk.json');

    const one = await launch(t, { seen: new SeenStore(desk) });
    assert.match(one.app.text(), /● 2 new/);
    await until(() => /● 1 new/.test(one.app.text()), 2000); // the selected one is seen after a moment
    await one.app.handle(key('down'));
    await until(() => /2 waiting/.test(one.app.text()), 2000);
    one.app.stop();
    assert.ok(readFileSync(desk, 'utf8').includes('approval:ap_'), 'remembered on disk');

    const same = await launch(t, { seen: new SeenStore(desk) });
    assert.match(same.app.text(), /2 waiting/, 'the same device remembers');
    same.app.stop();
    const other = await launch(t, { seen: new SeenStore(phone) });
    assert.match(other.app.text(), /● 2 new/, 'another device has not seen them');
    other.app.stop();
  } finally {
    await done(t);
  }
});

test('keys only: with mouse capture off, clicks do nothing and keys still do everything', async () => {
  const t = await setup();
  try {
    const card = t.store.createCard({ boardId: t.board.id, title: 'Keyboard' });
    const a = t.store.createApproval({ boardId: t.board.id, cardId: card.id, kind: 'grant', summary: 'Keys only please', payload: { grant: 'browser' }, requestedBy: 'x' });
    const { app } = await launch(t, { mouse: false });
    assert.match(app.text(), /keys only/);
    await clickOn(app, 'Approve a');
    assert.equal(t.store.getApproval(a.id)!.status, 'pending');
    await app.handle(key('a'));
    await until(() => t.store.getApproval(a.id)!.status === 'approved');
    await app.handle(key('?'));
    assert.match(app.text(), /Click anything\. Keys are shown on the buttons\./);
    await app.handle(key('esc'));
    await app.handle(key('q'));
    await app.finished;
  } finally {
    await done(t);
  }
});

test('another machine: switch from the header, see its data; when it drops the last state stays, dimmed and read-only, and comes back by itself', async () => {
  const t = await setup();
  const ssh = fakeSsh(t.cfg.port);
  let down = false;
  const spawn: typeof ssh.spawn = (a) => {
    if (!down) return ssh.spawn(a);
    let f: ((c: number | null, s: string) => void) | null = null;
    setTimeout(() => f?.(255, 'connect to host workbox port 22: Connection timed out'), 5);
    return { kill() {}, onExit: (fn) => (f = fn) };
  };
  try {
    const card = t.store.createCard({ boardId: t.board.id, title: 'Over there' });
    t.store.createApproval({ boardId: t.board.id, cardId: card.id, kind: 'grant', summary: 'A request on the far machine', payload: { grant: 'browser' }, requestedBy: 'x' });
    const cat = new MachineCatalog(join(mkdtempSync(join(tmpdir(), 'ih-tui-')), 'machines.json'));
    cat.add({ label: 'workbox', target: 'me@workbox' });
    const term = new FakeTerm();
    const fleet = new Fleet({ catalog: cat, localUrl: 'http://127.0.0.1:9', connection: { spawn, readyTimeoutMs: 1000, checkIntervalMs: 80, checkTimeoutMs: 150, backoff: { minMs: 20, maxMs: 60, healthyMs: 100_000 } } });
    const app = new App({ fleet, term, bell: false, seenAfterMs: 10_000 });
    running.push(app);
    await app.start();
    assert.match(app.text(), /local ▾/);
    assert.match(app.text(), /local: .*(fetch failed|no|refused|ECONN)/i, 'this machine has no daemon, and the screen says so');

    await clickOn(app, 'local ▾');
    assert.match(app.text(), /Machines/);
    await until(() => /● workbox/.test(app.text()));
    await clickOn(app, 'workbox');
    await until(() => /A request on the far machine/.test(app.text()));
    assert.match(app.text(), /● workbox ▾/);

    // The tunnel drops and cannot come back.
    down = true;
    ssh.made[0]!.exit(255, 'client_loop: send disconnect: Broken pipe');
    await until(() => /showing the last known state/.test(app.text()));
    assert.match(app.text(), /A request on the far machine/, 'the last known state stays');
    assert.ok(!/Approve a/.test(app.text()), 'but nothing can be done to a machine we cannot reach');

    // It comes back by itself and the buttons return.
    down = false;
    await until(() => /Approve a/.test(app.text()) && !/last known state/.test(app.text()), 6000);
    app.stop();
  } finally {
    await done(t);
  }
});

test('another swarm knocks and sends a request: both are in Needs you; accepting asks once, declining needs a reason', async () => {
  const t = await setup({ federation: true });
  const fed = t.federation!;
  try {
    const { generateIdentity } = await import('../../daemon/src/federation/identity.ts');
    const stranger = generateIdentity();
    fed.handleHello({ swarmId: stranger.swarmId, publicKey: stranger.publicKey }, { name: 'Gamma', projects: [] });
    const { app } = await launch(t);
    assert.match(app.text(), /swarm\s+Swarm "Gamma" wants to connect/);
    assert.match(app.text(), new RegExp(stranger.fingerprint.slice(0, 9)), 'the fingerprint is on screen to compare');

    // Accepting is not one keystroke: it asks, and Cancel leaves it waiting.
    await app.handle(key('a'));
    assert.match(app.text(), /Compare this fingerprint/);
    await app.handle(key('esc'));
    assert.equal(fed.listPeers()[0]!.trust, 'pending');
    await app.handle(key('a'));
    await app.handle(key('up'));
    await app.handle(key('enter'));
    await until(() => fed.listPeers()[0]!.trust === 'verified');

    // Its request: the sender is waiting; Decline wants a reason.
    fed.saveDraft(t.board.id, { name: 'Demo', oneLine: 'Demo', provides: ['demo'], accepts: { requests: true, note: '' } }, 'manual');
    fed.publish(t.board.id, 'basic');
    const peer = t.store.fed.listPeers()[0]!;
    fed.receiveRequest(peer, { id: 'req00001', title: 'Crash on empty input', description: 'x', project: t.board.id, blocking: false, acceptance: [], milestones: [], budget: null, origin: { cardId: null, hops: [peer.swarmId!] } });
    await until(() => /request\s+Request from Gamma: Crash on empty input/.test(app.text()));
    await app.handle(key('d'));
    await type(app, 'not now');
    await app.handle(key('enter'));
    await until(() => fed.listRequests({ direction: 'in' })[0]!.status === 'declined');
    assert.equal(fed.listRequests({ direction: 'in' })[0]!.thread.at(-1)?.text, 'not now');
    app.stop();
  } finally {
    await done(t);
  }
});

test('a question from a swarm we asked, and a result it landed, are in Needs you with their own actions', async () => {
  const t = await setup({ federation: true });
  try {
    const peer = t.store.fed.createPeer({ label: 'beta', trust: 'verified', swarmId: 'sw_beta', name: 'Beta', publicKey: 'k', fingerprint: 'f', address: { kind: 'url', url: 'http://127.0.0.1:1' } });
    const mk = (title: string, status: 'needs_info' | 'landed', extra: object = {}) =>
      t.store.fed.updateRequest(
        t.store.fed.createRequest({ direction: 'out', peerId: peer.id, remoteId: `r_${title}`, title, description: 'x', status: 'pending', origin: { swarmId: 'me', cardId: null, hops: ['me'] }, boardId: t.board.id }).id,
        { status, ...extra },
      );
    mk('Which node version', 'needs_info', { thread: [{ side: 'receiver', at: new Date().toISOString(), text: 'Which node version do you run?' }] });
    mk('Parser fix', 'landed', { resolution: { ref: 'abc1234' } });
    const { app } = await launch(t);
    assert.match(app.text(), /reply\s+Beta asks about "Which node version"/);
    assert.match(app.text(), /reply\s+Check what Beta landed: Parser fix/);
    // The question offers Answer; the landed result offers "It works" and "Send back".
    await select(app, 'asks about');
    assert.match(app.text(), /Answer/);
    await app.handle(key('a'));
    assert.match(app.text(), /Your answer/);
    await app.handle(key('esc'));
    await select(app, 'Check what Beta landed');
    assert.match(app.text(), /It works/);
    assert.match(app.text(), /Send back/);
    app.stop();
  } finally {
    await done(t);
  }
});

test('removing a board from the board menu: forget keeps the folder; delete asks for the name typed back', async () => {
  const t = await setup();
  try {
    const { existsSync } = await import('node:fs');
    const { tempRepo } = await import('../../daemon/test/harness.ts');
    const doomed = t.store.createBoard({ name: 'Doomed', repoPath: await tempRepo(), defaultBranch: 'main' });
    const { app } = await launch(t);
    const open = async () => {
      await clickOn(app, '▾'); // the machine switcher comes first; the board name is the second ▾
    };
    void open;
    // Choose the Doomed board, then open the board menu again and pick "Remove this board…".
    app['wantBoard'] = doomed.id;
    await app.refresh();
    await until(() => app.state.snap.board?.id === doomed.id);
    app['openBoardMenu']();
    assert.match(app.text(), /Remove this board…/);
    await app.handle(key('down'));
    await app.handle(key('down'));
    await app.handle(key('enter'));
    await until(() => /Remove "Doomed"\?/.test(app.text()));
    assert.match(app.text(), /Delete on system…/);
    // The menu opens on Cancel. Delete on system: a typed confirmation that must match; a wrong one deletes nothing.
    await app.handle(key('up'));
    await app.handle(key('enter'));
    await until(() => /Type the board's name: Doomed/.test(app.text()));
    await type(app, 'doomed');
    await app.handle(key('enter'));
    assert.ok(existsSync(doomed.repoPath), 'a wrong name deletes nothing');
    assert.ok(t.store.getBoard(doomed.id));
    // Forget: the board goes, the folder stays.
    app['removeBoardFlow']();
    await until(() => /Remove "Doomed"\?/.test(app.text()));
    await app.handle(key('1'));
    await until(() => !t.store.getBoard(doomed.id));
    assert.ok(existsSync(doomed.repoPath));
    app.stop();
  } finally {
    await done(t);
  }
});

test('files: the project tree opens folders in place, marks what changed, and reads a file', async () => {
  const t = await setup();
  try {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(t.repo, 'src', 'deep'), { recursive: true });
    writeFileSync(join(t.repo, 'src', 'main.ts'), 'export const answer = 42;\nconsole.log(answer);\n');
    writeFileSync(join(t.repo, 'src', 'deep', 'inner.txt'), 'inner\n');
    writeFileSync(join(t.repo, 'README.md'), '# changed\n');
    const { app } = await launch(t);
    await app.handle(key('4'));
    await until(() => /src\//.test(app.text()));
    // Folders first, then files; a changed file is marked, and so is the folder holding new files.
    const lines = app.canvas!.lines();
    const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
    assert.ok(at(/▸ src\//) < at(/README\.md/), 'folders come first');
    assert.match(lines[at(/README\.md/)]!, /M\s*$/, 'a modified file is marked M');
    assert.match(lines[at(/▸ src\//)]!, /•\s*$/, 'a folder with changes inside is marked');

    // Enter opens the selected folder in place; → goes in; the children are indented.
    await app.handle(key('enter'));
    await until(() => /▾ src\//.test(app.text()) && /main\.ts/.test(app.text()));
    await app.handle(key('down'));
    assert.match(app.text(), /\s{2}▸ deep\//);
    await app.handle(key('right'));
    await until(() => /inner\.txt/.test(app.text()));
    // ← closes it again; ← on a closed folder goes up to its parent.
    await app.handle(key('left'));
    await until(() => !/inner\.txt/.test(app.text()));
    await app.handle(key('left'));
    assert.equal(app.state.sel.files, 0, 'back on src/');

    // A file opens in a reader, scrolls, and closes.
    await app.handle(key('down'));
    await app.handle(key('down'));
    await app.handle(key('enter'));
    await until(() => /export const answer = 42;/.test(app.text()));
    assert.match(app.text(), /src\/main\.ts/);
    assert.match(app.text(), /2 lines/);
    await app.handle(key('esc'));
    assert.equal(app.state.modal, null);
    app.stop();
  } finally {
    await done(t);
  }
});
