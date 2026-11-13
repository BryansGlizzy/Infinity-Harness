import { parseArgs } from 'node:util';
import { COMMANDS, type Command, type Ctx } from './commands.ts';
import { MACHINE } from './machine.ts';
import { SKILL } from './skill.ts';
import { PEER, PROJECT, REQUEST, SWARM } from './federation.ts';
import { BOARD } from './board.ts';
import { UsageError, type Io } from './io.ts';
import { HttpError } from '@ih/client';

export const ALL: Command[] = [...COMMANDS, MACHINE, BOARD, SWARM, PEER, PROJECT, REQUEST, SKILL];

const GLOBAL = {
  json: { type: 'boolean' },
  machine: { type: 'string', short: 'm' },
  board: { type: 'string', short: 'b' },
  url: { type: 'string' },
  token: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

export function helpText(): string {
  const width = Math.max(...ALL.map((c) => c.name.length));
  return `ih: drive Infinity Harness from a terminal, a script or another agent

Usage: ih [options] <command> [arguments]

Commands:
${ALL.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`).join('\n')}

Options (any command):
  -m, --machine <label>  use a saved machine instead of this one (or write machine:id)
  -b, --board <board>    board id, name or unique id prefix (default: the only board, or the one holding this folder)
      --json             machine-readable output (the default when output is not a terminal)
      --url, --token     this machine's daemon address and API token (IH_URL, IH_TOKEN)
  -h, --help             help for a command: ih <command> --help

Exit status: 0 done · 1 the daemon or a machine refused or was unreachable · 2 wrong usage.
Errors go to stderr as {"error": "..."} when the output is JSON.
`;
}

function commandHelp(c: Command): string {
  const opts = Object.entries(c.options ?? {}).map(([k, o]) => `  --${k}${o.hint ? ` <${o.hint}>` : o.type === 'string' ? ' <value>' : ''}`);
  return `${c.usage}\n\n${c.summary}\n${opts.length ? `\nOptions:\n${opts.join('\n')}\n` : ''}`;
}

/** Runs one `ih` invocation; returns the exit status. */
export async function run(argv: string[], io: Io): Promise<number> {
  let json = !io.tty;
  const fail = (code: number, err: unknown) => {
    const message = err instanceof HttpError ? `${err.message} (${err.status})` : (err as Error).message;
    io.err(json ? JSON.stringify({ error: message }) + '\n' : `ih: ${message}\n`);
    return code;
  };
  try {
    const first = argv.find((a) => !a.startsWith('-') && !/^-/.test(a));
    const command = ALL.find((c) => c.name === first);
    if (!first || first === 'help' || (!command && argv.every((a) => a === '--help' || a === '-h'))) {
      io.out(helpText());
      return 0;
    }
    if (!command) throw new UsageError(`unknown command "${first}". \`ih help\` lists them.`);
    const { values, positionals } = parseArgs({ args: argv, options: { ...GLOBAL, ...(command.options ?? {}) }, allowPositionals: true, strict: true });
    if (values.help) {
      io.out(commandHelp(command));
      return 0;
    }
    json = Boolean(values.json) || !io.tty;
    const ctx: Ctx = {
      io,
      args: positionals.slice(1),
      values,
      flags: { machine: values.machine as string | undefined, url: values.url as string | undefined, token: values.token as string | undefined, board: values.board as string | undefined },
      json,
      print: (data, human) => io.out(json ? JSON.stringify(data, null, 2) + '\n' : human()),
    };
    await command.run(ctx);
    return 0;
  } catch (err) {
    const code = err instanceof UsageError || (err as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || (err as { code?: string }).code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' ? 2 : 1;
    return fail(code, err);
  }
}
