import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from './api.ts';

/** Live view of a card's agent terminal. Keystrokes go to the agent, so this is a full takeover. */
export function TerminalView({ cardId }: { cardId: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current) return;
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: 12,
      cursorBlink: true,
      theme: dark ? { background: '#0d1014' } : { background: '#ffffff', foreground: '#1b1f24', cursor: '#1b1f24' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);

    const socket = new WebSocket(api.wsUrl(`/ws/terminal/${cardId}`));
    const sendSize = () => {
      try {
        fit.fit();
      } catch {
        return; // not laid out yet
      }
      if (socket.readyState === WebSocket.OPEN) socket.send(`\x00resize:${term.cols}x${term.rows}`);
    };
    socket.onopen = sendSize;
    socket.onmessage = (msg) => term.write(String(msg.data));
    socket.onclose = () => term.write('\r\n\x1b[2m[terminal closed]\x1b[0m\r\n');
    const input = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    });
    const observer = new ResizeObserver(sendSize);
    observer.observe(host.current);

    return () => {
      observer.disconnect();
      input.dispose();
      socket.close();
      term.dispose();
    };
  }, [cardId]);

  return <div className="terminal" ref={host} />;
}
