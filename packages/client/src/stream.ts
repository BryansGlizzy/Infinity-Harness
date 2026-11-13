import type { DaemonEvent, LiveMessage } from '@ih/core';

/** After a drop shorter than this, the daemon replays what was missed; after a longer one the client just reloads. */
export const REPLAY_WITHIN_MS = 10 * 60_000;

export type StreamMessage = DaemonEvent | LiveMessage;
export const isLive = (m: StreamMessage): m is LiveMessage => 'live' in m;

/** What a `stream.status` message says (sent when the client asked for `since`). `lost` means: reload everything. */
export interface StreamStatus {
  latest: number;
  replayed: number;
  lost: 'ahead' | 'too_many' | 'invalid' | null;
}

/**
 * The daemon's live event stream, reconnecting with backoff. After a drop it asks for everything since the last event
 * it saw (`/ws?since=`), so nothing is missed and nothing repeats; `onState` reports connected / disconnected.
 * Uses the platform's WebSocket (browsers, Node 22+).
 */
export class EventStream {
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retry = 500;
  private closed = false;
  /** Newest event seen; a reconnect asks the daemon for everything after it. */
  private lastSeq: number | null = null;
  private lostAt = 0;
  private resyncOnOpen = false;
  private url: () => string;
  private onEvent: (e: StreamMessage) => void;
  private onState: (connected: boolean) => void;
  private onResync: () => void;

  /**
   * `onResync` is called when continuity was lost and the caller must reload what it shows: the daemon could not replay
   * the gap (`lost`), or the connection was down so long that no replay was asked for.
   */
  constructor(url: () => string, onEvent: (e: StreamMessage) => void, onState: (connected: boolean) => void = () => {}, onResync: () => void = () => {}) {
    this.url = url;
    this.onEvent = onEvent;
    this.onState = onState;
    this.onResync = onResync;
    this.open();
  }

  /** The newest event this stream has delivered (null before the first message). */
  get position(): number | null {
    return this.lastSeq;
  }

  private open() {
    if (this.closed) return;
    let socket: WebSocket;
    try {
      const url = new URL(this.url());
      // Catch up from where we left off, unless we were away long enough that a flood of old events would only be noise.
      const away = this.lostAt ? Date.now() - this.lostAt : 0;
      const replay = this.lastSeq !== null && away < REPLAY_WITHIN_MS;
      if (this.lastSeq !== null && !replay) this.resyncOnOpen = true;
      url.searchParams.set('since', replay ? String(this.lastSeq) : 'now');
      socket = new WebSocket(url.toString());
    } catch {
      this.schedule();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.retry = 500;
      this.lostAt = 0;
      this.onState(true);
      if (this.resyncOnOpen) {
        this.resyncOnOpen = false;
        this.onResync();
      }
    };
    socket.onmessage = (msg) => {
      try {
        const event = JSON.parse(String(msg.data)) as StreamMessage;
        if (isLive(event)) {
          if (event.type === 'stream.status') {
            const status = event.payload as StreamStatus;
            this.lastSeq = status.latest;
            if (status.lost) this.onResync();
          }
        } else this.lastSeq = Math.max(this.lastSeq ?? 0, event.seq);
        this.onEvent(event);
      } catch {
        // not an event
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.lostAt ||= Date.now();
      this.onState(false);
      this.schedule();
    };
    socket.onerror = () => socket.close();
  }

  private schedule() {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.open(), this.retry);
    this.retry = Math.min(this.retry * 2, 15_000);
  }

  /** Reconnects now (e.g. after the daemon was started or its URL changed). */
  reconnect() {
    this.retry = 500;
    const s = this.socket;
    this.socket = null;
    s?.close();
    clearTimeout(this.timer);
    this.open();
  }

  dispose() {
    this.closed = true;
    clearTimeout(this.timer);
    this.socket?.close();
  }
}
