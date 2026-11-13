import { randomBytes } from 'node:crypto';
import type { PoolLimits, UpstreamPool } from '@ih/gateway';

export interface ApiPool extends UpstreamPool {
  limits: PoolLimits;
}

/** Keys the gateway holds; agents never receive them. */
export const SECRET_ENV = ['NVIDIA_API_KEY', 'GROQ_API_KEY', 'LOCAL_LLM_API_KEY', 'KEV_API_KEY'];

export const gatewayToken = () => randomBytes(24).toString('hex');

const num = (v: string | undefined, fallback: number) => (v && Number.isFinite(Number(v)) ? Number(v) : fallback);

/** API endpoints the gateway fronts, with their limits (master plan §5.10). Limits are per API key. */
export function apiPoolsFromEnv(env: NodeJS.ProcessEnv): ApiPool[] {
  const pools: ApiPool[] = [];
  if (env.NVIDIA_API_KEY) {
    pools.push({
      id: 'nim',
      baseUrl: env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
      apiKey: env.NVIDIA_API_KEY,
      limits: { rpm: num(env.NVIDIA_RPM, 40) },
    });
  }
  if (env.LOCAL_LLM_BASE_URL) {
    pools.push({
      id: 'local',
      baseUrl: env.LOCAL_LLM_BASE_URL,
      apiKey: env.LOCAL_LLM_API_KEY,
      limits: { concurrency: num(env.LOCAL_LLM_CONCURRENCY, 2) },
    });
  }
  if (env.GROQ_API_KEY) {
    pools.push({
      id: 'groq',
      baseUrl: env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
      apiKey: env.GROQ_API_KEY,
      limits: { tpm: num(env.GROQ_TPM, 8000), rpd: num(env.GROQ_RPD, 1000) },
    });
  }
  return pools;
}

/** Claude Code session markers: inherited by a child `claude`, they make it act as a sub-session (e.g. no transcript). */
const KEEP_CLAUDE_VARS = new Set(['CLAUDE_CODE_ENABLE_TELEMETRY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']);
const isClaudeSessionMarker = (key: string) =>
  ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_AGENT_SDK_VERSION'].includes(key) || (key.startsWith('CLAUDE_CODE_') && !KEEP_CLAUDE_VARS.has(key));

/** The environment agent processes get: provider keys and parent-session markers removed, the gateway token added. */
export function agentEnvironment(env: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, IH_GATEWAY_TOKEN: token };
  for (const key of SECRET_ENV) delete out[key];
  for (const key of Object.keys(out)) if (isClaudeSessionMarker(key)) delete out[key];
  return out;
}
