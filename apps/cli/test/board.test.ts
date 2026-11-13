// `ih board remove`: nothing goes without the person's flags; deleting the folder needs the board's name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, tempRepo } from '../../daemon/test/harness.ts';
import { run } from '../src/cli.ts';
import type { Io } from '../src/io.ts';

test('board remove: shows what it would do until told; forget keeps the folder; delete needs the exact name', async () => {
  const t = await setup();
  const config = mkdtempSync(join(tmpdir(), 'ih-ih-'));
  const ih = async (args: string[]) => {
    let out = '';
    let err = '';
    const io: Io = { out: (s) => (out += s), err: (s) => (err += s), env: { IH_URL: `http://127.0.0.1:${t.cfg.port}`, XDG_CONFIG_HOME: config }, cwd: '/nowhere', tty: false };
    const code = await run(args, io);
    return { code, out, err, json: () => JSON.parse(out) as any };
  };
  try {
    const second = t.store.createBoard({ name: 'Second', repoPath: await tempRepo(), defaultBranch: 'main' });

    // Without a flag nothing is removed (exit 2), and the answer says how to go on.
    const dry = await ih(['board', 'remove', '--board', second.id]);
    assert.equal(dry.code, 2);
    assert.equal(JSON.parse(dry.out).removed, false);
    assert.equal(JSON.parse(dry.out).deleteBlocked, null);
    assert.ok(t.store.getBoard(second.id));
    assert.equal((await ih(['board'])).code, 2, 'a sub-command is needed');

    // Delete without the name is refused by the daemon; the folder stays.
    const noName = await ih(['board', 'remove', '--board', second.id, '--yes', '--delete-files']);
    assert.equal(noName.code, 1);
    assert.match(noName.err, /type the board's name exactly: Second/);
    const wrong = await ih(['board', 'remove', '--board', second.id, '--delete-files', '--confirm', 'second']);
    assert.equal(wrong.code, 1);
    assert.ok(existsSync(second.repoPath));

    // Forget: the board goes, the folder stays.
    const forget = await ih(['board', 'remove', '--board', second.id, '--yes']);
    assert.equal(forget.code, 0, forget.err);
    assert.equal(forget.json().mode, 'forget');
    assert.equal(t.store.getBoard(second.id), undefined);
    assert.ok(existsSync(second.repoPath));

    // Delete with the exact name: gone from the disk too.
    const third = t.store.createBoard({ name: 'Third', repoPath: await tempRepo(), defaultBranch: 'main' });
    const gone = await ih(['board', 'remove', '--board', third.id, '--delete-files', '--confirm', 'Third']);
    assert.equal(gone.code, 0, gone.err);
    assert.equal(gone.json().mode, 'delete');
    assert.ok(!existsSync(third.repoPath));
    assert.equal(t.store.getBoard(third.id), undefined);
    assert.ok(existsSync(t.repo), 'the other board is untouched');
  } finally {
    await t.close();
  }
});
