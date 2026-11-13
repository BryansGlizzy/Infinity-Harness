import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCodexRateLimits } from '@ih/adapters';
import { Store } from '@ih/db';
import { RateLimiter, startGateway } from '@ih/gateway';
import { FastLane } from '@ih/fast-lane';
import { KevClient } from '@ih/router';
import { ContextService, Embedder } from '@ih/context';
import { Approvals } from './approvals.ts';
import { authOptionsFromEnv, loadApiToken } from './auth.ts';
import { BestOf } from './bestof.ts';
import { Budgets, describeBudget, isBudgetScope } from './budgets.ts';
import { PoolHistory } from './history.ts';
import { IdeBridge } from './ide.ts';
import { shellInstaller } from './installer.ts';
import { startCapture } from './context.ts';
import { CouncilRunner } from './council.ts';
import { loadConfig } from './config.ts';
import { repairMovedWorktrees } from './legacy.ts';
import { Live } from './live.ts';
import { Refinery } from './refinery.ts';
import { Runner } from './runner.ts';
import { PoolHealth } from './health.ts';
import { FinalSummary } from './final-summary.ts';
import { Scheduler, lockoutUntil } from './scheduler.ts';
import { buildServer } from './server.ts';
import { loadIdentity } from './federation/identity.ts';
import { buildFedServer } from './federation/routes.ts';
import { Federation } from './federation/service.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const config = loadConfig(root);
const store = new Store(config.dbFile);
const live = new Live();
if (config.legacy?.moved) {
  // Cards remember their worktree by path, and git remembers where each worktree lives: point both at the new folder.
  const fixed = await repairMovedWorktrees(store, config.legacy);
  console.log(`upgrade: ${fixed.cards} card path${fixed.cards === 1 ? '' : 's'} updated, worktrees repaired in ${fixed.repos} repositor${fixed.repos === 1 ? 'y' : 'ies'}`);
}

const limiter = new RateLimiter();
for (const pool of config.gateway.pools) limiter.configure(pool.id, pool.limits);
limiter.onChange((status) => live.publish(isBudgetScope(status.poolId) ? 'budget.status' : 'pool.status', status.poolId, status));
// Assigned below; the gateway's usage callback needs the runner, which needs the limiter.
let soleSession: (poolId: string) => ReturnType<Runner['soleSession']> = () => null;
const gateway = await startGateway({
  limiter,
  pools: config.gateway.pools,
  token: config.gateway.token,
  host: config.gateway.host,
  port: config.gateway.port,
  onUsage: (u) => {
    // A gateway request names no card; when exactly one session is working on the pool, the usage is credited to it.
    store.recordUsage({ ...u, source: 'gateway', ...(soleSession(u.poolId) ?? {}) });
    live.publish('pool.status', u.poolId, limiter.status(u.poolId));
  },
});

// Swarm federation (Phase 7); assigned below, once the scheduler it needs exists.
let federation: Federation | null = null;
// Pool health (is the model answering); built just after the runner, which it asks to probe harnesses.
let health: PoolHealth | null = null;
const runner = new Runner(store, config, {
  onClaudeRateLimits: (rl) =>
    limiter.report('claude', [
      ...(rl.fiveHour ? [{ window: '5h' as const, pct: rl.fiveHour.usedPct, resetsAt: rl.fiveHour.resetsAt }] : []),
      ...(rl.sevenDay ? [{ window: '7d' as const, pct: rl.sevenDay.usedPct, resetsAt: rl.sevenDay.resetsAt }] : []),
    ]),
  // Subscription pools have no usage API we can read; an observed lockout locks the pool until it lifts (§5.10).
  onPoolError: (poolId, message) => limiter.lock(poolId, lockoutUntil(message)),
  onProviderDown: (poolId, message) => void health?.suspect(poolId, message).catch(() => {}),
  caps: (boardId) => store.getSettings(boardId),
  telemetryEndpoint: `http://127.0.0.1:${config.port}`,
  peerLines: () => federation?.promptLines() ?? [],
});
soleSession = (poolId) => runner.soleSession(poolId);
health = new PoolHealth({
  store,
  pools: config.pools,
  upstreams: config.gateway.pools.map((u) => ({ id: u.id, baseUrl: u.baseUrl, apiKey: u.apiKey })),
  probeHarness: (poolId) => runner.models(poolId, true),
  // Said once to every board, in "Messages for you": the pool is out until a person turns it back on.
  notify: (poolId, reason) => {
    const label = config.pools.find((p) => p.id === poolId)?.label ?? poolId;
    runner.evictPool(poolId, reason);
    for (const board of store.listBoards()) {
      store.postMessage({ boardId: board.id, fromActor: 'daemon:health', toCard: null, body: `${label} stopped answering and was taken out of rotation (${reason}). It stays out until you turn it back on in Agents; this is not held against the model.`, urgent: false });
    }
  },
});

// Codex publishes its 5-hour and weekly usage (its /status); poll it into the same limiter Claude's feed.
if (config.binaries.codex && config.binaries.codexAcp) {
  const codexBin = config.binaries.codex;
  const pollCodex = async () => {
    const rl = await readCodexRateLimits(codexBin, config.agentEnv).catch(() => null);
    if (!rl) return;
    limiter.report('codex', [
      ...(rl.fiveHour ? [{ window: '5h' as const, pct: rl.fiveHour.usedPct, resetsAt: rl.fiveHour.resetsAt }] : []),
      ...(rl.sevenDay ? [{ window: '7d' as const, pct: rl.sevenDay.usedPct, resetsAt: rl.sevenDay.resetsAt }] : []),
    ]);
    // Out of usage: lock the pool until the window that is full resets (the weekly one if both are).
    if (rl.reached) {
      const full = [rl.sevenDay, rl.fiveHour].find((w) => w && w.usedPct >= 100) ?? rl.fiveHour ?? rl.sevenDay;
      if (full && full.resetsAt > Date.now()) limiter.lock('codex', full.resetsAt);
    }
  };
  void pollCodex();
  setInterval(() => void pollCodex(), 60_000).unref();
}

const kev = config.kev ? new KevClient(config.kev) : null;
const fastLane = new FastLane({
  gatewayUrl: config.gateway.url,
  token: config.gateway.token,
  chain: config.fastLane,
  poolState: (poolId) => limiter.status(poolId).state,
});
const embedder = config.embeddings ? new Embedder(config.embeddings) : null;
const context = new ContextService({ store, embedder, fastLane, minSimilarity: config.embeddings?.minSimilarity });
const stopCapture = startCapture(store, context);
// Artifacts saved while the embeddings endpoint was down get their vectors later.
const backfill = setInterval(() => void context.backfill().catch(() => {}), 5 * 60_000);
backfill.unref();
void context.backfill().catch(() => {});
// Budgets (Phase 6.3) live in the same limiter as the pools; the history keeps a week of pool samples.
const budgets = new Budgets({
  store,
  limiter,
  notify: (boardId, status) => store.postMessage({ boardId, fromActor: 'daemon:budget', toCard: null, body: describeBudget(status), urgent: false }),
});
budgets.start();
const history = new PoolHistory({ store, limiter, poolIds: () => config.pools.map((p) => p.id), running: (id) => runner.runningOn(id) });
history.start();
// A restart leaves sessions marked running that have no process; put their cards back before anything is scheduled.
const recovered = runner.recoverInterrupted();
if (recovered.sessions || recovered.requeued.length || recovered.blocked.length) {
  console.log(`recovered after restart: ${recovered.sessions} session${recovered.sessions === 1 ? '' : 's'} closed, ${recovered.requeued.length} card${recovered.requeued.length === 1 ? '' : 's'} back in Ready, ${recovered.blocked.length} blocked for you`);
}
const approvals = new Approvals({ store, runner, fastLane, installer: shellInstaller(config.agentEnv) });
const bridge = new IdeBridge();
const scheduler = new Scheduler({ store, runner, limiter, pools: config.pools, kev, fastLane, budgets, approvals, health, hold: (card) => federation?.holdReason(card) ?? null });
const finalSummary = new FinalSummary({ store, context, startTask: (boardId, title, description, prompt) => scheduler.startTask(boardId, title, description, prompt) });
finalSummary.start();
const bestOf = new BestOf({ store, runner, scheduler, kev });
scheduler.setBestOf(bestOf);
scheduler.start();
bestOf.start();
const refinery = new Refinery({ store, runner, scheduler, config, fastLane, context, kev, approvals });
refinery.start();
const council = new CouncilRunner({ store, runner, scheduler, kev, context });
council.start();
// Federation: this swarm's identity (kept with the database, so a second instance gets its own) and the listener peers call.
federation = new Federation({
  store,
  identity: loadIdentity(join(dirname(config.dbFile), 'swarm-key.json')),
  fastLane,
  port: config.fedPort ?? null,
  pollMs: process.env.IH_FED_POLL_MS ? Number(process.env.IH_FED_POLL_MS) : undefined,
  startGoal: (boardId, title, description) =>
    council.members(boardId).length >= 2 && store.getBoard(boardId)?.mode !== 'direct' ? council.startGoal(boardId, title, description) : scheduler.startGoal(boardId, title, description),
  runOrchestrator: (boardId, title, prompt) => scheduler.startTask(boardId, title, 'Writes the project card other swarms will read.', prompt),
  cancelCard: (cardId) => void runner.cancel(cardId).catch(() => {}),
  requestApproval: (req) => approvals.request({ ...req, kind: 'peer_request' }),
  wake: (cardId) => runner.deliver(cardId),
});
approvals.setFederation(federation);
federation.start();
let fedApp = config.fedPort ? await buildFedServer(federation) : null;
if (fedApp) {
  try {
    await fedApp.listen({ host: '127.0.0.1', port: config.fedPort! });
  } catch (err) {
    // A second instance on the same machine needs its own IH_FED_PORT; the rest of the daemon runs without federation.
    console.warn(`federation listener could not start on ${config.fedPort}: ${(err as Error).message} (set IH_FED_PORT to a free port, or IH_FED_PORT=off)`);
    await fedApp.close().catch(() => {});
    fedApp = null;
    federation.port = null;
  }
}
const apiTokenFile = join(config.dataDir, 'api-token');
const auth = authOptionsFromEnv(loadApiToken(apiTokenFile), config.host);
const app = await buildServer({ store, runner, config, live, limiter, scheduler, context, fastLane, council, refinery, budgets, approvals, bridge, federation, auth, health });

await app.listen({ host: config.host, port: config.port });
health.start();
// Probe each harness for its models in the background, so the UI's model pickers are ready when opened.
for (const pool of config.pools) runner.models(pool.id).catch((err: Error) => console.warn(`models for ${pool.id}: ${err.message}`));
console.log(`infinity-harness daemon on http://${config.host}:${config.port}`);
console.log(`api access: ${auth.requireToken ? 'token required for every client' : 'token required from other machines'}${auth.loopbackBound ? '' : ' (listening beyond loopback)'}; token in ${apiTokenFile}`);
console.log(`swarm ${federation.self().name} (${federation.identity.swarmId}), fingerprint ${federation.identity.fingerprint}; federation ${fedApp ? `listening on 127.0.0.1:${config.fedPort} (signed /fed routes only)` : 'off'}`);
console.log(`gateway on ${gateway.url} for ${config.gateway.pools.map((p) => p.id).join(', ') || 'no API pools'}`);
console.log(`pools: ${config.pools.map((p) => `${p.id} (${p.model})`).join(', ') || 'none — check .env'}`);
console.log(`github: ${config.binaries.gh ? `gh at ${config.binaries.gh}` : 'gh not found (cards land locally)'}`);
console.log(`context: full-text search${embedder ? ` + vectors (${embedder.model})` : ' only (EMBEDDINGS_BASE_URL unset)'}`);
console.log(`judge: ${kev ? config.kev!.model : 'none (KEV_URL unset; default classifications)'} · fast lane: ${config.fastLane.map((m) => m.poolId).join(' → ') || 'none'}`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  scheduler.stop();
  refinery.stop();
  bestOf.stop();
  budgets.stop();
  history.stop();
  council.stop();
  federation?.stop();
  await fedApp?.close().catch(() => {});
  stopCapture();
  clearInterval(backfill);
  runner.shutdown();
  await app.close();
  await gateway.close();
  store.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
