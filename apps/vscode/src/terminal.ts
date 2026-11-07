import * as vscode from 'vscode';
import type { HarnessModel } from './state.ts';

const open = new Map<string, vscode.Terminal>();

/**
 * A VS Code terminal attached to a card's live Claude session (the daemon's `/ws/terminal/<card>`): scrollback first,
 * then live output; what you type goes to the agent's TUI, so you can watch it or take over.
 */
export function attachTerminal(model: HarnessModel, cardId: string): void {
  const existing = open.get(cardId);
  if (existing && existing.exitStatus === undefined) {
    existing.show();
    return;
  }
  const card = model.card(cardId);
  const write = new vscode.EventEmitter<string>();
  const close = new vscode.EventEmitter<number | void>();
  let socket: WebSocket | null = null;
  let size: vscode.TerminalDimensions | undefined;
  const sendSize = () => {
    if (size && socket?.readyState === WebSocket.OPEN) socket.send(`\x00resize:${size.columns}x${size.rows}`);
  };

  const pty: vscode.Pseudoterminal = {
    onDidWrite: write.event,
    onDidClose: close.event,
    open: (dims) => {
      size = dims;
      socket = new WebSocket(model.client.wsUrl(`/ws/terminal/${cardId}`));
      socket.binaryType = 'arraybuffer';
      socket.onopen = sendSize;
      socket.onmessage = (msg) => write.fire(typeof msg.data === 'string' ? msg.data : new TextDecoder().decode(msg.data as ArrayBuffer));
      socket.onclose = () => {
        write.fire('\r\n[session detached]\r\n');
        close.fire();
      };
      socket.onerror = () => write.fire('\r\n[could not reach the daemon]\r\n');
    },
    close: () => socket?.close(),
    handleInput: (data) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(data);
    },
    setDimensions: (dims) => {
      size = dims;
      sendSize();
    },
  };
  const terminal = vscode.window.createTerminal({
    name: `Agent: ${card?.title.slice(0, 40) ?? cardId}`,
    pty,
    iconPath: new vscode.ThemeIcon('hubot'),
  });
  open.set(cardId, terminal);
  terminal.show();
}

export function disposeTerminals() {
  for (const t of open.values()) t.dispose();
  open.clear();
}
