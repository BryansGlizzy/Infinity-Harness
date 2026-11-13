import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { DaemonEvent } from '@ih/core';
import { Store } from '@ih/db';
import { AcpAgent } from '@ih/adapters';
import { RateLimiter } from '@ih/gateway';
import type { DaemonConfig } from '../src/config.ts';
import { commitAll, commitsAhead, ensureWorktree, git, inspectRepo, removeUntracked } from '../src/git.ts';
import { reservePaths } from '../src/leases.ts';
import { Live } from '../src/live.ts';
import { Runner } from '../src/runner.ts';
import { buildServer } from '../src/server.ts';

const fakeAgent = fileURLToPath(new URL('../../../packages/adapters/test/fake-agent.mjs', import.meta.url));

async function tempRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), 'ih-repo-'));
  await git(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  await commitAll(repo, 'init');
  return repo;
}

function config(dataDir: string): DaemonConfig {
  return {
    root: dataDir,
    dataDir,
    dbFile: ':memory:',
    worktreesDir: join(dataDir, 'worktrees'),
    opencodeConfigPath: join(dataDir, 'opencode.json'),
    binaries: { claude: null, kimi: null, agyAcp: null },
    webDist: join(dataDir, 'web'),
    host: '127.0.0.1',
    port: 0,
    pools: [{ id: 'fake', label: 'Fake', harness: 'opencode', model: 'fake/two', kind: 'local' }],
    agentEnv: process.env,
    gateway: { host: '127.0.0.1', port: 0, url: 'http://127.0.0.1:0', token: 't', pools: [] },
    kev: null,
    fastLane: [],
  };
}

/** A runner on a temp repo with the scripted fake agent; `listen` also serves the board MCP endpoint. */
async function setup(opts: { listen?: boolean } = {}) {
  const repo = await tempRepo();
  const dataDir = mkdtempSync(join(tmpdir(), 'ih-data-'));
  const cfg = config(dataDir);
  const store = new Store(':memory:');
  const runner = new Runner(store, cfg, {
    makeAdapter: () => new AcpAgent({ id: 'fake', command: process.execPath, args: [fakeAgent], cwd: dataDir, env: process.env }),
  });
  const board = store.createBoard({ name: 'Demo', repoPath: repo, defaultBranch: 'main' });
  let close = async () => runner.shutdown();
  if (opts.listen) {
    const app = await buildServer({ store, runner, config: cfg, live: new Live(), limiter: new RateLimiter() });
    await app.listen({ host: '127.0.0.1', port: 0 });
    cfg.port = (app.server.address() as AddressInfo).port;
    close = async () => {
      runner.shutdown();
      await app.close();
    };
  }
  return { repo, store, runner, board, cfg, close };
}

function waitFor(store: Store, predicate: (e: DaemonEvent) => boolean, ms = 10_000): Promise<DaemonEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for event')), ms);
    const off = store.onEvent((e) => {
      if (!predicate(e)) return;
      clearTimeout(timer);
      off();
      resolve(e);
    });
  });
}

/** Resolves when the card leaves In progress. */
const settled = (store: Store, cardId: string) =>
  waitFor(store, (e) => e.type === 'card.updated' && e.subject === cardId && (e.payload as any).card.status !== 'in_progress');

/** Everything the agent said (including the fake agent's `prompt:` echoes and tool results). */
function agentText(store: Store, cardId: string): string {
  return store
    .eventsFor(cardId)
    .filter((e) => e.type === 'session.event' && (e.payload as any).event.type === 'message' && e.actor !== 'daemon')
    .map((e) => (e.payload as any).event.text)
    .join('');
}

/** The full prompts the daemon sent to the card's agent. */
function prompts(store: Store, cardId: string): string {
  return store
    .eventsFor(cardId)
    .filter((e) => e.type === 'session.event' && (e.payload as any).event.type === 'message' && (e.payload as any).event.role === 'user')
    .map((e) => (e.payload as any).event.text)
    .join('\n---\n');
}

test('git helpers: inspect, worktree, commit, ahead count', async () => {
  const repo = await tempRepo();
  assert.deepEqual(await inspectRepo(repo), { defaultBranch: 'main' });
  await assert.rejects(inspectRepo(mkdtempSync(join(tmpdir(), 'ih-empty-'))), /not a git repository/);

  const dir = join(mkdtempSync(join(tmpdir(), 'ih-wt-')), 'card');
  await ensureWorktree(repo, dir, 'ih/test', 'main');
  await ensureWorktree(repo, dir, 'ih/test', 'main'); // idempotent
  assert.equal(await commitAll(dir, 'nothing'), null);
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  assert.match((await commitAll(dir, 'add a')) ?? '', /^[0-9a-f]{40}$/);
  assert.equal(await commitsAhead(repo, 'main', 'ih/test'), 1);

  // Harness-written stray files are removed while untracked; tracked files under the same path stay.
  mkdirSync(join(dir, 'skills', 'system', 'x'), { recursive: true });
  writeFileSync(join(dir, 'skills', 'system', 'kept.md'), 'tracked\n');
  await commitAll(dir, 'tracked skill');
  writeFileSync(join(dir, 'skills', 'system', 'x', 'SKILL.md'), 'stray\n');
  assert.deepEqual(await removeUntracked(dir, ['skills/system']), ['skills/system/x/SKILL.md']);
  assert.equal(existsSync(join(dir, 'skills', 'system', 'x', 'SKILL.md')), false);
  assert.ok(existsSync(join(dir, 'skills', 'system', 'kept.md')));
});

test('running a card: worktree, agent session, events, commit, review, idle session', async () => {
  const { repo, store, runner, board, close } = await setup();
  try {
    const card = store.createCard({ boardId: board.id, title: 'Write the notes file' });
    const done = settled(store, card.id);
    const session = await runner.run(card.id, 'fake');
    assert.equal(session.model, 'fake/two');
    await assert.rejects(runner.run(card.id, 'fake'), /already has a running session/);
    await done;

    const after = store.getCard(card.id)!;
    assert.equal(after.status, 'review');
    assert.ok(after.branch?.startsWith('ih/write-the-notes-file-'));
    assert.ok(existsSync(join(after.worktree!, 'notes.md')));
    assert.equal(await commitsAhead(repo, 'main', after.branch!), 1);
    assert.equal(store.listSessions(card.id)[0]?.state, 'idle');
    assert.equal(runner.sessionState(card.id), 'idle');
    assert.equal(runner.isActive(card.id), false);
    // The pools view lists the open (idle) session with its board and exact model.
    assert.deepEqual(
      runner.activeSessions().map((s) => ({ cardId: s.cardId, boardName: s.boardName, poolId: s.poolId, model: s.model, state: s.state, kind: s.kind })),
      [{ cardId: card.id, boardName: board.name, poolId: 'fake', model: 'fake/two', state: 'idle', kind: 'card' }],
    );

    const kinds = store
      .eventsFor(card.id)
      .filter((e) => e.type === 'session.event')
      .map((e) => (e.payload as any).event.type);
    assert.deepEqual(kinds, ['message', 'message', 'thought', 'tool_call', 'permission', 'permission', 'tool_update', 'message', 'turn_end', 'message']);
  } finally {
    await close();
  }
});

test('a turn cancelled by a policy rejection is resumed with a follow-up prompt', async () => {
  const { store, runner, board, close } = await setup();
  try {
    const card = store.createCard({ boardId: board.id, title: 'STRICT task' });
    const done = settled(store, card.id);
    await runner.run(card.id, 'fake');
    await done;

    assert.equal(store.getCard(card.id)!.status, 'review');
    const events = store.eventsFor(card.id).filter((e) => e.type === 'session.event').map((e) => (e.payload as any).event);
    const prompts = events.filter((e) => e.type === 'message' && e.role === 'user').map((e) => e.text as string);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1]!, /refused by the board's path policy \(automatic, not a human decision\)[\s\S]*Write \/etc\/hosts/);
    assert.deepEqual(events.filter((e) => e.type === 'turn_end').map((e) => e.stopReason), ['cancelled', 'end_turn']);
    // The humans hear about it once per work cycle (both turns were refused the same path), with where to allow it.
    const notices = store.boardMessages(board.id).filter((m) => m.fromActor === 'daemon:policy');
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.toCard, null);
    assert.match(notices[0]!.body, /"STRICT task" \(c_\w+, Fake\) was refused a tool call outside its worktree:\n- Write \/etc\/hosts[\s\S]*Settings → Guardrails → Tool paths/);
  } finally {
    await close();
  }
});

test('workers are told their test command and may use scratch space and the git dir; toolchain sharing can be turned off', async () => {
  const { repo, store, runner, board, close } = await setup();
  try {
    store.updateSettings(board.id, { testCommand: 'pnpm test' });
    const description = ['SHELL ls /tmp/ih-scratch-elsewhere', `SHELL cat ${repo}/.git/HEAD`, `SHELL cat ${repo}/README.md`].join('\n');
    const shared = store.createCard({ boardId: board.id, title: 'Shared tools', description });
    let done = settled(store, shared.id);
    await runner.run(shared.id, 'fake');
    await done;
    assert.match(prompts(store, shared.id), /You have a shell in your worktree[\s\S]*the board's test command is `pnpm test`[\s\S]*not a human saying no/);
    // Scratch space and the repo's git dir are allowed. (The temp repo itself is under /tmp here, so it is too.)
    assert.match(agentText(store, shared.id), /shell=yes\nshell=yes\nshell=yes/);

    store.updateSettings(board.id, { shareToolchains: false });
    const strict = store.createCard({ boardId: board.id, title: 'Worktree only', description });
    done = settled(store, strict.id);
    await runner.run(strict.id, 'fake');
    await done;
    assert.match(prompts(store, strict.id), /may only touch your worktree/);
    assert.match(agentText(store, strict.id), /shell=no\nshell=yes\nshell=no/, 'only the git dir is left');
  } finally {
    await close();
  }
});

test('a failing agent leaves the card blocked; unknown pools are refused', async () => {
  const { store, runner, board, close } = await setup();
  try {
    const card = store.createCard({ boardId: board.id, title: 'FAIL on purpose' });
    await assert.rejects(runner.run(card.id, 'nope'), /unknown pool/);
    const done = settled(store, card.id);
    await runner.run(card.id, 'fake');
    await done;
    assert.equal(store.getCard(card.id)!.status, 'blocked');
    assert.equal(store.listSessions(card.id)[0]?.state, 'failed');
  } finally {
    await close();
  }
});

test('a message wakes an idle session and is delivered as the next prompt', async () => {
  const { store, runner, board, close } = await setup();
  try {
    const card = store.createCard({ boardId: board.id, title: 'Idle then woken' });
    let done = settled(store, card.id);
    await runner.run(card.id, 'fake');
    await done;

    done = waitFor(store, (e) => e.type === 'card.updated' && e.subject === card.id && (e.payload as any).card.status === 'review');
    store.postMessage({ boardId: board.id, fromActor: 'user:local', toCard: card.id, body: 'please also check docs', urgent: false });
    runner.deliver(card.id);
    await done;

    assert.match(agentText(store, card.id), /prompt:You have a new message:\n- from the human operator \(local\): please also check docs/);
    assert.equal(store.pendingMessages(card.id).length, 0);
    assert.equal(runner.sessionState(card.id), 'idle');
  } finally {
    await close();
  }
});

test('an urgent message interrupts a busy turn; a normal one waits for the turn boundary', async () => {
  const { store, runner, board, close } = await setup();
  try {
    const card = store.createCard({ boardId: board.id, title: 'SLOW worker' });
    const done = settled(store, card.id);
    const started = waitFor(store, (e) => e.subject === card.id && e.type === 'session.event' && /prompt:/.test((e.payload as any).event.text ?? ''));
    await runner.run(card.id, 'fake');
    await started;

    store.postMessage({ boardId: board.id, fromActor: 'user:local', toCard: card.id, body: 'normal note', urgent: false });
    runner.deliver(card.id);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(store.pendingMessages(card.id).length, 1); // still queued: normal messages don't interrupt

    const t0 = Date.now();
    store.postMessage({ boardId: board.id, fromActor: 'user:local', toCard: card.id, body: 'stop and read this', urgent: true });
    runner.deliver(card.id);
    await done;
    assert.ok(Date.now() - t0 < 3000, 'urgent message should cut the 5 s turn short');

    const sent = prompts(store, card.id);
    assert.match(sent, /\[URGENT\] from the human operator \(local\): stop and read this/);
    assert.match(sent, /normal note/);
    assert.match(sent, /interrupted to deliver this/);
    assert.equal(store.getCard(card.id)!.status, 'review');
  } finally {
    await close();
  }
});

test('edits to files leased by another card are refused', async () => {
  const { store, runner, board, close } = await setup();
  try {
    const holder = store.createCard({ boardId: board.id, title: 'Holder' });
    reservePaths(store, board.id, holder.id, ['notes.md']);
    const card = store.createCard({ boardId: board.id, title: 'Wants notes' });
    const done = settled(store, card.id);
    await runner.run(card.id, 'fake');
    await done;

    const perms = store
      .eventsFor(card.id)
      .filter((e) => e.type === 'session.event' && (e.payload as any).event.type === 'permission')
      .map((e) => (e.payload as any).event);
    assert.equal(perms[0].decision, 'rejected');
    assert.match(perms[0].reason, new RegExp(`notes\\.md is leased by card ${holder.id}`));
    assert.equal(existsSync(join(store.getCard(card.id)!.worktree!, 'notes.md')), false);
  } finally {
    await close();
  }
});

test('board MCP: agents reserve paths, see conflicts, message each other and report blocked', async () => {
  const { store, runner, board, cfg, close } = await setup({ listen: true });
  try {
    const a = store.createCard({ boardId: board.id, title: 'Agent A' });
    const b = store.createCard({ boardId: board.id, title: 'Agent B' });
    const c = store.createCard({ boardId: board.id, title: 'Agent C' });

    // A reserves src/**, messages B, and asks who it is.
    store.updateCard(a.id, {
      description: `CALL reserve_paths {"paths":["src/**"]}\nCALL post_message {"to":"${b.id}","body":"I own src/ for now"}\nCALL whoami {}`,
    });
    let done = settled(store, a.id);
    await runner.run(a.id, 'fake');
    await done;
    const aText = agentText(store, a.id);
    assert.match(aText, /reserve_paths -> \{ "reserved": \[ "src\/\*\*" \]/);
    assert.match(aText, /post_message -> Sent/);
    assert.match(aText, new RegExp(`whoami -> \\{ "card": \\{ "id": "${a.id}"`));
    assert.equal(store.activeLeases(board.id).length, 0); // released when A's work was committed

    // B starts later: A's queued message is in its first prompt; C holds src/api/**.
    reservePaths(store, board.id, c.id, ['src/api/**']);
    store.updateCard(b.id, {
      description: 'CALL reserve_paths {"paths":["src/api/routes.ts","docs/x.md"]}\nCALL report_blocked {"reason":"needs src/api"}',
    });
    done = settled(store, b.id);
    await runner.run(b.id, 'fake');
    await done;
    const bText = agentText(store, b.id);
    assert.match(prompts(store, b.id), new RegExp(`from card ${a.id} "Agent A" \\(fake\\): I own src/ for now`));
    assert.match(bText, new RegExp(`reserve_paths -> ERROR Not reserved\\. src/api/routes\\.ts is leased by card ${c.id}`));
    assert.equal(store.getCard(b.id)!.status, 'blocked');
    assert.ok(store.boardMessages(board.id).some((m) => m.toCard === null && m.body === 'Blocked: needs src/api'));

    const res = await fetch(`http://127.0.0.1:${cfg.port}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer nope', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test('a queued message for a card without a session is included in its first prompt', async () => {
  const { store, runner, board, close } = await setup();
  try {
    const card = store.createCard({ boardId: board.id, title: 'Later' });
    store.postMessage({ boardId: board.id, fromActor: 'user:local', toCard: card.id, body: 'context for you', urgent: false });
    const done = settled(store, card.id);
    await runner.run(card.id, 'fake');
    await done;
    assert.equal(store.pendingMessages(card.id).length, 0);
    const prompt = store.eventsFor(card.id).find((e) => e.type === 'session.event' && (e.payload as any).event.role === 'user');
    assert.match((prompt!.payload as any).event.text, /context for you/);
    assert.ok(readFileSync(join(store.getCard(card.id)!.worktree!, 'notes.md'), 'utf8'));
  } finally {
    await close();
  }
});
