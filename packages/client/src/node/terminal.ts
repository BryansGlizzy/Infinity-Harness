// Attach this terminal to a card's live terminal (a Claude session), like `tmux attach`: the daemon replays the
// scrollback, then streams; keys and the window size go back. No terminal emulator is needed: the bytes already
// are a terminal's output, and the real terminal draws them.
import type { DaemonApi } from '../api.ts';

export interface AttachIo {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}
export interface AttachOptions {
  /** The byte that detaches. Default Ctrl+] (0x1d), as in telnet; Ctrl+C goes to the agent. */
  detachByte?: number;
  /** For tests. */
  WebSocket?: typeof WebSocket;
}

export type AttachResult = 'detached' | 'ended' | 'unavailable';

export const DETACH_HINT = 'Ctrl+] detaches';

export async function attachTerminal(api: DaemonApi, cardId: string, io: AttachIo, opts: AttachOptions = {}): Promise<AttachResult> {
  const detach = opts.detachByte ?? 0x1d;
  const available = await api.terminal(cardId).catch(() => ({ available: false }));
  if (!available.available) return 'unavailable';
  const Socket = opts.WebSocket ?? WebSocket;
  const socket = new Socket(api.wsUrl(`/ws/terminal/${cardId}`));
  const { stdin, stdout } = io;
  const wasRaw = stdin.isTTY ? stdin.isRaw : false;

  return new Promise<AttachResult>((resolve) => {
    const sendSize = () => {
      if (socket.readyState === Socket.OPEN && stdout.columns && stdout.rows) socket.send(`\x00resize:${stdout.columns}x${stdout.rows}`);
    };
    const onData = (chunk: Buffer) => {
      if (chunk.includes(detach)) return finish('detached');
      if (socket.readyState === Socket.OPEN) socket.send(chunk.toString('utf8'));
    };
    let done = false;
    function finish(result: AttachResult) {
      if (done) return;
      done = true;
      stdin.off('data', onData);
      stdout.off('resize', sendSize);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve(result);
    }
    socket.onopen = () => {
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', onData);
      stdout.on('resize', sendSize);
      sendSize();
    };
    socket.onmessage = (m) => stdout.write(typeof m.data === 'string' ? m.data : Buffer.from(m.data as ArrayBuffer));
    socket.onclose = () => finish('ended');
    socket.onerror = () => finish('ended');
  });
}
