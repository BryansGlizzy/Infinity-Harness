import { effectiveAgents, type AgentProfile, type Card, type CardRole, type Settings } from '@mh/core';
import type { ActiveSession, PoolWithStatus } from './api.ts';

export const HARNESS_LABEL: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  kimi: 'Kimi Code',
  agy: 'Antigravity',
  opencode: 'OpenCode',
};

export const ROLE_LABEL: Record<CardRole, string> = { orchestrator: 'Orchestrator', lead: 'Lead', worker: 'Worker' };

/** A model id without its provider prefix: `nvidia/nvidia/nemotron-x` → `nemotron-x`. */
export const shortModel = (model: string) => model.split('/').pop() ?? model;

export interface CardAgent {
  agentId: string | null;
  poolId: string;
  poolLabel: string;
  harness: string;
  model: string;
  reasoning: string;
  /** The model and level come from the live session rather than the agent's settings. */
  live: boolean;
}

/**
 * Who works a card, down to the model: the live session when there is one (exact model and reasoning level),
 * otherwise the agent profile that last ran it, otherwise its pool's default model.
 */
export function cardAgent(card: Card, agents: AgentProfile[], pools: PoolWithStatus[], sessions: ActiveSession[]): CardAgent | null {
  const session = sessions.find((s) => s.cardId === card.id && s.kind === 'card');
  const poolId = session?.poolId ?? card.poolId;
  if (!poolId && !card.agentId) return null;
  const profile = agents.find((a) => a.id === card.agentId);
  const pool = pools.find((p) => p.id === (poolId ?? profile?.poolId));
  return {
    agentId: card.agentId,
    poolId: pool?.id ?? poolId ?? '',
    poolLabel: pool?.label ?? poolId ?? '',
    harness: pool?.harness ?? '',
    model: shortModel(session?.model || profile?.model || pool?.model || ''),
    reasoning: session?.reasoning || profile?.reasoning || '',
    live: Boolean(session),
  };
}

export function boardAgents(settings: Settings | null, pools: PoolWithStatus[]): AgentProfile[] {
  return settings ? effectiveAgents(settings, pools) : [];
}

/** A stable colour per agent, for "colour by agent" in the tree. */
export function agentHue(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
