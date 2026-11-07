import { accessSync, chmodSync, constants, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { IPty } from 'node-pty';

const require = createRequire(import.meta.url);
let fixed = false;

/**
 * node-pty 1.1 ships its macOS/Linux `spawn-helper` prebuild without the execute bit (and pnpm may
 * skip the install script that fixes it), which makes every spawn fail with "posix_spawnp failed".
 */
function ensureSpawnHelper() {
  if (fixed) return;
  fixed = true;
  const root = dirname(require.resolve('node-pty/package.json'));
  for (const helper of [join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'), join(root, 'build', 'Release', 'spawn-helper')]) {
    if (!existsSync(helper)) continue;
    try {
      accessSync(helper, constants.X_OK);
    } catch {
      chmodSync(helper, 0o755);
    }
  }
}

export interface PtyOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
}

/** A pseudo-terminal running `command`, with a bounded scrollback for late-attaching viewers. */
export class Pty {
  readonly proc: IPty;
  private scrollback: string[] = [];
  private scrollbackBytes = 0;
  private listeners = new Set<(data: string) => void>();
  readonly exited: Promise<number>;
  private static MAX_SCROLLBACK = 512 * 1024;

  constructor(command: string, args: string[], opts: PtyOptions) {
    ensureSpawnHelper();
    const pty = require('node-pty') as typeof import('node-pty');
    this.proc = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 36,
      cwd: opts.cwd,
      env: opts.env as Record<string, string>,
    });
    this.proc.onData((data) => {
      this.scrollback.push(data);
      this.scrollbackBytes += data.length;
      while (this.scrollbackBytes > Pty.MAX_SCROLLBACK && this.scrollback.length > 1) this.scrollbackBytes -= this.scrollback.shift()!.length;
      for (const fn of this.listeners) fn(data);
    });
    this.exited = new Promise((resolve) => this.proc.onExit(({ exitCode }) => resolve(exitCode)));
  }

  /** Everything printed so far (bounded), for a viewer that attaches late. */
  history(): string {
    return this.scrollback.join('');
  }

  onData(fn: (data: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  write(data: string) {
    this.proc.write(data);
  }

  resize(cols: number, rows: number) {
    this.proc.resize(cols, rows);
  }

  kill() {
    try {
      this.proc.kill();
    } catch {
      // already gone
    }
  }
}
