import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from './commands.ts';
import { UsageError } from './io.ts';

/** The skill file shipped in this checkout (`skills/infinity-harness/SKILL.md`). */
export const BUNDLED = fileURLToPath(new URL('../../../skills/infinity-harness/SKILL.md', import.meta.url));
export const SKILL_NAME = 'infinity-harness';

/** Where each tool looks for skills. `--dir` names any other parent folder. */
export function targetDir(target: string, env: NodeJS.ProcessEnv, dir?: string): string {
  if (dir) return join(dir, SKILL_NAME);
  const home = env.HOME || homedir();
  switch (target) {
    case 'claude':
      return join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'skills', SKILL_NAME);
    case 'agents':
      return join(home, '.agents', 'skills', SKILL_NAME);
    default:
      throw new UsageError('the target is claude or agents (or give a parent folder with --dir)');
  }
}

const str = (v: string | boolean | undefined) => (typeof v === 'string' ? v : undefined);

export const SKILL: Command = {
  name: 'skill',
  usage: 'ih skill show | path | status | install [--target claude|agents] [--dir PARENT] [--force]',
  summary: 'The skill file that teaches an agent outside the board how to use ih',
  options: { target: { type: 'string', hint: 'claude|agents' }, dir: { type: 'string', hint: 'parent folder' }, force: { type: 'boolean' } },
  async run(ctx) {
    const [sub = 'show'] = ctx.args;
    if (!existsSync(BUNDLED)) throw new Error(`the skill file is missing from this install (${BUNDLED})`);
    const dest = join(targetDir(str(ctx.values.target) ?? 'claude', ctx.io.env, str(ctx.values.dir)), 'SKILL.md');
    const bundled = readFileSync(BUNDLED, 'utf8');
    switch (sub) {
      case 'show':
        ctx.io.out(bundled);
        return;
      case 'path':
        ctx.print({ path: BUNDLED }, () => `${BUNDLED}\n`);
        return;
      case 'status': {
        const installed = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
        const state = installed === null ? 'not installed' : installed === bundled ? 'up to date' : 'differs from this checkout';
        ctx.print({ path: dest, state }, () => `${dest}: ${state}\n`);
        return;
      }
      case 'install': {
        const exists = existsSync(dest);
        if (exists && readFileSync(dest, 'utf8') !== bundled && !ctx.values.force) throw new UsageError(`${dest} already exists and differs. Use --force to replace it.`);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(BUNDLED, dest);
        ctx.print({ path: dest, replaced: exists }, () => `installed ${dest}\nStart a new session of that tool for it to be picked up.\n`);
        return;
      }
      default:
        throw new UsageError(`unknown skill command "${sub}"`);
    }
  },
};
