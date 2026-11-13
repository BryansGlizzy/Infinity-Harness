// Shared setup for the daemon's end-to-end tests: a temp repo, two fake-agent pools, store, runner, scheduler, server.
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Card, DaemonEvent } from '@ih/core';
import { Store } from '@ih/db';
import { AcpAgent } from '@ih/adapters';
import { RateLimiter } from '@ih/gateway';
import { FastLane } from '@ih/fast-lane';
import { KevClient } from '@ih/router';
import { ContextService } from '@ih/context';
import { Approvals } from '../src/approvals.ts';
import type { AuthOptions } from '../src/auth.ts';
import { BestOf } from '../src/bestof.ts';
import { Budgets } from '../src/budgets.ts';
import { IdeBridge } from '../src/ide.ts';
import { startCapture } from '../src/context.ts';
import { CouncilRunner } from '../src/council.ts';
import type { DaemonConfig } from '../src/config.ts';
import { commitAll, git } from '../src/git.ts';
import { Live } from '../src/live.ts';
import { Runner } from '../src/runner.ts';
import { Refinery } from '../src/refinery.ts';
import { Scheduler, lockoutUntil } from '../src/scheduler.ts';
import { PoolHealth } from '../src/health.ts';
import type { GitHub } from '../src/github.ts';
import { buildServer } from '../src/server.ts';
import { generateIdentity } from '../src/federation/identity.ts';
import { buildFedServer } from '../src/federation/routes.ts';
import { Federation } from '../src/federation/service.ts';

const fakeAgent = fileURLToPath(new URL('../../../packages/adapters/test/fake-agent.mjs', import.meta.url));

/** Kev stand-in: every card is a small bugfix. */
export const kevStub = new KevClient({
  url: 'http://kev',
  model: 'kev-9b',
  fetch: (async () =>
    new Response(
      JSON.stringify({
        answers: {
          work_type: { type: 'noul', noul: 0.8, choice: 'bugfix', probabilities: { bugfix: 0.8 } },
          complexity: { type: 'score', score: 1.2, probabilities: { 1: 0.8 } },
          needs_review: { type: 'noul', noul: 0.2 },
        },
      }),
    )) as typeof fetch,
});

/** Fast-lane stand-in: specs containing VAGUE fail lint; narration is a fixed line. */
export const laneStub = () =>
  new FastLane({
    gatewayUrl: 'http://gw',
    token: 't',
    chain: [{ poolId: 'groq', model: 'g' }],
    poolState: () => 'open',
    fetch: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const input = body.messages[1].content as string;
      const content = body.messages[0].content.startsWith('You narrate')
        ? 'Working through the card'
        : input.includes('VAGUE')
          ? '{"ok": false, "problem": "No clear scope."}'
          : '{"ok": true}';
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
    }) as typeof fetch,
  });

export async function tempRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), 'ih-repo-'));
  await git(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  await commitAll(repo, 'init');
  return repo;
}

/** Tools the fake machine has; `installs` records what the stand-in installer was asked to run. */
export function fakeInstaller(have: Set<string> = new Set()) {
  const installs: string[] = [];
  return {
    have,
    installs,
    isInstalled: (c: string) => have.has(c),
    run: async (cmd: string) => {
      installs.push(cmd);
      const m = /^install (\S+)$/.exec(cmd);
      if (m) have.add(m[1]!);
      return m ? { ok: true, output: 'ok' } : { ok: false, output: 'boom: no such package' };
    },
  };
}

export async function setup(opts: { installer?: ReturnType<typeof fakeInstaller>; kev?: KevClient | null; lane?: FastLane | null; github?: GitHub | null; outcomeKev?: KevClient | null; webDist?: string; auth?: AuthOptions; federation?: boolean } = {}) {
  const repo = await tempRepo();
  const dataDir = mkdtempSync(join(tmpdir(), 'ih-data-'));
  const cfg: DaemonConfig = {
    root: dataDir,
    dataDir,
    dbFile: ':memory:',
    worktreesDir: join(dataDir, 'worktrees'),
    opencodeConfigPath: join(dataDir, 'opencode.json'),
    binaries: { claude: null, kimi: null, agyAcp: null },
    webDist: opts.webDist ?? join(dataDir, 'web'),
    host: '127.0.0.1',
    port: 0,
    pools: [
      { id: 'fa', label: 'Fake A', harness: 'opencode', model: 'fake/two', kind: 'subscription' },
      { id: 'fb', label: 'Fake B', harness: 'opencode', model: 'fake/two', kind: 'subscription' },
    ],
    agentEnv: process.env,
    gateway: { host: '127.0.0.1', port: 0, url: 'http://127.0.0.1:0', token: 't', pools: [] },
    kev: null,
    fastLane: [],
  };
  const store = new Store(':memory:');
  const limiter = new RateLimiter();
  const runner = new Runner(store, cfg, {
    isInstalled: opts.installer ? opts.installer.isInstalled : () => false,
    makeAdapter: () => new AcpAgent({ id: 'fake', command: process.execPath, args: [fakeAgent], cwd: dataDir, env: process.env }),
    caps: (boardId) => store.getSettings(boardId),
    onPoolError: (poolId, message) => limiter.lock(poolId, lockoutUntil(message)),
  });
  const budgets = new Budgets({ store, limiter });
  const approvals = new Approvals({ store, runner, fastLane: opts.lane ?? null, installer: opts.installer ?? null });
  const bridge = new IdeBridge();
  let federationRef: Federation | null = null;
  const health = new PoolHealth({ store, pools: cfg.pools, upstreams: [], probeHarness: async () => [] });
  const scheduler = new Scheduler({ store, runner, limiter, pools: cfg.pools, health, kev: opts.kev ?? null, fastLane: opts.lane ?? null, budgets, approvals, tickMs: 100, hold: (card) => federationRef?.holdReason(card) ?? null });
  // Not started: tests that race candidates call bestOf.start().
  const bestOf = new BestOf({ store, runner, scheduler, kev: opts.outcomeKev ?? opts.kev ?? null, tickMs: 100 });
  scheduler.setBestOf(bestOf);
  const context = new ContextService({ store, embedder: null, fastLane: opts.lane ?? null });
  const stopCapture = startCapture(store, context);
  // Not started: tests that land cards call refinery.start().
  const refinery = new Refinery({
    store,
    runner,
    scheduler,
    config: cfg,
    fastLane: opts.lane ?? null,
    github: opts.github ?? null,
    tickMs: 100,
    context,
    kev: opts.outcomeKev ?? null,
    approvals,
  });
  const council = new CouncilRunner({ store, runner, scheduler, kev: opts.kev ?? null, context, tickMs: 100 });
  // Swarm federation (Phase 7), when a test asks for it: its own listener on a free port, peers reached by local URL.
  let federation: Federation | null = null;
  let fedApp: Awaited<ReturnType<typeof buildFedServer>> | null = null;
  let fedUrl = '';
  if (opts.federation) {
    federation = new Federation({
      store,
      identity: generateIdentity(),
      fastLane: opts.lane ?? null,
      eager: false,
      pollMs: 3_600_000,
      startGoal: (boardId, title, description) => scheduler.startGoal(boardId, title, description),
      runOrchestrator: (boardId, title, prompt) => scheduler.startTask(boardId, title, 'Writes the project card other swarms will read.', prompt),
      cancelCard: (cardId) => void runner.cancel(cardId).catch(() => {}),
      requestApproval: (req) => approvals.request({ ...req, kind: 'peer_request' }),
      wake: (cardId) => runner.deliver(cardId),
    });
    approvals.setFederation(federation);
    federationRef = federation;
    fedApp = await buildFedServer(federation);
    await fedApp.listen({ host: '127.0.0.1', port: 0 });
    fedUrl = `http://127.0.0.1:${(fedApp.server.address() as AddressInfo).port}`;
    federation.port = (fedApp.server.address() as AddressInfo).port;
    federation.start();
  }
  const app = await buildServer({ store, runner, config: cfg, live: new Live(), limiter, scheduler, context, fastLane: opts.lane ?? null, council, refinery, budgets, approvals, bridge, federation, auth: opts.auth ?? null, health });
  await app.listen({ host: '127.0.0.1', port: 0 });
  cfg.port = (app.server.address() as AddressInfo).port;
  const board = store.createBoard({ name: 'Demo', repoPath: repo, defaultBranch: 'main' });
  store.updateSettings(board.id, { poolSlots: { fa: 3, fb: 3 }, agents: [{ id: 'orchestrator', poolId: 'fa', model: '', role: 'orchestrator', delegatesTo: [], enabled: true }] });
  const close = async () => {
    scheduler.stop();
    refinery.stop();
    bestOf.stop();
    budgets.stop();
    council.stop();
    stopCapture();
    federation?.stop();
    runner.shutdown();
    await context.idle();
    await app.close();
    await fedApp?.close();
  };
  return { repo, store, runner, limiter, health, scheduler, refinery, context, council, budgets, approvals, bridge, bestOf, board, cfg, federation, fedUrl, close };
}

export function waitFor(store: Store, predicate: (e: DaemonEvent) => boolean, ms = 15_000): Promise<DaemonEvent> {
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

export const status = (store: Store, id: string, s: string) => (e: DaemonEvent) =>
  e.type === 'card.updated' && e.subject === id && (e.payload as { card: Card }).card.status === s;

/** Resolves when every card matching `filter` has reached Review. */
export async function allReviewed(store: Store, boardId: string, filter: (c: Card) => boolean, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const cards = store.listCards(boardId).filter(filter);
    if (cards.length && cards.every((c) => c.status === 'review')) return cards;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`not all reviewed: ${JSON.stringify(store.listCards(boardId).filter(filter).map((c) => [c.title, c.status]))}`);
}

