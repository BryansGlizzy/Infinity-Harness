import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { ARTIFACT_KINDS, CARD_STATUSES, effectiveAgents, validateAgents, type ArtifactKind, type CardStatus, type ModelOption, type ReasoningOptions, type BoardMode, type RoutingRules, type Settings } from '@mh/core';
import type { ContextService, SearchScope } from '@mh/context';
import type { FastLane } from '@mh/fast-lane';
import { priorFor } from '@mh/router';
import { mergeSettings, type CardPatch, type Store } from '@mh/db';
import type { RateLimiter } from '@mh/gateway';
import { checkRequest, type AuthOptions } from './auth.ts';
import type { DaemonConfig } from './config.ts';
import type { Live } from './live.ts';
import { registerBoardMcp } from './board-mcp.ts';
import { changesBetween, commitsBetween, diffBetween, fileAt, git, inspectRepo, removeWorktreeSafely, revParse, tryLocally } from './git.ts';
import type { Runner } from './runner.ts';
import type { CouncilRunner } from './council.ts';
import { expandPath, inspectFolder, prepareRepo, samePath, type RepoSetup } from './projects.ts';
import type { Scheduler } from './scheduler.ts';
import type { Approvals } from './approvals.ts';
import type { Budgets } from './budgets.ts';
import { buildChat } from './chat.ts';
import { outages } from './history.ts';
import type { IdeBridge } from './ide.ts';
import { buildMetrics } from './metrics.ts';
import type { Refinery } from './refinery.ts';
import { registerTelemetry } from './telemetry.ts';

/** The most events a reconnecting client is caught up with; a longer gap tells it to reload instead. */
export const REPLAY_LIMIT = 5000;

class HttpError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** True when `path` is the top folder of a git repository (with or without commits). */
async function isRepoRoot(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  try {
    return samePath(await git(path, ['rev-parse', '--show-toplevel']), path);
  } catch {
    return false;
  }
}

/** True when `path` is inside a git repository at all (its top folder or a subfolder). */
async function inGitRepo(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  return git(path, ['rev-parse', '--show-toplevel']).then(() => true, () => false);
}

function required(body: unknown, key: string): string {
  const value = (body as Record<string, unknown> | undefined)?.[key];
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${key} is required`);
  return value.trim();
}

export interface ServerDeps {
  store: Store;
  runner: Runner;
  config: DaemonConfig;
  live: Live;
  limiter: RateLimiter;
  scheduler?: Scheduler;
  context?: ContextService | null;
  fastLane?: FastLane | null;
  council?: CouncilRunner | null;
  refinery?: Refinery | null;
  budgets?: Budgets | null;
  approvals?: Approvals | null;
  bridge?: IdeBridge | null;
  /** Who may call the API. Absent: no checks (tests that are not about access). */
  auth?: AuthOptions | null;
}

export async function buildServer({ store, runner, config, live, limiter, scheduler, context, fastLane, council, refinery, budgets, approvals, bridge, auth }: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.MH_LOG_LEVEL ?? 'warn' } });
  await app.register(websocket);

  if (auth) {
    app.addHook('onRequest', async (req, reply) => {
      const path = req.url.split('?')[0]!;
      const refusal = checkRequest(auth, {
        path,
        remote: req.socket.remoteAddress ?? '',
        host: req.headers.host,
        origin: req.headers.origin,
        authorization: req.headers.authorization,
        queryToken: new URL(req.url, 'http://x').searchParams.get('token') ?? undefined,
      });
      if (refusal) return reply.status(refusal.status).send({ error: refusal.error });
    });
  }

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    reply.status(err.statusCode ?? 500).send({ error: err.message });
  });

  // --- live event stream: every appended event is pushed to every client
  // A client that passes ?since=<seq> (or since=now) is caught up from the events log first, with no gap and no
  // duplicate: replay and subscription happen in one synchronous step, and appends are synchronous too. The
  // `stream.status` message that follows says how it went; `lost` means the client must reload everything.
  app.get<{ Querystring: { since?: string } }>('/ws', { websocket: true }, (socket, req) => {
    const wanted = req.query.since;
    if (wanted !== undefined) {
      const latest = store.lastEventSeq();
      const from = wanted === 'now' ? latest : Number(wanted);
      let lost: 'ahead' | 'too_many' | 'invalid' | null = null;
      let replayed = 0;
      if (!Number.isInteger(from) || from < 0) lost = 'invalid';
      else if (from > latest) lost = 'ahead';
      else if (latest - from > REPLAY_LIMIT) lost = 'too_many';
      else {
        for (const e of store.eventsAfter(from, REPLAY_LIMIT)) {
          socket.send(JSON.stringify(e));
          replayed++;
        }
      }
      socket.send(JSON.stringify({ live: true, type: 'stream.status', subject: 'events', payload: { latest, replayed, lost }, ts: new Date().toISOString() }));
    }
    const offEvents = store.onEvent((event) => socket.send(JSON.stringify(event)));
    const offLive = live.subscribe((message) => socket.send(JSON.stringify(message)));
    socket.on('close', () => {
      offEvents();
      offLive();
    });
  });

  registerBoardMcp(app, store, runner, { context, fastLane, approvals, bridge, docsDir: join(config.root, 'docs', 'agents') });
  // OTLP/HTTP receiver for Claude Code's token and cost metrics (Phase 6.3).
  registerTelemetry(app, store);

  // A VS Code window bound to a board answers the agents' ide_* requests (Phase 6.1).
  app.get<{ Querystring: { board?: string; name?: string } }>('/ws/ide', { websocket: true }, (socket, req) => {
    const board = req.query.board ?? '';
    if (!bridge || !store.getBoard(board)) {
      socket.close();
      return;
    }
    bridge.attach(board, { send: (d) => socket.send(d), on: (ev, fn) => socket.on(ev, fn as never) }, req.query.name || 'VS Code');
  });

  // Claude Code hooks and status line (packages/adapters/src/claude-hook.mjs posts here).
  app.post<{ Querystring: { mode?: string } }>('/hooks/claude', async (req, reply) => {
    const token = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
    const out = runner.claudeHook(token, req.query.mode ?? 'hook', req.body);
    if (out === null) return reply.status(401).send('unknown session');
    return reply.type('text/plain').send(out);
  });

  // Attach to a card's live terminal (Claude sessions): replays scrollback, then streams; input and resize go back.
  app.get<{ Params: { id: string } }>('/ws/terminal/:id', { websocket: true }, (socket, req) => {
    const pty = runner.terminal(req.params.id);
    if (!pty) {
      socket.send('\r\n[no live terminal for this card]\r\n');
      socket.close();
      return;
    }
    socket.send(pty.history());
    const off = pty.onData((data) => socket.send(data));
    socket.on('message', (raw: Buffer) => {
      const text = raw.toString();
      if (text.startsWith('\x00resize:')) {
        const [cols, rows] = text.slice(8).split('x').map(Number);
        if (cols && rows) pty.resize(cols, rows);
      } else pty.write(text);
    });
    socket.on('close', off);
  });

  app.get('/api/health', async () => ({ ok: true, auth: auth?.requireToken ? 'token' : 'local' }));
  // Pools with live limiter state (API windows, Claude 5h/7d, observed lockouts, forced usage) and session counts.
  app.get('/api/pools', async () =>
    runner.pools().map((pool) => ({ ...pool, status: limiter.status(pool.id), running: runner.runningOn(pool.id) })),
  );
  // Open sessions on every pool and board (the pools view).
  app.get('/api/sessions/active', async () => runner.activeSessions());
  // Operator override: force a pool's usage (e.g. 95 to halt it) to watch work flow elsewhere; pct null clears it.
  app.post<{ Params: { id: string }; Body: { pct?: number | null } }>('/api/pools/:id/force', async (req) => {
    if (!runner.pools().some((p) => p.id === req.params.id)) throw new HttpError(404, 'unknown pool');
    const pct = req.body?.pct;
    if (pct !== null && pct !== undefined && (typeof pct !== 'number' || pct < 0 || pct > 100)) throw new HttpError(400, 'pct must be 0–100 or null');
    limiter.force(req.params.id, pct ?? null);
    return limiter.status(req.params.id);
  });
  // Models each pool's harness offers (probed once per harness; refresh=1 probes again). A failed probe is reported per pool.
  app.get<{ Querystring: { refresh?: string } }>('/api/models', async (req) => {
    const refresh = req.query.refresh === '1';
    const out: Record<string, { models: ModelOption[]; reasoning?: ReasoningOptions | null; error?: string }> = {};
    await Promise.all(
      runner.pools().map(async (pool) => {
        try {
          out[pool.id] = { models: await runner.models(pool.id, refresh), reasoning: await runner.reasoning(pool.id) };
        } catch (err) {
          out[pool.id] = { models: [{ id: pool.model, name: `${pool.model} (default)` }], error: (err as Error).message };
        }
      }),
    );
    return out;
  });
  app.get<{ Params: { id: string } }>('/api/cards/:id/terminal', async (req) => ({ available: runner.terminal(req.params.id) !== null }));
  app.get('/api/usage', async () => store.usageSince(new Date(Date.now() - 86_400_000).toISOString()));

  // --- boards
  app.get('/api/boards', async () => store.listBoards());
  app.post<{ Body: { name?: string; repoPath?: string; setup?: RepoSetup; mode?: BoardMode } }>('/api/boards', async (req) => {
    const name = required(req.body, 'name');
    let repoPath = expandPath(required(req.body, 'repoPath'));
    let did: string[] = [];
    try {
      // A git repository defaults to worktree mode; a folder that isn't one (and isn't being set up) to direct mode.
      const mode: BoardMode = req.body?.mode ?? (req.body?.setup || (await inGitRepo(repoPath)) ? 'worktree' : 'direct');
      if (mode === 'direct') {
        if (!existsSync(repoPath)) {
          if (!req.body?.setup?.create) throw new Error(`path does not exist: ${repoPath}`);
          await mkdir(repoPath, { recursive: true });
          did.push('created the folder');
        } else if (!statSync(repoPath).isDirectory()) throw new Error(`not a folder: ${repoPath}`);
        const branch = (await isRepoRoot(repoPath)) ? await inspectRepo(repoPath).then((r) => r.defaultBranch, () => '') : '';
        return { ...store.createBoard({ name, repoPath, defaultBranch: branch, mode }), setup: did };
      }
      // Optional setup: create the folder, git init, first commit, GitHub repo (see projects.ts).
      if (req.body?.setup) ({ path: repoPath, did } = await prepareRepo(repoPath, name, req.body.setup, config.binaries.gh ?? null));
      const { defaultBranch } = await inspectRepo(repoPath);
      const root = await git(repoPath, ['rev-parse', '--show-toplevel']);
      if (!samePath(root, repoPath)) throw new Error(`this folder is inside the repository at ${root}; choose that folder instead`);
      return { ...store.createBoard({ name, repoPath, defaultBranch }), setup: did };
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });
  // Folder browser for the New board form: subfolders and what the folder is (git repo, files, empty, missing).
  app.get<{ Querystring: { path?: string; hidden?: string } }>('/api/fs', async (req) => ({
    ...(await inspectFolder(req.query.path ?? '~', { hidden: req.query.hidden === '1' })),
    home: homedir(),
    gh: !!config.binaries.gh,
  }));

  // --- cards
  app.get<{ Params: { id: string } }>('/api/boards/:id/cards', async (req) => {
    if (!store.getBoard(req.params.id)) throw new HttpError(404, 'board not found');
    return store.listCards(req.params.id);
  });
  app.post<{ Params: { id: string }; Body: { title?: string; description?: string; parentId?: string; status?: CardStatus; routing?: RoutingRules } }>(
    '/api/boards/:id/cards',
    async (req) => {
      if (!store.getBoard(req.params.id)) throw new HttpError(404, 'board not found');
      const status = req.body?.status;
      if (status && !CARD_STATUSES.includes(status)) throw new HttpError(400, `invalid status ${status}`);
      try {
        return store.createCard({
          boardId: req.params.id,
          title: required(req.body, 'title'),
          description: req.body?.description?.trim() ?? '',
          parentId: req.body?.parentId ?? null,
          status,
          routing: req.body?.routing ?? null,
        });
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
    },
  );
  app.patch<{ Params: { id: string }; Body: CardPatch }>('/api/cards/:id', async (req) => {
    const card = store.getCard(req.params.id);
    if (!card) throw new HttpError(404, 'card not found');
    const { title, description, status, routing, grants } = req.body ?? {};
    if (grants) {
      const known = store.getSettings(card.boardId).grants;
      const bad = grants.filter((g) => !known[g]);
      if (bad.length) throw new HttpError(400, `unknown tool grant(s): ${bad.join(', ')}`);
    }
    if (status && !CARD_STATUSES.includes(status as CardStatus)) throw new HttpError(400, `invalid status ${status}`);
    if (status && runner.isActive(card.id)) throw new HttpError(409, 'card has a running session');
    const specChanged = (title !== undefined && title !== card.title) || (description !== undefined && description !== card.description);
    // A human moving a card out of Blocked has dealt with it: automatic retries and landing attempts start over.
    const pipeline =
      card.status === 'blocked' && status && status !== 'blocked'
        ? { ...card.pipeline, escalated: false, mergeAttempts: 0, retries: 0, reviewRounds: 0 }
        : undefined;
    return store.updateCard(card.id, { title, description, status, routing, grants, pipeline, classification: specChanged ? null : undefined }, 'user:local');
  });

  // --- tree: goals, dependencies, routing
  app.post<{ Params: { id: string }; Body: { goal?: string; description?: string } }>('/api/boards/:id/goals', async (req) => {
    if (!store.getBoard(req.params.id)) throw new HttpError(404, 'board not found');
    if (!scheduler) throw new HttpError(503, 'scheduler not running');
    try {
      const goal = required(req.body, 'goal');
      const description = req.body?.description?.trim() ?? '';
      // Two or more enabled orchestrators with open pools plan the goal together (council.ts).
      // Not on direct boards: council verification resets each member's checkout, which there is the user's folder.
      if (council && store.getBoard(req.params.id)?.mode !== 'direct' && council.members(req.params.id).length >= 2) return await council.startGoal(req.params.id, goal, description);
      return await scheduler.startGoal(req.params.id, goal, description);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(409, (err as Error).message);
    }
  });
  app.get<{ Params: { id: string } }>('/api/boards/:id/dependencies', async (req) => store.dependencies(req.params.id));
  app.post<{ Params: { id: string }; Body: { blockedBy?: string } }>('/api/cards/:id/dependencies', async (req) => {
    try {
      return store.addDependency(req.params.id, required(req.body, 'blockedBy'), 'user:local');
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });
  // How the scheduler would rank pools for this card right now (eligibility and score breakdown).
  app.get<{ Params: { id: string } }>('/api/cards/:id/route', async (req) => {
    const card = store.getCard(req.params.id);
    if (!card) throw new HttpError(404, 'card not found');
    if (!scheduler) throw new HttpError(503, 'scheduler not running');
    return scheduler.rank(card);
  });

  // --- settings
  app.get<{ Params: { id: string } }>('/api/boards/:id/settings', async (req) => {
    if (!store.getBoard(req.params.id)) throw new HttpError(404, 'board not found');
    return store.getSettings(req.params.id);
  });
  app.patch<{ Params: { id: string }; Body: Partial<Settings> }>('/api/boards/:id/settings', async (req) => {
    if (!store.getBoard(req.params.id)) throw new HttpError(404, 'board not found');
    const patch = req.body ?? {};
    if (patch.agents) {
      // Checked with the implicit workers included, since delegation may name them.
      const next = mergeSettings(store.getSettings(req.params.id), patch);
      const problem = validateAgents([...next.agents, ...effectiveAgents(next, runner.pools()).filter((a) => a.implicit)]);
      if (problem) throw new HttpError(400, problem);
    }
    return store.updateSettings(req.params.id, patch, 'user:local');
  });

  // --- runs
  app.post<{ Params: { id: string }; Body: { poolId?: string; model?: string; agentId?: string } }>('/api/cards/:id/run', async (req) => {
    try {
      const model = req.body?.model?.trim() || undefined;
      return await runner.run(req.params.id, required(req.body, 'poolId'), { model, agentId: req.body?.agentId || undefined });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(409, (err as Error).message);
    }
  });
  app.post<{ Params: { id: string } }>('/api/cards/:id/cancel', async (req) => {
    await runner.cancel(req.params.id);
    return { ok: true };
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/cards/:id/events', async (req) => {
    if (!store.getCard(req.params.id)) throw new HttpError(404, 'card not found');
    return store.eventsFor(req.params.id, Number(req.query.after ?? 0));
  });
  app.get<{ Params: { id: string } }>('/api/cards/:id/sessions', async (req) => store.listSessions(req.params.id));
  // Delete a card's worktree folder (its branch and committed work stay; the next run makes a fresh worktree).
  // Uncommitted changes are listed and refused unless `force` says to discard them.
  app.post<{ Params: { id: string }; Body: { force?: boolean } }>('/api/cards/:id/worktree/remove', async (req) => {
    const card = store.getCard(req.params.id);
    if (!card) throw new HttpError(404, 'card not found');
    const board = store.getBoard(card.boardId)!;
    if (board.mode === 'direct') throw new HttpError(400, 'a direct board works in the project folder itself: there is no worktree to remove');
    if (!card.worktree) throw new HttpError(409, 'this card has no worktree');
    if (runner.isActive(card.id)) throw new HttpError(409, "stop the card's session first");
    const result = await removeWorktreeSafely(board.repoPath, card.worktree, req.body?.force === true);
    if (!result.removed) {
      const shown = result.dirty.slice(0, 5).join(', ') + (result.dirty.length > 5 ? `, and ${result.dirty.length - 5} more` : '');
      throw new HttpError(409, `${result.dirty.length} file${result.dirty.length === 1 ? ' has' : 's have'} uncommitted changes (${shown}). Removing the worktree would lose them; use force to discard them.`);
    }
    store.updateCard(card.id, { worktree: null });
    return { removed: true, discarded: result.dirty, branch: card.branch };
  });

  // --- coordination: messages and leases
  app.post<{ Params: { id: string }; Body: { body?: string; urgent?: boolean } }>('/api/cards/:id/messages', async (req) => {
    const card = store.getCard(req.params.id);
    if (!card) throw new HttpError(404, 'card not found');
    const body = required(req.body, 'body');
    const urgent = req.body?.urgent === true || /^!urgent\b/i.test(body);
    const message = store.postMessage({
      boardId: card.boardId,
      fromActor: 'user:local',
      toCard: card.id,
      body: body.replace(/^!urgent\s*/i, ''),
      urgent,
    });
    runner.deliver(card.id);
    return message;
  });
  app.get<{ Params: { id: string } }>('/api/boards/:id/messages', async (req) => store.boardMessages(req.params.id));
  app.get<{ Params: { id: string } }>('/api/boards/:id/leases', async (req) => store.activeLeases(req.params.id));

  // --- a card's changes: the files its branch changed (or its landed merge changed), diffs and file contents

  /**
   * The commit range a card's work spans. A landed card: its merge commit against the first parent. Otherwise: its
   * branch head against where it forked from the default branch.
   */
  async function cardRange(cardId: string) {
    const card = store.getCard(cardId);
    if (!card) throw new HttpError(404, 'card not found');
    const board = store.getBoard(card.boardId)!;
    const repo = board.repoPath;
    const landed = card.pipeline.landedSha ?? null;
    if (landed && (await revParse(repo, landed))) {
      const parent = await revParse(repo, `${landed}^1`);
      return { card, repo, from: parent ?? landed, to: landed, landed: true, base: board.defaultBranch };
    }
    if (!card.branch || !(await revParse(repo, card.branch))) return { card, repo, from: null, to: null, landed: false, base: board.defaultBranch };
    const to = (await revParse(repo, card.branch))!;
    const from = await git(repo, ['merge-base', board.defaultBranch, card.branch]).catch(() => board.defaultBranch);
    return { card, repo, from, to, landed: false, base: board.defaultBranch };
  }
  const safePath = (p?: string) => {
    if (!p || p.startsWith('/') || p.split('/').includes('..')) throw new HttpError(400, 'path must be repo-relative');
    return p;
  };

  /**
   * Direct boards have no branch to diff: a card's changes are the files its agent's edit tools touched (from the
   * event log), relative to the folder. Edits made through shell commands don't show up here.
   */
  const EDIT_KINDS = new Set(['edit', 'delete', 'move', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
  function touchedFiles(cardId: string, root: string): string[] {
    const files = new Set<string>();
    for (const e of store.eventsFor(cardId)) {
      if (e.type !== 'session.event') continue;
      const ev = (e.payload as { event?: { type?: string; kind?: string; locations?: string[] } }).event;
      if (ev?.type !== 'tool_call' || !EDIT_KINDS.has(String(ev.kind))) continue;
      for (const loc of ev.locations ?? []) {
        const rel = relative(root, resolve(root, loc));
        if (rel && !rel.startsWith('..') && !isAbsolute(rel)) files.add(rel.split('\\').join('/'));
      }
    }
    return [...files].sort();
  }
  const directBoard = (cardId: string) => {
    const card = store.getCard(cardId);
    const board = card ? store.getBoard(card.boardId) : undefined;
    return board?.mode === 'direct' ? board : null;
  };

  app.get<{ Params: { id: string } }>('/api/cards/:id/changes', async (req) => {
    const direct = directBoard(req.params.id);
    if (direct) {
      const files = touchedFiles(req.params.id, direct.repoPath).map((path) => ({ path, status: existsSync(resolve(direct.repoPath, path)) ? 'M' : 'D', additions: null, deletions: null }));
      return { direct: true, landed: false, base: direct.defaultBranch, branch: null, from: null, to: null, files, commits: [] };
    }
    const r = await cardRange(req.params.id);
    if (!r.from || !r.to) return { landed: false, base: r.base, branch: r.card.branch, from: null, to: null, files: [], commits: [] };
    return {
      landed: r.landed,
      base: r.base,
      branch: r.card.branch,
      from: r.from,
      to: r.to,
      files: await changesBetween(r.repo, r.from, r.to),
      commits: await commitsBetween(r.repo, r.from, r.to),
    };
  });
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/cards/:id/diff', async (req) => {
    if (directBoard(req.params.id)) return { diff: '' };
    const r = await cardRange(req.params.id);
    if (!r.from || !r.to) return { diff: '' };
    return { diff: await diffBetween(r.repo, r.from, r.to, req.query.path ? safePath(req.query.path) : undefined) };
  });
  // A file as the card's work left it, or with side=from as it was before (the VS Code extension diffs the two).
  app.get<{ Params: { id: string }; Querystring: { path?: string; side?: string } }>('/api/cards/:id/file', async (req) => {
    const direct = directBoard(req.params.id);
    if (direct) {
      // Only the current contents exist: the folder itself, with no history.
      if (req.query.side === 'from') throw new HttpError(404, 'direct boards keep no earlier version');
      const path = safePath(req.query.path);
      const content = await readFile(resolve(direct.repoPath, path), 'utf8').catch(() => null);
      if (content === null) throw new HttpError(404, 'file not found');
      return { path, ref: 'working folder', content };
    }
    const r = await cardRange(req.params.id);
    const ref = req.query.side === 'from' ? r.from : r.to;
    if (!ref) throw new HttpError(404, 'the card has no commits yet');
    const content = await fileAt(r.repo, ref, safePath(req.query.path));
    if (content === null) throw new HttpError(404, 'file not in this version');
    return { path: req.query.path, ref, content };
  });

  // --- metrics, budgets and pool history (Phase 6.3)
  const hoursParam = (raw: string | undefined, fallback = 24) => Math.min(24 * 30, Math.max(1, Number(raw ?? fallback) || fallback));
  app.get<{ Params: { id: string }; Querystring: { hours?: string } }>('/api/boards/:id/metrics', async (req) => {
    if (!store.getBoard(req.params.id)) throw new HttpError(404, 'board not found');
    const hours = hoursParam(req.query.hours);
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    return {
      ...buildMetrics({ rows: store.usageBreakdown(req.params.id, since), cards: store.listCards(req.params.id), series: store.usageSeries(req.params.id, since, hours > 72 ? 'day' : 'hour'), since }),
      hours,
      budgets: budgets?.status(req.params.id) ?? [],
    };
  });
  app.get<{ Params: { id: string } }>('/api/boards/:id/budgets', async (req) => {
    if (!store.getBoard(req.params.id)) throw new HttpError(404, 'board not found');
    return budgets?.status(req.params.id) ?? [];
  });
  app.get<{ Params: { id: string }; Querystring: { hours?: string } }>('/api/pools/:id/history', async (req) => {
    if (!runner.pools().some((p) => p.id === req.params.id) && !limiter.statuses().some((s) => s.poolId === req.params.id)) throw new HttpError(404, 'unknown pool');
    const hours = hoursParam(req.query.hours);
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    const samples = store.poolHistory(req.params.id, since);
    return { poolId: req.params.id, hours, samples, usage: store.poolUsageSeries(req.params.id, since, hours > 72 ? 'day' : 'hour'), outages: outages(samples) };
  });

  // --- approvals (Phase 6.4)
  // The board's tool grants: is each one's command on this machine, and install it (the operator clicking Install is the approval).
  app.get<{ Params: { id: string } }>('/api/boards/:id/tools', async (req) => {
    if (!store.getBoard(req.params.id)) throw new HttpError(404, 'board not found');
    const grants = store.getSettings(req.params.id).grants;
    const missing = new Set(approvals?.missingTools(req.params.id, Object.keys(grants)) ?? []);
    return Object.entries(grants).map(([name, g]) => ({ name, command: g.command, installed: !!g.command && !missing.has(name), installable: !!g.install?.trim() && !!approvals }));
  });
  app.post<{ Params: { id: string; grant: string } }>('/api/boards/:id/tools/:grant/install', async (req) => {
    if (!store.getBoard(req.params.id)) throw new HttpError(404, 'board not found');
    if (!approvals) throw new HttpError(503, 'approvals not running');
    try {
      return await approvals.installTool(req.params.id, req.params.grant);
    } catch (err) {
      throw new HttpError(409, (err as Error).message);
    }
  });
  app.get<{ Params: { id: string }; Querystring: { status?: string } }>('/api/boards/:id/approvals', async (req) => {
    if (!store.getBoard(req.params.id)) throw new HttpError(404, 'board not found');
    const status = (['pending', 'approved', 'denied'] as const).find((s) => s === req.query.status);
    return store.listApprovals(req.params.id, { status });
  });
  app.post<{ Params: { id: string }; Body: { decision?: string; note?: string } }>('/api/approvals/:id/decide', async (req) => {
    const decision = req.body?.decision;
    if (decision !== 'approve' && decision !== 'deny') throw new HttpError(400, 'decision must be approve or deny');
    if (!approvals) throw new HttpError(503, 'approvals not running');
    const found = store.getApproval(req.params.id);
    if (!found) throw new HttpError(404, 'approval not found');
    try {
      return approvals.decide(req.params.id, decision === 'approve' ? 'approved' : 'denied', 'user:local', req.body?.note);
    } catch (err) {
      throw new HttpError(409, (err as Error).message);
    }
  });

  // --- the operator as reviewer, land now, try locally, chat (Phase 6.1)
  /** Comments on lines of a card's diff, as the author will read them. */
  const commentLines = (comments: { path?: string; line?: number; endLine?: number; body?: string }[]) =>
    comments
      .filter((c) => c.body?.trim() && c.path)
      .map((c) => `- ${safePath(c.path)}${c.line ? `:${c.line}${c.endLine && c.endLine !== c.line ? `-${c.endLine}` : ''}` : ''}: ${c.body!.trim()}`);
  app.post<{ Params: { id: string }; Body: { verdict?: string; notes?: string; comments?: { path?: string; line?: number; endLine?: number; body?: string }[] } }>('/api/cards/:id/review', async (req) => {
    if (!refinery) throw new HttpError(503, 'refinery not running');
    const verdict = req.body?.verdict;
    if (verdict !== 'approve' && verdict !== 'changes') throw new HttpError(400, 'verdict must be approve or changes');
    const lines = commentLines(req.body?.comments ?? []);
    const notes = [req.body?.notes?.trim() ?? '', lines.length ? `Comments on the code:\n${lines.join('\n')}` : ''].filter(Boolean).join('\n\n');
    try {
      return refinery.humanVerdict(req.params.id, verdict, notes);
    } catch (err) {
      throw new HttpError(409, (err as Error).message);
    }
  });
  // A comment on a line of the diff while the card is still being worked: goes to its agent as a message, no verdict.
  app.post<{ Params: { id: string }; Body: { path?: string; line?: number; endLine?: number; body?: string } }>('/api/cards/:id/comments', async (req) => {
    const card = store.getCard(req.params.id);
    if (!card) throw new HttpError(404, 'card not found');
    const [line] = commentLines([req.body ?? {}]);
    if (!line) throw new HttpError(400, 'path and body are required');
    const message = store.postMessage({ boardId: card.boardId, fromActor: 'user:local', toCard: card.id, body: `Comment on your changes:\n${line}`, urgent: false });
    runner.deliver(card.id);
    return message;
  });
  app.post<{ Params: { id: string } }>('/api/cards/:id/land', async (req) => {
    if (!refinery) throw new HttpError(503, 'refinery not running');
    try {
      return refinery.landNow(req.params.id);
    } catch (err) {
      throw new HttpError(409, (err as Error).message);
    }
  });
  app.post<{ Params: { id: string }; Body: { mode?: string } }>('/api/cards/:id/try', async (req) => {
    const mode = req.body?.mode;
    if (mode !== 'checkout' && mode !== 'apply') throw new HttpError(400, 'mode must be checkout or apply');
    if (directBoard(req.params.id)) throw new HttpError(409, 'direct boards work in your checkout already');
    const r = await cardRange(req.params.id);
    if (!r.to) throw new HttpError(409, 'the card has no commits yet');
    try {
      return await tryLocally(r.repo, mode, r.to, r.base);
    } catch (err) {
      throw new HttpError(409, (err as Error).message);
    }
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/cards/:id/chat', async (req) => {
    if (!store.getCard(req.params.id)) throw new HttpError(404, 'card not found');
    const items = buildChat(store, req.params.id, Number(req.query.after ?? 0));
    return { items, last: items.reduce((m, i) => Math.max(m, i.seq), Number(req.query.after ?? 0)) };
  });
  app.get<{ Params: { id: string } }>('/api/boards/:id/ide', async (req) => ({ attached: bridge?.attached(req.params.id) ?? false, windows: bridge?.windows(req.params.id) ?? [] }));

  // --- context (master plan §5.7)
  const kinds = (raw?: string): ArtifactKind[] | undefined => {
    const list = (raw ?? '').split(',').filter((k): k is ArtifactKind => (ARTIFACT_KINDS as readonly string[]).includes(k));
    return list.length ? list : undefined;
  };
  app.get<{ Params: { id: string }; Querystring: { q?: string; card?: string; scope?: string; kinds?: string; limit?: string } }>(
    '/api/boards/:id/context',
    async (req) => {
      if (!store.getBoard(req.params.id)) throw new HttpError(404, 'board not found');
      const q = req.query.q?.trim();
      if (!q) return store.listArtifacts(req.params.id, { kinds: kinds(req.query.kinds), limit: Number(req.query.limit ?? 100) }).map((artifact) => ({ artifact, score: 0, via: [] }));
      if (!context) throw new HttpError(503, 'context store not running');
      const scope = (['card', 'subtree', 'board'] as const).find((s) => s === req.query.scope) as SearchScope | undefined;
      return context.search({ boardId: req.params.id, query: q, cardId: req.query.card ?? null, scope, kinds: kinds(req.query.kinds), limit: Number(req.query.limit ?? 10) });
    },
  );
  app.get<{ Params: { id: string }; Querystring: { all?: string } }>('/api/cards/:id/artifacts', async (req) => {
    const card = store.getCard(req.params.id);
    if (!card) throw new HttpError(404, 'card not found');
    return store.listArtifacts(card.boardId, { cardIds: [card.id], all: req.query.all === '1' });
  });
  app.post<{ Params: { id: string }; Body: { kind?: string; title?: string; body?: string; supersedes?: string } }>('/api/cards/:id/artifacts', async (req) => {
    const card = store.getCard(req.params.id);
    if (!card) throw new HttpError(404, 'card not found');
    if (!context) throw new HttpError(503, 'context store not running');
    const kind = req.body?.kind ?? 'note';
    if (!(ARTIFACT_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, `kind must be one of ${ARTIFACT_KINDS.join(', ')}`);
    try {
      return context.put({ boardId: card.boardId, cardId: card.id, kind: kind as ArtifactKind, title: required(req.body, 'title'), body: required(req.body, 'body'), author: 'user:local', supersedes: req.body?.supersedes || null });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, (err as Error).message);
    }
  });
  app.get<{ Params: { id: string } }>('/api/artifacts/:id', async (req) => {
    const a = store.getArtifact(req.params.id);
    if (!a) throw new HttpError(404, 'artifact not found');
    return a;
  });

  // --- outcomes and priors (master plan §5.4 step 7)
  app.get<{ Querystring: { limit?: string; board?: string; pending?: string } }>('/api/outcomes', async (req) =>
    store.listOutcomes(Number(req.query.limit ?? 200), { boardId: req.query.board, pending: req.query.pending === '1' }),
  );
  /** A human weighs an outcome the daemon left pending (an agent's block): pass, fail or ignore. */
  app.post<{ Params: { id: string }; Body: { verdict?: string } }>('/api/outcomes/:id/review', async (req) => {
    const verdict = req.body?.verdict;
    if (verdict !== 'pass' && verdict !== 'fail' && verdict !== 'ignore') throw new HttpError(400, 'verdict must be pass, fail or ignore');
    if (!store.getOutcome(Number(req.params.id))) throw new HttpError(404, 'outcome not found');
    return store.reviewOutcome(Number(req.params.id), verdict, 'user:local');
  });
  app.get<{ Params: { id: string } }>('/api/cards/:id/outcomes', async (req) => store.outcomesFor(req.params.id));
  /** Each agent's effective prior (built-in model family plus the board's override) and its recorded outcomes per work type. */
  app.get<{ Params: { id: string } }>('/api/boards/:id/priors', async (req) => {
    if (!store.getBoard(req.params.id)) throw new HttpError(404, 'board not found');
    const settings = store.getSettings(req.params.id);
    const outcomes = store.listOutcomes(10_000);
    return effectiveAgents(settings, runner.pools()).map((agent) => {
      const pool = runner.pools().find((p) => p.id === agent.poolId)!;
      const model = agent.model || pool.model;
      const mine = outcomes.filter((o) => o.poolId === agent.poolId && o.model === model);
      const byType: Record<string, { n: number; mean: number }> = {};
      for (const o of mine) {
        const t = (byType[o.workType] ??= { n: 0, mean: 0 });
        t.mean = (t.mean * t.n + o.value) / (t.n + 1);
        t.n++;
      }
      return { agentId: agent.id, poolId: agent.poolId, model, role: agent.role, prior: priorFor(agent.poolId, model, settings.priorOverrides[agent.id]), observed: byType };
    });
  });

  // --- built web UI, when present (dev uses the Vite server instead)
  if (existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}
