import { DaemonApi, DaemonHttp } from '@mh/client';
import { MachineCatalog, MachineConnection, defaultCatalogFile, parseScoped, LOCAL } from '@mh/client/node';
import type { Board, Card } from '@mh/core';
import { UsageError, type Io } from './io.ts';

export interface Flags {
  machine?: string;
  url?: string;
  token?: string;
  board?: string;
}

export interface Target {
  api: DaemonApi;
  /** `local` or the machine's label. */
  label: string;
  close(): void;
}

export const catalogOf = (io: Io) => new MachineCatalog(defaultCatalogFile(io.env));

/** Connects to this machine's daemon, or to a saved machine through an SSH forward. */
export async function connect(io: Io, flags: Flags, machine?: string): Promise<Target> {
  const label = machine ?? flags.machine ?? io.env.IH_MACHINE ?? LOCAL;
  if (label === LOCAL) {
    const http = new DaemonHttp({ baseUrl: flags.url ?? io.env.IH_URL ?? 'http://127.0.0.1:7420', token: flags.token ?? io.env.IH_TOKEN ?? '', timeoutMs: 20_000 });
    const api = new DaemonApi(http);
    try {
      await api.health();
    } catch (err) {
      throw new Error(`no Infinity Harness daemon at ${http.baseUrl} (${(err as Error).message}). Start it with \`pnpm start\`, or point IH_URL / --url at it.`);
    }
    return { api, label, close: () => {} };
  }
  const profile = catalogOf(io).find(label);
  if (!profile) throw new UsageError(`no saved machine "${label}". Saved machines: ${catalogOf(io).list().map((m) => m.label).join(', ') || 'none'}. Add one with \`ih machine add\`.`);
  if (!profile.enabled) throw new UsageError(`machine "${label}" is disabled (\`ih machine enable ${label}\`)`);
  const conn = new MachineConnection(profile, io.connection);
  conn.start();
  try {
    await conn.ready(30_000);
  } catch (err) {
    conn.stop();
    throw new Error(`cannot reach "${label}": ${(err as Error).message}${conn.attention === 'hostkey' ? ' (run `ssh ' + profile.target + '` once to approve its host key)' : ''}`);
  }
  return { api: conn.api, label, close: () => conn.stop() };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The board named by a flag (id, exact name, or unique id prefix), else the only board, else the one holding the current folder. */
export async function resolveBoard(api: DaemonApi, flag: string | undefined, io: Io): Promise<Board> {
  const boards = await api.boards();
  const want = flag ?? io.env.IH_BOARD;
  if (want) {
    const hit = boards.find((b) => b.id === want) ?? boards.find((b) => same(b.name, want)) ?? (boards.filter((b) => b.id.startsWith(want)).length === 1 ? boards.find((b) => b.id.startsWith(want)) : undefined);
    if (!hit) throw new UsageError(`no board "${want}". Boards: ${boards.map((b) => `${b.name} (${b.id})`).join(', ') || 'none'}`);
    return hit;
  }
  if (boards.length === 1) return boards[0]!;
  if (!boards.length) throw new UsageError('there are no boards yet. Create one in the web UI or VS Code, or with `ih board create`.');
  const inside = boards
    .filter((b) => io.cwd === b.repoPath || io.cwd.startsWith(b.repoPath.replace(/\/$/, '') + '/'))
    .sort((a, b) => b.repoPath.length - a.repoPath.length)[0];
  if (inside) return inside;
  throw new UsageError(`which board? Use --board with one of: ${boards.map((b) => `${b.name} (${b.id})`).join(', ')}`);
}

/** A card by full id or unique id prefix, on the resolved board (or on any board when a full id is given). */
export async function resolveCard(api: DaemonApi, ref: string, flags: Flags, io: Io): Promise<{ card: Card; board: Board }> {
  const boards = flags.board || io.env.IH_BOARD ? [await resolveBoard(api, flags.board, io)] : await api.boards();
  const found: { card: Card; board: Board }[] = [];
  for (const board of boards) {
    for (const card of await api.cards(board.id)) {
      if (card.id === ref) return { card, board };
      if (card.id.startsWith(ref)) found.push({ card, board });
    }
  }
  if (found.length === 1) return found[0]!;
  if (found.length > 1) throw new UsageError(`"${ref}" matches ${found.length} cards (${found.slice(0, 4).map((f) => f.card.id).join(', ')}…); type more of the id`);
  throw new UsageError(`no card "${ref}"`);
}

/** `laptop:c_12ab` → the machine and the id; a bare id uses the machine from the flags. */
export const splitRef = (ref: string) => {
  const { machine, id } = parseScoped(ref, '');
  return { machine: machine || undefined, id };
};
