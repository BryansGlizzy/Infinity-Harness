import { MachineConnection, DEFAULT_REMOTE_PORT } from '@ih/client/node';
import { catalogOf } from './context.ts';
import type { Command } from './commands.ts';
import { table } from './format.ts';
import { UsageError } from './io.ts';

const str = (v: string | boolean | undefined) => (typeof v === 'string' ? v : undefined);
const port = (v: string | undefined, what: string) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new UsageError(`${what} must be a number`);
  return n;
};

/** A one-off connection, to check a machine or to hold a port open. */
async function tryConnect(c: MachineConnection, ms = 25_000): Promise<string | null> {
  c.start();
  try {
    await c.ready(ms);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

export const MACHINE: Command = {
  name: 'machine',
  usage: 'ih machine list | add <ssh-target> | remove|rename|enable|disable <machine> | status [machine] | forward <machine>',
  summary: 'Saved machines: other computers\' daemons, reached over SSH',
  options: {
    label: { type: 'string', short: 'l' },
    'daemon-port': { type: 'string', hint: String(DEFAULT_REMOTE_PORT) },
    'ssh-port': { type: 'string' },
    root: { type: 'string', hint: 'Infinity Harness folder on that machine' },
    'no-check': { type: 'boolean' },
    port: { type: 'string', hint: 'local port for forward' },
  },
  async run(ctx) {
    const [sub, ...rest] = ctx.args;
    const catalog = catalogOf(ctx.io);
    switch (sub) {
      case undefined:
      case 'list': {
        const all = catalog.list();
        ctx.print(all, () => (all.length ? table(all.map((m) => [m.id, m.label, m.target + (m.sshPort ? `:${m.sshPort}` : ''), String(m.remotePort), m.enabled ? 'yes' : 'no']), ['ID', 'LABEL', 'SSH', 'DAEMON PORT', 'ENABLED']) : 'No saved machines. Add one: ih machine add user@host --label name\n'));
        return;
      }
      case 'add': {
        const target = rest[0];
        if (!target) throw new UsageError('give the SSH target: ih machine add user@host --label name');
        const fields = { label: str(ctx.values.label) ?? target, target, sshPort: port(str(ctx.values['ssh-port']), 'the SSH port'), remotePort: port(str(ctx.values['daemon-port']), 'the daemon port'), remoteRoot: str(ctx.values.root) };
        const probe = { id: 'm_check', enabled: true, ...{ label: fields.label, target, remotePort: fields.remotePort ?? DEFAULT_REMOTE_PORT, sshPort: fields.sshPort, remoteRoot: fields.remoteRoot } };
        // Validate before connecting, so a bad target never reaches ssh.
        const saved = catalog.add({ ...fields });
        if (!ctx.values['no-check']) {
          const conn = new MachineConnection({ ...probe, id: saved.id }, ctx.io.connection);
          const problem = await tryConnect(conn);
          conn.stop();
          if (problem) {
            catalog.remove(saved.id);
            throw new Error(`not saved: cannot reach "${saved.label}" (${problem}). Fix that, or use --no-check to save it anyway.`);
          }
        }
        ctx.print(saved, () => `saved "${saved.label}" (${saved.target}, daemon port ${saved.remotePort}). Use it with --machine ${saved.label}\n`);
        return;
      }
      case 'remove':
      case 'rename':
      case 'enable':
      case 'disable': {
        const which = rest[0];
        if (!which) throw new UsageError(`which machine? ih machine ${sub} <machine>`);
        const m = sub === 'remove' ? catalog.remove(which) : sub === 'rename' ? catalog.rename(which, rest[1] ?? (() => { throw new UsageError('give the new label'); })()) : catalog.setEnabled(which, sub === 'enable');
        ctx.print(m, () => `${sub === 'remove' ? 'removed' : sub === 'rename' ? 'renamed to' : sub + 'd'} "${m.label}"${sub === 'remove' ? ' (its daemon keeps running)' : ''}\n`);
        return;
      }
      case 'status': {
        const list = rest[0] ? [catalog.find(rest[0]) ?? (() => { throw new UsageError(`no saved machine "${rest[0]}"`); })()] : catalog.list().filter((m) => m.enabled);
        const rows = await Promise.all(
          list.map(async (m) => {
            const conn = new MachineConnection(m, ctx.io.connection);
            const problem = await tryConnect(conn);
            const info = problem ? null : await conn.api.health().catch(() => null);
            const boards = problem ? null : await conn.api.boards().then((b) => b.length).catch(() => null);
            conn.stop();
            return { machine: m.label, ok: !problem, state: problem ? conn.state : 'online', attention: conn.attention, error: problem, auth: info?.auth ?? null, boards };
          }),
        );
        ctx.print(rows, () => (rows.length ? table(rows.map((r) => [r.machine, r.ok ? 'online' : r.attention ? `needs attention (${r.attention})` : r.state, r.ok ? `${r.boards ?? '?'} boards, api ${r.auth}` : (r.error ?? '')]), ['MACHINE', 'STATE', 'DETAIL'], 100) : 'No saved machines.\n'));
        if (rows.some((r) => !r.ok)) process.exitCode = 1;
        return;
      }
      case 'forward': {
        const label = rest[0];
        if (!label) throw new UsageError('which machine? ih machine forward <machine> [--port N]');
        const m = catalog.find(label);
        if (!m) throw new UsageError(`no saved machine "${label}"`);
        const local = port(str(ctx.values.port), 'the port');
        if (!local) throw new UsageError('give a local port: --port 7430');
        const conn = new MachineConnection(m, { ...ctx.io.connection, freePort: async () => local });
        const problem = await tryConnect(conn);
        if (problem) {
          conn.stop();
          throw new Error(`cannot reach "${m.label}": ${problem}`);
        }
        ctx.print({ machine: m.label, url: `http://127.0.0.1:${local}` }, () => `"${m.label}" is at http://127.0.0.1:${local}  (web UI and VS Code: set the daemon URL to that; Ctrl+C closes it)\n`);
        await new Promise<void>((resolve) => {
          ctx.io.signal?.addEventListener('abort', () => resolve(), { once: true });
          if (ctx.io.signal?.aborted) resolve();
        });
        conn.stop();
        return;
      }
      default:
        throw new UsageError(`unknown machine command "${sub}"`);
    }
  },
};
