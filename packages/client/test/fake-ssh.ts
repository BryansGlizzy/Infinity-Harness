import { createConnection, createServer, type Server, type Socket } from 'node:net';
import type { SpawnTunnel, TunnelProcess } from '../src/node/index.ts';

/** A stand-in for `ssh -L`: listens on the local port and pipes to the daemon, until killed or broken. */
export function fakeSsh(daemonPort: number) {
  const made: { server: Server; sockets: Set<Socket>; exit: (code: number | null, stderr: string) => void; blackhole: boolean }[] = [];
  const spawn: SpawnTunnel = ({ localPort }) => {
    const sockets = new Set<Socket>();
    const state = { server: null as unknown as Server, sockets, exit: (_c: number | null, _s: string) => {}, blackhole: false };
    let exitFn: ((code: number | null, stderr: string) => void) | null = null;
    state.server = createServer((client) => {
      sockets.add(client);
      client.on('close', () => sockets.delete(client));
      client.on('error', () => {});
      if (state.blackhole) return; // accepts the connection and never answers, like a dead forward
      const up = createConnection(daemonPort, '127.0.0.1');
      sockets.add(up);
      up.on('error', () => client.destroy());
      up.on('close', () => client.destroy());
      client.pipe(up);
      up.pipe(client);
    }).listen(localPort, '127.0.0.1');
    state.exit = (code, stderr) => {
      state.server.close();
      for (const s of sockets) s.destroy();
      exitFn?.(code, stderr);
    };
    made.push(state);
    const proc: TunnelProcess = { kill: () => state.exit(null, ''), onExit: (fn) => (exitFn = fn) };
    return proc;
  };
  return { spawn, made };
}

