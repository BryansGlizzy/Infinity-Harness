// The TUI's brain: state, input, actions. Drawing is views.ts, terminal control is term.ts, data is @mh/client.
import { EventStream, isLive, type DaemonApi, type Need } from '@mh/client';
import { attachTerminal, type Fleet } from '@mh/client/node';
import { CARD_STATUSES, type CardStatus } from '@mh/core';
import { Canvas } from './canvas.ts';
import { EMPTY, loadSnapshot, needKey, type Snapshot } from './data.ts';
import type { InputEvent, KeyEvent, MouseEvent } from './input.ts';
import { SeenStore } from './seen.ts';
import type { AppState, Modal, View } from './state.ts';
import { VIEWS } from './state.ts';
import type { TermIo } from './term.ts';
import { BODY_TOP, BOTTOM, boardRows, cardActions, draw, needActions } from './views.ts';

export interface AppOptions {
  fleet: Fleet;
  term: TermIo;
  seen?: SeenStore;
  /** Ring the terminal bell when something new needs you. */
  bell?: boolean;
  mouse?: boolean;
  now?: () => number;
  /** Start on this machine / board. */
  machine?: string;
  board?: string;
  /** How long an item must stay selected on screen before it counts as seen. */
  seenAfterMs?: number;
}

/** Approving these runs something on this machine, so they ask once more. */
const CONFIRM_KINDS = new Set(['install_tool', 'install_mcp']);

export class App {
  readonly state: AppState;
  canvas: Canvas | null = null;
  /** Resolves when the person quits. */
  readonly finished: Promise<void>;
  private finish!: () => void;
  private opts: AppOptions;
  private fleet: Fleet;
  private term: TermIo;
  private seen: SeenStore;
  private snaps = new Map<string, Snapshot>();
  private stream: EventStream | null = null;
  private prev: Canvas | null = null;
  private wantBoard: string | null;
  private refreshTimer: NodeJS.Timeout | undefined;
  private seenTimer: NodeJS.Timeout | undefined;
  private tick: NodeJS.Timeout | undefined;
  private offFleet: (() => void) | null = null;
  private lastState = new Map<string, string>();
  private stopped = false;
  private clock: () => number;

  constructor(opts: AppOptions) {
    this.opts = opts;
    this.fleet = opts.fleet;
    this.term = opts.term;
    this.seen = opts.seen ?? new SeenStore(null);
    this.clock = opts.now ?? Date.now;
    this.wantBoard = opts.board ?? null;
    this.finished = new Promise((resolve) => (this.finish = resolve));
    this.state = {
      endpoints: [],
      machine: opts.machine ?? 'local',
      snap: EMPTY,
      view: 'needs',
      sel: { needs: 0, board: 0, pools: 0 },
      scroll: { needs: 0, board: 0, pools: 0 },
      folded: new Set(['done']),
      modal: null,
      toast: null,
      busy: null,
      mouse: opts.mouse ?? true,
      now: this.clock(),
      isSeen: (n) => this.seen.isSeen(this.scope(), needKey(n)),
    };
  }

  private scope() {
    return `${this.state.machine}/${this.state.snap.board?.id ?? ''}`;
  }

  async start() {
    this.term.enter();
    this.term.onInput((e) => void this.handle(e));
    this.term.onResize(() => this.render());
    this.fleet.start();
    this.offFleet = this.fleet.onChange(() => this.onFleetChange());
    this.tick = setInterval(() => this.render(), 1000);
    this.tick.unref();
    this.openStream();
    this.render();
    await this.refresh();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.tick);
    clearTimeout(this.refreshTimer);
    clearTimeout(this.seenTimer);
    this.stream?.dispose();
    this.offFleet?.();
    this.fleet.stop();
    this.term.leave();
    this.finish();
  }

  // --- data

  private api(): DaemonApi | null {
    return this.fleet.get(this.state.machine)?.api ?? null;
  }

  private openStream() {
    this.stream?.dispose();
    this.stream = new EventStream(
      () => this.api()?.wsUrl('/ws') ?? 'ws://127.0.0.1:1/ws',
      (m) => {
        if (!isLive(m) && m.type !== 'session.event' && m.type !== 'card.routed') this.schedule();
      },
      () => {},
      () => this.schedule(),
    );
  }

  private onFleetChange() {
    const ep = this.fleet.get(this.state.machine);
    const before = this.lastState.get(this.state.machine);
    this.lastState.set(this.state.machine, ep?.state ?? 'none');
    if (ep?.state === 'online' && before !== 'online') {
      this.openStream();
      void this.refresh();
    }
    this.render();
  }

  private schedule() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), 300);
  }

  /** Loads the active machine's boards, cards, needs and pools. A failure keeps what was shown, with the reason. */
  async refresh(): Promise<void> {
    const api = this.api();
    const machine = this.state.machine;
    if (!api) return this.render();
    try {
      const before = this.snaps.get(machine);
      const snap = await loadSnapshot(api, this.wantBoard, this.clock());
      if (machine !== this.state.machine) return;
      this.snaps.set(machine, snap);
      this.wantBoard = snap.board?.id ?? null;
      const scope = `${machine}/${snap.board?.id ?? ''}`;
      this.seen.retain(scope, snap.needs.map(needKey));
      const fresh = snap.needs.filter((n) => !this.seen.isSeen(scope, needKey(n)) && !before?.needs.some((o) => needKey(o) === needKey(n)));
      if (fresh.length && before && this.opts.bell !== false) this.term.write('\x07');
    } catch (err) {
      const old = this.snaps.get(machine) ?? EMPTY;
      this.snaps.set(machine, { ...old, error: (err as Error).message });
    }
    this.render();
  }

  // --- drawing

  render() {
    if (this.stopped) return;
    const { width, height } = this.term.size();
    const s = this.state;
    s.now = this.clock();
    s.endpoints = this.fleet.endpoints();
    s.snap = this.snaps.get(s.machine) ?? EMPTY;
    if (s.toast && s.toast.until < s.now) s.toast = null;
    if (s.modal?.kind === 'menu' && s.modal.refresh) s.modal.items = s.modal.refresh(); // machines connect while the menu is open
    this.clamp();
    const c = new Canvas(width, height);
    draw(c, s);
    this.canvas = c;
    const same = this.prev && this.prev.width === width && this.prev.height === height;
    this.term.write((same ? '' : '\x1b[2J') + c.toAnsi(same ? this.prev : null, this.term.color));
    this.prev = c;
    this.watchSeen();
  }

  /** The plain text of the current screen (tests, and anything that cannot see colours). */
  text(): string {
    return this.canvas?.lines().join('\n') ?? '';
  }

  private clamp() {
    const s = this.state;
    const counts: Record<View, number> = { needs: s.snap.needs.length, board: boardRows(s.snap.cards, s.folded).length, pools: s.snap.pools.length };
    for (const v of ['needs', 'board', 'pools'] as const) s.sel[v] = Math.max(0, Math.min(s.sel[v], counts[v] - 1));
  }

  private selectedNeed(): Need | undefined {
    return this.state.snap.needs[this.state.sel.needs];
  }

  /** An item counts as seen once it has stayed selected on screen for a moment. */
  private watchSeen() {
    const s = this.state;
    const n = s.view === 'needs' && !s.modal ? this.selectedNeed() : undefined;
    clearTimeout(this.seenTimer);
    if (!n || s.isSeen(n)) return;
    this.seenTimer = setTimeout(() => {
      this.seen.mark(this.scope(), [needKey(n)]);
      this.render();
    }, this.opts.seenAfterMs ?? 1500);
    this.seenTimer.unref?.();
  }

  private toast(text: string, tone: 'ok' | 'bad' | 'info' = 'info') {
    this.state.toast = { text, tone, until: this.clock() + (tone === 'bad' ? 7000 : 3500) };
    this.render();
  }

  // --- input

  async handle(e: InputEvent): Promise<void> {
    if (e.type === 'mouse') this.onMouse(e);
    else await this.onKey(e);
  }

  private onMouse(e: MouseEvent) {
    if (!this.state.mouse && e.action !== 'wheel') return;
    const s = this.state;
    if (e.action === 'wheel') {
      const step = e.dir === 'up' ? -3 : 3;
      if (s.modal?.kind === 'card') s.modal.scroll = Math.max(0, s.modal.scroll + step);
      else if (s.modal?.kind === 'menu') s.modal.index = Math.max(0, Math.min(s.modal.items.length - 1, s.modal.index + (step > 0 ? 1 : -1)));
      else if (!s.modal) this.move(step);
      return this.render();
    }
    if (e.action !== 'down' || e.button !== 'left' || !this.canvas) return;
    const hit = this.canvas.hit(e.x, e.y);
    if (hit) void this.dispatch(hit.id);
  }

  private async onKey(e: KeyEvent) {
    const s = this.state;
    if (e.ctrl && e.name === 'c') return this.stop();
    const m = s.modal;
    if (m?.kind === 'prompt') return this.promptKey(m, e);
    if (m?.kind === 'menu') return this.menuKey(m, e);
    if (m?.kind === 'help') {
      if (['esc', 'q', 'enter', '?'].includes(e.name)) this.closeModal();
      return;
    }
    if (m?.kind === 'card') return this.cardKey(m, e);
    switch (e.name) {
      case 'q':
        return this.stop();
      case '?':
        s.modal = { kind: 'help' };
        return this.render();
      case 'r':
        return void (await this.refresh());
      case 'tab':
      case 'backtab': {
        const i = VIEWS.findIndex((v) => v.id === s.view);
        return this.setView(VIEWS[(i + (e.name === 'tab' ? 1 : VIEWS.length - 1)) % VIEWS.length]!.id);
      }
      case '1':
      case '2':
      case '3':
        return this.setView(VIEWS[Number(e.name) - 1]!.id);
      case 'M':
        return this.openMachineMenu();
      case 'B':
        return this.openBoardMenu();
      case 'up':
      case 'k':
        return this.move(-1);
      case 'down':
      case 'j':
        return this.move(1);
      case 'pageup':
        return this.move(-8);
      case 'pagedown':
        return this.move(8);
      case 'home':
      case 'g':
        return this.move(-1e6);
      case 'end':
      case 'G':
        return this.move(1e6);
      case 'enter':
      case ' ':
        return this.activate();
    }
    if (s.view === 'needs') {
      const n = this.selectedNeed();
      const action = n ? needActions(n).find((a) => a.key === e.name) : undefined;
      if (action) return this.needAction(action.id);
    }
    if (s.view === 'board' && e.name === 'f') {
      const row = boardRows(s.snap.cards, s.folded)[s.sel.board];
      if (row?.kind === 'header') this.toggleFold(row.status);
    }
  }

  private setView(v: View) {
    this.state.view = v;
    this.render();
  }

  private move(by: number) {
    const s = this.state;
    const total = s.view === 'needs' ? s.snap.needs.length : s.view === 'board' ? boardRows(s.snap.cards, s.folded).length : s.snap.pools.length;
    s.sel[s.view] = Math.max(0, Math.min(total - 1, s.sel[s.view] + by));
    this.render();
  }

  private toggleFold(status: CardStatus) {
    const f = this.state.folded;
    if (!f.delete(status)) f.add(status);
    this.render();
  }

  private activate() {
    const s = this.state;
    if (s.view === 'board') {
      const row = boardRows(s.snap.cards, s.folded)[s.sel.board];
      if (row?.kind === 'header') this.toggleFold(row.status);
      else if (row) this.openCard(row.card.id);
    } else if (s.view === 'needs') {
      // Opening shows context; it never decides anything. Approving takes its own button or key.
      const n = this.selectedNeed();
      if (n?.cardId) this.openCard(n.cardId);
    }
  }

  // --- clicks

  async dispatch(id: string): Promise<void> {
    const s = this.state;
    const [kind, a, b] = id.split(':');
    switch (kind) {
      case 'tab':
        this.closeModal();
        return this.setView(a as View);
      case 'machine':
        return this.openMachineMenu();
      case 'board':
        return this.openBoardMenu();
      case 'refresh':
        return void (await this.refresh());
      case 'quit':
        return this.stop();
      case 'help':
        s.modal = { kind: 'help' };
        return this.render();
      case 'row': {
        const view = a as View;
        const i = Number(b);
        const wasSelected = s.sel[view] === i;
        s.sel[view] = i;
        s.view = view;
        if (view === 'board') {
          const row = boardRows(s.snap.cards, s.folded)[i];
          if (row?.kind === 'header') return this.toggleFold(row.status);
          if (row) return this.openCard(row.card.id);
        }
        if (view === 'needs' && wasSelected) return this.activate();
        return this.render();
      }
      case 'act':
        return this.needAction(a!);
      case 'card':
        return this.cardAction(a!);
      case 'menu': {
        const m = s.modal;
        if (m?.kind === 'menu') {
          m.index = Number(a);
          return this.menuPick(m);
        }
        return;
      }
      case 'prompt':
        if (s.modal?.kind === 'prompt') return a === 'submit' ? this.promptSubmit(s.modal) : this.closeModal();
        return;
      case 'modal':
        if (a === 'close' || (a === 'backdrop' && s.modal?.kind !== 'prompt')) this.closeModal();
        return;
    }
  }

  private closeModal() {
    this.state.modal = null;
    this.render();
  }

  // --- modals

  private promptKey(m: Extract<Modal, { kind: 'prompt' }>, e: KeyEvent) {
    if (e.name === 'esc') return this.closeModal();
    if (e.name === 'enter') return this.promptSubmit(m);
    if (e.name === 'backspace') m.value = m.value.slice(0, -1);
    else if (e.ctrl && e.name === 'u') m.value = '';
    else if (e.text && !e.ctrl) m.value += e.text;
    this.render();
  }

  private promptSubmit(m: Extract<Modal, { kind: 'prompt' }>) {
    const value = m.value.trim();
    if (m.required && !value) return this.toast('Write something first.', 'bad');
    this.state.modal = null;
    m.submit(value);
    this.render();
  }

  private menuKey(m: Extract<Modal, { kind: 'menu' }>, e: KeyEvent) {
    if (e.name === 'esc' || e.name === 'q') return this.closeModal();
    if (e.name === 'up' || e.name === 'k') m.index = Math.max(0, m.index - 1);
    else if (e.name === 'down' || e.name === 'j') m.index = Math.min(m.items.length - 1, m.index + 1);
    else if (e.name === 'enter') return this.menuPick(m);
    else if (/^[1-9]$/.test(e.name) && m.items[Number(e.name) - 1]) {
      m.index = Number(e.name) - 1;
      return this.menuPick(m);
    }
    this.render();
  }

  private menuPick(m: Extract<Modal, { kind: 'menu' }>) {
    const item = m.items[m.index];
    if (!item || item.disabled) return;
    this.state.modal = null;
    m.pick(item.id);
    this.render();
  }

  private prompt(title: string, hint: string, required: boolean, submit: (v: string) => void) {
    this.state.modal = { kind: 'prompt', title, hint, value: '', required, submit };
    this.render();
  }

  private openMachineMenu() {
    const items = () =>
      this.fleet.endpoints().map((e) => ({ id: e.label, label: `${e.state === 'online' ? '●' : e.state === 'attention' ? '!' : '◌'} ${e.label}`, detail: e.state === 'online' ? '' : (e.error ?? e.state) }));
    this.state.modal = {
      kind: 'menu',
      title: 'Machines',
      index: Math.max(0, this.fleet.endpoints().findIndex((e) => e.label === this.state.machine)),
      items: items(),
      refresh: items,
      pick: (label) => this.switchMachine(label),
    };
    this.render();
  }

  private openBoardMenu() {
    const boards = this.state.snap.boards;
    if (!boards.length) return this.toast('No boards on this machine.', 'info');
    this.state.modal = {
      kind: 'menu',
      title: 'Boards',
      index: Math.max(0, boards.findIndex((b) => b.id === this.state.snap.board?.id)),
      items: boards.map((b) => ({ id: b.id, label: b.name, detail: b.mode })),
      pick: (id) => {
        this.wantBoard = id;
        this.state.sel = { needs: 0, board: 0, pools: 0 };
        void this.refresh();
      },
    };
    this.render();
  }

  private switchMachine(label: string) {
    if (label === this.state.machine) return;
    this.state.machine = label;
    this.wantBoard = null;
    this.state.sel = { needs: 0, board: 0, pools: 0 };
    this.state.scroll = { needs: 0, board: 0, pools: 0 };
    this.openStream();
    this.render();
    void this.refresh();
  }

  private openCard(cardId: string) {
    const modal: Modal = { kind: 'card', cardId, scroll: 0, changes: null };
    this.state.modal = modal;
    this.render();
    void this.api()?.changes(cardId).then(
      (changes) => {
        if (this.state.modal === modal) {
          modal.changes = changes;
          this.render();
        }
      },
      () => {},
    );
  }

  private cardKey(m: Extract<Modal, { kind: 'card' }>, e: KeyEvent) {
    if (e.name === 'esc' || e.name === 'q') return this.closeModal();
    if (e.name === 'up' || e.name === 'k') m.scroll = Math.max(0, m.scroll - 1);
    else if (e.name === 'down' || e.name === 'j') m.scroll += 1;
    else {
      const card = this.state.snap.cards.find((c) => c.id === m.cardId);
      const action = card ? cardActions(card).find((a) => a.key === e.name) : undefined;
      if (action) return this.cardAction(action.id);
    }
    this.render();
  }

  // --- actions

  private async run(label: string, fn: (api: DaemonApi) => Promise<unknown>, ok: string) {
    const api = this.api();
    if (!api) return this.toast(`${this.state.machine} is not connected right now.`, 'bad');
    this.state.busy = label;
    this.render();
    try {
      await fn(api);
      this.state.busy = null;
      this.toast(ok, 'ok');
      await this.refresh();
    } catch (err) {
      this.state.busy = null;
      this.toast((err as Error).message, 'bad');
    }
  }

  private async needAction(id: string): Promise<void> {
    const n = this.selectedNeed();
    if (!n) return;
    switch (id) {
      case 'approve':
        if (CONFIRM_KINDS.has(n.approvalKind ?? '')) {
          this.state.modal = {
            kind: 'menu',
            title: 'This runs on this machine',
            index: 1,
            items: [{ id: 'yes', label: `Approve: ${n.title}` }, { id: 'no', label: 'Cancel' }],
            pick: (pick) => pick === 'yes' && void this.run('Approving', (api) => api.decide(n.id, 'approve'), 'Approved.'),
          };
          return this.render();
        }
        return this.run('Approving', (api) => api.decide(n.id, 'approve'), 'Approved.');
      case 'answer':
        return this.prompt('Your answer', n.title, true, (note) => void this.run('Answering', (api) => api.decide(n.id, 'approve', note), 'Answered; the card runs again.'));
      case 'deny':
        return this.prompt('Why not? (optional)', n.title, false, (note) => void this.run('Denying', (api) => api.decide(n.id, 'deny', note || undefined), 'Denied.'));
      case 'open':
        return n.cardId ? this.openCard(n.cardId) : undefined;
      case 'review-approve':
        return this.run('Approving', (api) => api.review(n.cardId!, 'approve'), 'Approved for landing.');
      case 'review-changes':
        return this.prompt('What should change?', n.title, true, (notes) => void this.run('Sending back', (api) => api.review(n.cardId!, 'changes', notes), 'Sent back with your notes.'));
      case 'message':
        return this.prompt('Message to the agent', n.title, true, (text) => void this.run('Sending', (api) => api.sendMessage(n.cardId!, text), 'Sent.'));
      case 'retry':
        return this.run('Retrying', (api) => api.moveCard(n.cardId!, 'ready'), 'Moved to Ready.');
      case 'pass':
      case 'fail':
      case 'ignore':
        return this.run('Saving', (api) => api.reviewOutcome(Number(n.id), id), 'Noted.');
    }
  }

  private async cardAction(id: string): Promise<void> {
    const m = this.state.modal;
    if (m?.kind !== 'card') return;
    const card = this.state.snap.cards.find((c) => c.id === m.cardId);
    if (!card) return;
    const again = () => this.openCard(card.id);
    switch (id) {
      case 'review-approve':
        this.state.modal = null;
        return this.run('Approving', (api) => api.review(card.id, 'approve'), 'Approved for landing.');
      case 'review-changes':
        return this.prompt('What should change?', card.title, true, (notes) => void this.run('Sending back', (api) => api.review(card.id, 'changes', notes), 'Sent back with your notes.'));
      case 'land':
        this.state.modal = null;
        return this.run('Landing', (api) => api.land(card.id), 'Landing started.');
      case 'message':
        return this.prompt('Message to the agent', card.title, true, (text) => void this.run('Sending', (api) => api.sendMessage(card.id, text), 'Sent.').then(again));
      case 'move':
        this.state.modal = {
          kind: 'menu',
          title: 'Move to',
          index: Math.max(0, CARD_STATUSES.indexOf(card.status)),
          items: CARD_STATUSES.map((st) => ({ id: st, label: st.replace('_', ' ') })),
          pick: (st) => void this.run('Moving', (api) => api.moveCard(card.id, st as CardStatus), `Moved to ${st.replace('_', ' ')}.`),
        };
        return this.render();
      case 'cancel':
        return this.run('Stopping', (api) => api.cancel(card.id), 'Stopped.');
      case 'terminal':
        return this.attach(card.id);
    }
  }

  private async attach(cardId: string) {
    const api = this.api();
    if (!api) return this.toast('Not connected.', 'bad');
    if (!this.term.stdin || !this.term.stdout) return this.toast('Attaching needs a real terminal.', 'bad');
    this.term.suspend();
    let result = 'ended';
    try {
      this.term.stdout.write('\x1b[2J\x1b[H');
      result = await attachTerminal(api, cardId, { stdin: this.term.stdin, stdout: this.term.stdout });
    } finally {
      this.term.resume();
      this.prev = null;
      this.render();
    }
    if (result === 'unavailable') this.toast('Only Claude sessions have a live terminal, and this card has none right now.', 'bad');
  }
}
