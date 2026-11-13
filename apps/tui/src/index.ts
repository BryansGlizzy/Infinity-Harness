import { join } from 'node:path';
import { homedir } from 'node:os';
import { MachineCatalog, Fleet, defaultCatalogFile, localEndpointFromEnv, type ConnectionOptions } from '@ih/client/node';
import { App } from './app.ts';
import { SeenStore } from './seen.ts';
import { RealTerminal } from './term.ts';

export { App } from './app.ts';
export { Canvas } from './canvas.ts';
export { InputParser, type InputEvent } from './input.ts';
export { SeenStore } from './seen.ts';

export interface TuiOptions {
  env?: NodeJS.ProcessEnv;
  /** Capture the mouse (default). Off leaves the terminal's own text selection alone. */
  mouse?: boolean;
  machine?: string;
  board?: string;
  connection?: ConnectionOptions;
}

/** Runs the TUI on this terminal until the person quits. */
export async function runTui(opts: TuiOptions = {}): Promise<void> {
  const env = opts.env ?? process.env;
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('the TUI needs a terminal; use `ih` commands in scripts');
  const mouse = opts.mouse ?? env.IH_TUI_MOUSE !== '0';
  const local = localEndpointFromEnv(env);
  const fleet = new Fleet({ catalog: new MachineCatalog(defaultCatalogFile(env)), localUrl: local.url, localToken: local.token, connection: opts.connection });
  const seenFile = join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'infinity-harness', 'tui-seen.json');
  const app = new App({ fleet, term: new RealTerminal({ mouse, env }), seen: new SeenStore(seenFile), mouse, bell: env.IH_TUI_BELL !== '0', machine: opts.machine, board: opts.board });
  await app.start();
  await app.finished;
}
