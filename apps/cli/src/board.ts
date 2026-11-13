// `ih board remove`: take a board out of Infinity Harness, or also delete its folder. Both are the person's decision
// (the skill file lists them among the things an agent may never do); deleting the folder asks for the board's name.
import { connect, resolveBoard } from './context.ts';
import type { Command } from './commands.ts';
import { UsageError } from './io.ts';

export const BOARD: Command = {
  name: 'board',
  usage: 'ih board remove [--board B] [--yes | --delete-files --confirm "<board name>"]',
  summary: 'Remove a board: forget it (the folder stays), or also delete the project folder from the disk',
  options: { yes: { type: 'boolean' }, 'delete-files': { type: 'boolean' }, confirm: { type: 'string', hint: 'the board name' } },
  async run(ctx) {
    const [sub] = ctx.args;
    if (sub !== 'remove') throw new UsageError('ih board remove [--board B] [--yes | --delete-files --confirm "<board name>"]');
    const t = await connect(ctx.io, ctx.flags);
    try {
      const board = await resolveBoard(t.api, ctx.flags.board, ctx.io);
      const info = await t.api.boardRemoval(board.id);
      const del = Boolean(ctx.values['delete-files']);
      const confirm = typeof ctx.values.confirm === 'string' ? ctx.values.confirm : undefined;
      const sure = Boolean(ctx.values.yes) || (del && confirm !== undefined);
      if (!sure) {
        // Nothing is removed until the person says so: show what it would touch and how to go on.
        ctx.print({ ...info, removed: false }, () =>
          [
            `"${board.name}" (${board.repoPath}) has ${info.cards} card(s), ${info.worktrees} worktree(s)${info.dirtyWorktrees ? ` (${info.dirtyWorktrees} with unsaved changes)` : ''}${info.folder.unlandedBranches ? `, ${info.folder.unlandedBranches} branch(es) not landed` : ''}.`,
            `Remove it from Infinity Harness (the folder stays):  ih board remove --board ${board.id} --yes`,
            info.deleteBlocked ? `Deleting the folder is not allowed: ${info.deleteBlocked}` : `Also delete the folder from the disk:  ih board remove --board ${board.id} --delete-files --confirm "${board.name}"`,
            '',
          ].join('\n'),
        );
        throw new UsageError('nothing was removed: add --yes to remove the board from Infinity Harness, or --delete-files --confirm "<board name>" to delete its folder too');
      }
      if (del && info.deleteBlocked) throw new Error(info.deleteBlocked);
      const r = await t.api.removeBoard(board.id, del ? 'delete' : 'forget', confirm);
      ctx.print(r, () => (del ? `deleted "${board.name}" and its folder ${r.deletedFolder}\n` : `removed "${board.name}" from Infinity Harness; ${board.repoPath} is untouched${r.keptWorktrees.length ? `; ${r.keptWorktrees.length} worktree(s) with unsaved changes were left on disk` : ''}\n`));
    } finally {
      t.close();
    }
  },
};
