// Worktree setup (master plan Phase 6.6, borrowed from herdr's worktree-created hook): a fresh worktree has no
// node_modules, no .env, no virtualenv, so each agent's first turn goes to installing things, or it skips the build.
// The operator's setup command (Settings → Refinery) runs once per worktree, before the agent starts; the result is
// kept in the card's log, and a failure is told to the agent and to the humans instead of stopping the card.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Board, Settings } from '@mh/core';
import { git } from './git.ts';

export interface SetupResult {
  /** False when nothing needed running (no command, or this worktree already ran it). */
  ran: boolean;
  ok: boolean;
  command: string;
  ms: number;
  /** The end of the output, for the log and the agent. */
  output: string;
  timedOut: boolean;
}

const NOTHING: SetupResult = { ran: false, ok: true, command: '', ms: 0, output: '', timedOut: false };
const hash = (command: string) => createHash('sha256').update(command).digest('hex').slice(0, 16);

/** A limit on how many installs run at once: ten cards starting together must not start ten `pnpm install`s. */
class Gate {
  private waiting: (() => void)[] = [];
  private active = 0;
  private slots: number;
  constructor(slots: number) {
    this.slots = slots;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.slots) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

export class WorktreeSetup {
  private gate: Gate;
  private env: NodeJS.ProcessEnv;
  /** Cards whose setup is in flight, so two starts of one card share one run. */
  private inflight = new Map<string, Promise<SetupResult>>();

  constructor(opts: { env: NodeJS.ProcessEnv; concurrency?: number }) {
    this.env = opts.env;
    this.gate = new Gate(opts.concurrency ?? 2);
  }

  /** Where the "this worktree ran this command" marker lives: in the worktree's own git directory, so it is never committed or listed as a change. */
  private async marker(dir: string): Promise<string> {
    return join(await git(dir, ['rev-parse', '--absolute-git-dir']), 'mh-worktree-setup');
  }

  async ensure(cardId: string, board: Board, dir: string, branch: string, settings: Pick<Settings, 'worktreeSetup' | 'worktreeSetupTimeoutSec'>): Promise<SetupResult> {
    const command = settings.worktreeSetup.trim();
    if (!command) return NOTHING;
    const running = this.inflight.get(cardId);
    if (running) return running;
    const job = this.gate
      .run(() => this.execute(board, dir, branch, command, settings.worktreeSetupTimeoutSec))
      .finally(() => this.inflight.delete(cardId));
    this.inflight.set(cardId, job);
    return job;
  }

  private async execute(board: Board, dir: string, branch: string, command: string, timeoutSec: number): Promise<SetupResult> {
    const marker = await this.marker(dir);
    const want = hash(command);
    if (existsSync(marker) && (await readFile(marker, 'utf8')).trim() === want) return NOTHING;
    const started = Date.now();
    const result = await new Promise<SetupResult>((resolve) => {
      execFile(
        'sh',
        ['-c', command],
        { cwd: dir, timeout: timeoutSec * 1000, maxBuffer: 32 * 1024 * 1024, env: { ...this.env, MH_REPO_PATH: board.repoPath, MH_WORKTREE: dir, MH_BRANCH: branch, MH_BOARD: board.id } },
        (err, stdout, stderr) => {
          const timedOut = !!err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
          resolve({ ran: true, ok: !err, command, ms: Date.now() - started, output: `${stdout}${stderr}`.slice(-4000), timedOut });
        },
      );
    });
    if (result.ok) await writeFile(marker, want + '\n');
    return result;
  }
}

/** What the agent is told when setup failed, so it does not mistake missing dependencies for a bug in its own work. */
export function setupFailureNote(r: SetupResult): string {
  const why = r.timedOut ? 'ran out of time' : 'failed';
  return `\n\nNote: this worktree's setup command (\`${r.command}\`) ${why}. Dependencies or files it should have prepared may be missing; do what the task needs to build and test anyway, and say so in your summary. The end of its output:\n\n${r.output.trim().slice(-1500)}`;
}
