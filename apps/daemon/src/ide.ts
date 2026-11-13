import { newId } from '@ih/core';

// The IDE bridge (master plan Phase 6.1, stage 2). A VS Code window bound to a board connects to `/ws/ide` and answers
// requests the daemon sends on behalf of agents: a quick pick for the human (`ide_ask`), the language server's problems
// for files in a card's worktree (`ide_diagnostics`), and a proposed change opened in the diff editor (`ide_show_diff`).

export type IdeRequestType = 'ask' | 'diagnostics' | 'show_diff';

/** What the daemon needs of a socket, so tests can use a stand-in. */
export interface IdeSocket {
  send(data: string): void;
  on(event: 'message' | 'close', fn: (data?: Buffer) => void): void;
}

interface Client {
  socket: IdeSocket;
  boardId: string;
  name: string;
  attachedAt: number;
}

interface Pending {
  resolve: (v: unknown) => void;
  client: Client;
  timer: NodeJS.Timeout;
}

export class IdeBridge {
  private clients = new Set<Client>();
  private pending = new Map<string, Pending>();

  /** Registers a window for a board. The newest window answers; when it closes, requests waiting on it end as unanswered. */
  attach(boardId: string, socket: IdeSocket, name = 'VS Code'): void {
    const client: Client = { socket, boardId, name, attachedAt: Date.now() };
    this.clients.add(client);
    socket.on('message', (data) => this.onMessage(client, data?.toString() ?? ''));
    socket.on('close', () => {
      this.clients.delete(client);
      for (const [id, p] of this.pending) {
        if (p.client !== client) continue;
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.resolve(null);
      }
    });
  }

  /** True when a window is attached to the board, i.e. agents on it get the `ide_*` tools. */
  attached(boardId: string): boolean {
    return [...this.clients].some((c) => c.boardId === boardId);
  }

  windows(boardId: string): string[] {
    return [...this.clients].filter((c) => c.boardId === boardId).map((c) => c.name);
  }

  private onMessage(client: Client, raw: string) {
    let msg: { id?: string; result?: unknown; error?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const p = msg.id ? this.pending.get(msg.id) : undefined;
    if (!p || p.client !== client) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id!);
    p.resolve(msg.error ? { error: msg.error } : (msg.result ?? {}));
  }

  /**
   * Sends a request to the board's newest window and waits for its answer. Resolves null when no window is attached,
   * it closes, or the timeout passes; `{ error }` when the window could not do it.
   */
  request<T = unknown>(boardId: string, type: IdeRequestType, params: Record<string, unknown>, timeoutMs: number): Promise<T | { error: string } | null> {
    const client = [...this.clients].filter((c) => c.boardId === boardId).sort((a, b) => b.attachedAt - a.attachedAt)[0];
    if (!client) return Promise.resolve(null);
    const id = newId('ide');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, client, timer });
      try {
        client.socket.send(JSON.stringify({ id, type, ...params }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(null);
      }
    });
  }
}
