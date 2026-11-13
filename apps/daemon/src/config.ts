import { accessSync, constants, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import type { Pool } from '@ih/core';
import { applyLegacyEnv, migrateLegacyState, type LegacyMove } from './legacy.ts';
import { agentEnvironment, apiPoolsFromEnv, gatewayToken, type ApiPool } from './gateway.ts';

export interface DaemonConfig {
  root: string;
  dataDir: string;
  dbFile: string;
  /** Set when this start moved the state folder over from the old Meta-Harness name (see legacy.ts). */
  legacy?: LegacyMove;
  worktreesDir: string;
  opencodeConfigPath: string;
  binaries: HarnessBinaries;
  webDist: string;
  host: string;
  port: number;
  /** The federation listener (Phase 7): signed /fed/* routes only, on loopback. Null: switched off (`IH_FED_PORT=off`). */
  fedPort?: number | null;
  pools: Pool[];
  /** Environment for agent processes: provider keys removed, gateway token added. */
  agentEnv: NodeJS.ProcessEnv;
  gateway: { host: string; port: number; url: string; token: string; pools: ApiPool[] };
  /** The Kev judge (Decision API); null when not configured. */
  kev: { url: string; apiKey?: string; model: string } | null;
  /** Fast-lane models in fallback order (master plan §5.11): Groq, then NIM, then local. */
  fastLane: { poolId: string; model: string }[];
  /** Embeddings endpoint for vector search (master plan §5.7); null: full-text search only. */
  embeddings?: { baseUrl: string; model: string; apiKey?: string; minSimilarity?: number } | null;
}

export function fastLaneChain(env: NodeJS.ProcessEnv): { poolId: string; model: string }[] {
  const chain: { poolId: string; model: string }[] = [];
  if (env.GROQ_API_KEY && env.GROQ_MODEL) chain.push({ poolId: 'groq', model: env.GROQ_MODEL });
  if (env.NVIDIA_API_KEY && env.NVIDIA_MODEL) chain.push({ poolId: 'nim', model: env.NVIDIA_MODEL });
  if (env.LOCAL_LLM_BASE_URL && env.LOCAL_LLM_MODEL) chain.push({ poolId: 'local', model: env.LOCAL_LLM_MODEL });
  return chain;
}

/**
 * Builds the opencode.json the daemon hands to OpenCode. Every API provider points at the daemon's
 * gateway (master plan §5.10), authenticated with the local token, so OpenCode never sees a real key.
 */
export function opencodeConfig(env: NodeJS.ProcessEnv, gatewayUrl: string): object {
  const providers: Record<string, unknown> = {};
  const viaGateway = (pool: string) => ({ baseURL: `${gatewayUrl}/p/${pool}/v1`, apiKey: '{env:IH_GATEWAY_TOKEN}' });
  if (env.NVIDIA_API_KEY) providers.nvidia = { settings: viaGateway('nim') };
  if (env.LOCAL_LLM_BASE_URL && env.LOCAL_LLM_MODEL) {
    providers.local = {
      name: 'Local LLM',
      env: ['IH_GATEWAY_TOKEN'],
      package: '@opencode/ai/providers/openai-compatible',
      settings: viaGateway('local'),
      models: {
        [env.LOCAL_LLM_MODEL]: {
          name: `${env.LOCAL_LLM_MODEL} (local)`,
          limit: { context: Number(env.LOCAL_LLM_CONTEXT ?? 262144), output: 32768 },
          capabilities: { tools: true },
        },
      },
    };
  }
  return {
    $schema: 'https://opencode.ai/config.json',
    providers,
    // OpenCode's base policy allows everything; asking routes each of these to the daemon's
    // worktree policy over ACP. The last matching rule wins, so these follow the base rule.
    permissions: ['edit', 'shell', 'webfetch', 'websearch', 'external_directory'].map((action) => ({
      action,
      resource: '*',
      effect: 'ask',
    })),
  };
}

export interface HarnessBinaries {
  claude: string | null;
  kimi: string | null;
  /** The `codex-acp` bridge; Codex itself must also be signed in. */
  codexAcp?: string | null;
  /** The `codex` CLI, asked for the account's 5-hour and weekly usage. */
  codex?: string | null;
  agyAcp: string | null;
  /** OpenCode binary (`opencode acp`) for NIM and Local LLM pools. */
  opencode?: string | null;
  /** GitHub CLI, for opening and merging PRs. */
  gh?: string | null;
}

/** Finds an executable on PATH, then in common install locations. */
export function findBinary(name: string, env: NodeJS.ProcessEnv, extra: string[] = []): string | null {
  const dirs = [...(env.PATH ?? '').split(delimiter), join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', ...extra];
  for (const dir of dirs) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

const SYSTEM_POOL_IDS = new Set(['claude', 'codex', 'kimi', 'agy', 'nim', 'local']);

export function detectBinaries(dataDir: string, env: NodeJS.ProcessEnv): HarnessBinaries {
  const isDefaultEnv = env === process.env;
  const npmGlobal = isDefaultEnv ? [join(homedir(), '.npm-global', 'bin')] : [];
  const opencodeDirs = isDefaultEnv ? [join(homedir(), '.opencode', 'bin'), join(homedir(), '.npm-global', 'bin')] : [];
  const agyAcp = join(dataDir, 'bin', 'agy-acp', 'agy_acp_server.par');
  const find = (name: string, extra: string[] = []) => {
    if (!isDefaultEnv) {
      for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
        const candidate = join(dir, name);
        try {
          accessSync(candidate, constants.X_OK);
          return candidate;
        } catch {
          // keep looking
        }
      }
      return null;
    }
    return findBinary(name, env, extra);
  };
  return {
    claude: find('claude', npmGlobal),
    kimi: find('kimi', npmGlobal),
    codex: find('codex', npmGlobal),
    codexAcp: find('codex-acp', npmGlobal),
    agyAcp: existsSync(agyAcp) ? agyAcp : null,
    opencode: find('opencode', opencodeDirs),
    gh: find('gh'),
  };
}

/** Re-detects binaries and updates `config.pools`, `config.gateway.pools`, and `opencode.json` in place. */
export function refreshConfigPools(config: DaemonConfig, env: NodeJS.ProcessEnv = process.env): Pool[] {
  const bins = detectBinaries(config.dataDir, env);
  Object.assign(config.binaries, bins);
  mkdirSync(join(config.dataDir, 'opencode'), { recursive: true });
  writeFileSync(config.opencodeConfigPath, JSON.stringify(opencodeConfig(env, config.gateway.url), null, 2) + '\n');
  const customPools = config.pools.filter((p) => !SYSTEM_POOL_IDS.has(p.id));
  const nextPools = [...customPools, ...poolsFromEnv(env, config.binaries)];
  config.pools.splice(0, config.pools.length, ...nextPools);
  const nextGatewayPools = apiPoolsFromEnv(env);
  config.gateway.pools.splice(0, config.gateway.pools.length, ...nextGatewayPools);
  return config.pools;
}

/** Coding-worker pools available from the environment. Groq is fast-lane only (master plan §5.11), so it is not listed. */
export function poolsFromEnv(env: NodeJS.ProcessEnv, bins: HarnessBinaries = { claude: null, kimi: null, agyAcp: null }): Pool[] {
  const pools: Pool[] = [];
  if (bins.claude) {
    // Sonnet by default: Claude Pro is the scarcest pool (master plan §5.4).
    pools.push({ id: 'claude', label: 'Claude Pro', harness: 'claude', model: env.CLAUDE_MODEL || 'sonnet', kind: 'subscription' });
  }
  if (bins.codexAcp) {
    pools.push({ id: 'codex', label: 'Codex', harness: 'codex', model: env.CODEX_MODEL || 'gpt-6.1-sol', kind: 'subscription' });
  }
  if (bins.kimi) {
    pools.push({ id: 'kimi', label: 'Kimi Plus', harness: 'kimi', model: env.KIMI_MODEL || 'kimi-code/k3.1-pro', kind: 'subscription' });
  }
  if (bins.agyAcp) {
    pools.push({ id: 'agy', label: 'Antigravity Pro', harness: 'agy', model: env.AGY_MODEL || 'gemini-3.8-flash', kind: 'subscription' });
  }
  if (env.NVIDIA_API_KEY && env.NVIDIA_MODEL) {
    pools.push({ id: 'nim', label: 'NVIDIA NIM', harness: 'opencode', model: `nvidia/${env.NVIDIA_MODEL}`, kind: 'api' });
  }
  if (env.LOCAL_LLM_BASE_URL && env.LOCAL_LLM_MODEL) {
    pools.push({ id: 'local', label: 'Local LLM', harness: 'opencode', model: `local/${env.LOCAL_LLM_MODEL}`, kind: 'local' });
  }
  return pools;
}

/** `~` and `~/x` in a path the person typed. */
function expandHome(p: string): string {
  return p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

export function loadConfig(root: string, env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const envFile = join(root, '.env');
  if (env === process.env && existsSync(envFile)) process.loadEnvFile(envFile);
  // Settings under their old names (MH_*) still work. A real start also carries the old state folder over.
  const oldNames = applyLegacyEnv(env);
  if (oldNames.length) console.warn(`settings still use the old names (${oldNames.join(', ')}); they work, but rename them to ${oldNames.map((n) => `IH_${n.slice(3)}`).join(', ')}`);
  const legacy = env === process.env ? migrateLegacyState(root, env) : undefined;
  for (const note of legacy?.notes ?? []) console.log(`upgrade: ${note}`);

  const dataDir = join(root, '.infinity-harness');
  // A separate database and worktrees (e.g. a second instance for a demo); harness state and logins stay shared.
  const stateDir = env.IH_STATE_DIR ? resolve(env.IH_STATE_DIR) : dataDir;
  const host = env.IH_HOST ?? '127.0.0.1';
  const gatewayPort = Number(env.IH_GATEWAY_PORT ?? 7421);
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
  const token = gatewayToken();
  const opencodeConfigPath = join(dataDir, 'opencode', 'opencode.json');
  mkdirSync(join(dataDir, 'opencode'), { recursive: true });
  writeFileSync(opencodeConfigPath, JSON.stringify(opencodeConfig(env, gatewayUrl), null, 2) + '\n');

  const binaries = detectBinaries(dataDir, env);

  return {
    root,
    dataDir,
    dbFile: join(stateDir, 'infinity-harness.db'),
    ...(legacy ? { legacy } : {}),
    worktreesDir: env.IH_WORKTREES_DIR ? resolve(expandHome(env.IH_WORKTREES_DIR)) : join(stateDir, 'worktrees'),
    opencodeConfigPath,
    binaries,
    webDist: join(root, 'apps', 'web', 'dist'),
    host,
    port: Number(env.IH_PORT ?? 7420),
    fedPort: env.IH_FED_PORT === 'off' ? null : Number(env.IH_FED_PORT ?? 7422),
    pools: poolsFromEnv(env, binaries),
    agentEnv: agentEnvironment(env, token),
    gateway: { host: '127.0.0.1', port: gatewayPort, url: gatewayUrl, token, pools: apiPoolsFromEnv(env) },
    kev: env.KEV_URL ? { url: env.KEV_URL, apiKey: env.KEV_API_KEY, model: env.KEV_MODEL || 'kev-9b' } : null,
    fastLane: fastLaneChain(env),
    embeddings: env.EMBEDDINGS_BASE_URL
      ? {
          baseUrl: env.EMBEDDINGS_BASE_URL,
          model: env.EMBEDDINGS_MODEL || 'unsloth/embeddinggemma-2-GGUF',
          apiKey: env.EMBEDDINGS_API_KEY || env.KEV_API_KEY || undefined,
          minSimilarity: env.EMBEDDINGS_MIN_SIMILARITY ? Number(env.EMBEDDINGS_MIN_SIMILARITY) : undefined,
        }
      : null,
  };
}
