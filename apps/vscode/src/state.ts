import * as vscode from 'vscode';
import type { Approval, Board, Card, DaemonEvent, LiveMessage, Message, Outcome } from '@mh/core';
import { DaemonClient, EventStream, type PoolSummary, type UsageSummary } from './client.ts';
import { boardsForFolders } from './match.ts';

export { folderInRepo } from './match.ts';

/** offline: daemon unreachable · noFolder: nothing open · noBoard: folder has no board · ready: bound to a board. */
export type HarnessState = 'offline' | 'noFolder' | 'noBoard' | 'ready';

const BOARD_KEY = 'infinityHarness.boardId';

/**
 * The workspace's board and everything the views show about it, kept current from the daemon's event stream.
 * One instance per window.
 */
export class HarnessModel implements vscode.Disposable {
  readonly client: DaemonClient;
  state: HarnessState = 'offline';
  board: Board | null = null;
  /** Every board this workspace's folders map to (for Switch Board). */
  candidates: Board[] = [];
  cards: Card[] = [];
  /** Messages agents (and the daemon) sent to the humans. */
  inbox: Message[] = [];
  /** Blocks waiting for a human to weigh them. */
  pending: Outcome[] = [];
  /** Cards with a live Claude terminal. */
  terminals = new Set<string>();
  /** Requests waiting for a decision: escalations, new agents, MCP servers, skills, tool grants. */
  approvals: Approval[] = [];
  /** Pools with their live state, and today's usage and budgets, for the status bar tooltip. */
  pools: PoolSummary[] = [];
  usage: UsageSummary | null = null;

  private stream: EventStream;
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private eventEmitter = new vscode.EventEmitter<DaemonEvent>();
  /** Every stored event for this board's cards (for notifications). */
  readonly onEvent = this.eventEmitter.event;
  private refreshing: Promise<void> | null = null;
  private refreshTimer: NodeJS.Timeout | undefined;

  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.client = new DaemonClient(this.daemonUrl(), this.apiToken());
    this.stream = new EventStream(
      () => this.client.wsUrl('/ws'),
      (e) => this.onStreamEvent(e),
      (connected) => {
        if (connected || this.state !== 'offline') void this.refresh();
      },
    );
  }

  daemonUrl(): string {
    return vscode.workspace.getConfiguration('infinityHarness').get<string>('daemonUrl') || 'http://127.0.0.1:7420';
  }

  apiToken(): string {
    return vscode.workspace.getConfiguration('infinityHarness').get<string>('apiToken') || '';
  }

  folders(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
  }

  /** Re-reads the URL setting and reconnects. */
  reconfigure() {
    this.client.baseUrl = this.daemonUrl();
    this.client.token = this.apiToken();
    this.stream.reconnect();
    void this.refresh();
  }

  /** Reloads boards, cards and the attention lists. Concurrent calls share one load. */
  refresh(): Promise<void> {
    this.refreshing ??= this.load().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  /** Coalesces bursts of events (a card's session emits many) into one reload. */
  private soon() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), 400);
  }

  private async load() {
    const folders = this.folders();
    if (!(await this.client.healthy())) return this.set('offline');
    if (!folders.length) return this.set('noFolder');
    try {
      this.candidates = boardsForFolders(await this.client.boards(), folders);
      const chosen = this.context.workspaceState.get<string>(BOARD_KEY);
      this.board = this.candidates.find((b) => b.id === chosen) ?? this.candidates[0] ?? null;
      if (!this.board) {
        this.cards = [];
        this.inbox = [];
        this.pending = [];
        this.approvals = [];
        return this.set('noBoard');
      }
      const id = this.board.id;
      const [cards, messages, pending] = await Promise.all([this.client.cards(id), this.client.messages(id), this.client.pendingOutcomes(id)]);
      this.cards = cards;
      this.inbox = messages.filter((m) => m.toCard === null && !m.fromActor.startsWith('user:'));
      this.pending = pending;
      // Newer daemon endpoints: a daemon without them just shows less.
      [this.approvals, this.pools, this.usage] = await Promise.all([
        this.client.approvals(id).catch(() => []),
        this.client.pools().catch(() => []),
        this.client.usage(id, 24).catch(() => null),
      ]);
      // Which running cards have a terminal to attach (Claude sessions).
      const running = cards.filter((c) => c.status === 'in_progress' && c.poolId === 'claude');
      const live = await Promise.all(running.map((c) => this.client.terminal(c.id).then((t) => (t.available ? c.id : null), () => null)));
      this.terminals = new Set(live.filter((x): x is string => x !== null));
      this.set('ready');
    } catch {
      this.set('offline');
    }
  }

  private set(state: HarnessState) {
    this.state = state;
    void vscode.commands.executeCommand('setContext', 'infinityHarness.state', state);
    this.changed.fire();
  }

  async chooseBoard(boardId: string) {
    await this.context.workspaceState.update(BOARD_KEY, boardId);
    await this.refresh();
  }

  card(id: string): Card | undefined {
    return this.cards.find((c) => c.id === id);
  }

  private onStreamEvent(e: DaemonEvent | LiveMessage) {
    if ('live' in e) return;
    if (!this.board) {
      if (e.type === 'board.created') this.soon();
      return;
    }
    const mine =
      e.subject === this.board.id ||
      this.cards.some((c) => c.id === e.subject) ||
      (e.type === 'card.created' && (e.payload as Card).boardId === this.board.id) ||
      (e.type === 'message.posted' && (e.payload as Message).boardId === this.board.id) ||
      ((e.type === 'approval.created' || e.type === 'approval.decided') && (e.payload as Approval).boardId === this.board.id);
    if (!mine) return;
    this.eventEmitter.fire(e);
    // Session chatter doesn't change what the views show; everything else may.
    if (e.type !== 'session.event' && e.type !== 'card.routed') this.soon();
  }

  dispose() {
    clearTimeout(this.refreshTimer);
    this.stream.dispose();
    this.changed.dispose();
    this.eventEmitter.dispose();
  }
}
