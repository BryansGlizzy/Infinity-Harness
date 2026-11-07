import { ruleMatches, type AgentProfile, type CardRole, type Classification, type Pool, type RoutingRules, type Settings, type Skill } from '@mh/core';
import { priorFor, priorSuccess } from './priors.ts';

export * from './priors.ts';

/** What the policy needs to know about an agent's pool right now. */
export interface PoolView {
  pool: Pool;
  /** The agent profile being ranked; without one the pool stands for its own default worker. */
  agent?: AgentProfile;
  state: 'open' | 'warn' | 'halted' | 'locked';
  /** Highest window usage in percent (0–100). */
  topPct: number;
  /** Claude's 5-hour usage in percent, when known (for the orchestrator reserve). */
  fiveHourPct?: number;
  /** Sessions currently working on this pool. */
  running: number;
  /** The agent's spending budget, when it has one (Phase 6.3): halted agents get no cards, warning ones rank lower. */
  budget?: { state: 'open' | 'warn' | 'halted' | 'locked'; pct: number } | null;
}

export interface RouteRequest {
  classification: Classification;
  routing: RoutingRules | null;
  /** Lead cards go only to lead agents, worker cards only to workers (default `worker`). */
  role?: CardRole;
  /** The agent (or pool) that worked the card before, if any; preferred while it has room. */
  preferredPool?: string | null;
  /** Agents that failed this card before (reassign-on-failure); they rank well below the others. */
  failedAgents?: string[];
  pools: PoolView[];
  settings: Settings;
  /** What the agent will do; defaults to the card's work type. Reviews pass `review`. */
  skill?: Skill;
  /**
   * Observed success per agent for this skill near this complexity, keyed by historyKey(pool, model). Blended with
   * the prior, which counts like `PRIOR_WEIGHT` outcomes.
   */
  history?: Record<string, { rate: number; n: number }>;
}

/** Outcomes are a property of the model on its pool, not of the agent's name (which the operator may change). */
export const historyKey = (poolId: string, model: string) => `${poolId}/${model}`;
/** How many outcomes the prior is worth: three outcomes move the estimate halfway to what was observed. */
export const PRIOR_WEIGHT = 3;

export interface Candidate {
  /** The agent profile; equals the pool id for a pool's default worker. */
  agentId: string;
  poolId: string;
  /** The model the agent runs; empty for the pool default. */
  model: string;
  eligible: boolean;
  score: number;
  /** Why the pool is ineligible, or how its score was made up. */
  reasons: string[];
}

/** Pools never given cards above this complexity, whatever the scores say. */
const HARD_CAP: Record<string, number> = { local: 3 };

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Ranks agents for a card (master plan §5.4 steps 3–4). Deterministic: role → rules → capability → free slot →
 * pool state → Claude/Codex reserve; then score = success × headroom × scarcity × load. Slots, state and scarcity belong
 * to the agent's pool, which its agents share. Eligible agents come first.
 */
export function rankPools(req: RouteRequest): Candidate[] {
  const { classification: c, routing, settings } = req;
  const role = req.role ?? 'worker';
  const skill: Skill = req.skill ?? c.workType;
  const out: Candidate[] = req.pools.map(({ pool, agent: profile, state, topPct, fiveHourPct, running, budget }) => {
    const agent = profile ?? { id: pool.id, poolId: pool.id, model: '', role: 'worker', delegatesTo: [], enabled: true };
    const base = { agentId: agent.id, poolId: pool.id, model: agent.model || pool.model };
    const reasons: string[] = [];
    const slots = settings.poolSlots[pool.id] ?? 1;
    if (!agent.enabled) reasons.push('agent disabled');
    if (agent.role !== role) reasons.push(`takes ${agent.role} cards`);
    if (routing?.pools?.length && !routing.pools.some((e) => ruleMatches(e, agent))) reasons.push('not allowed by routing rules');
    if (routing?.avoid?.some((e) => ruleMatches(e, agent))) reasons.push('avoided by routing rules');
    const prior = priorFor(pool.id, base.model, settings.priorOverrides?.[agent.id]);
    if (skill === 'research' && prior.noWeb) reasons.push('no web access for research');
    if (HARD_CAP[pool.id] !== undefined && c.complexity > HARD_CAP[pool.id]!) reasons.push(`complexity ${c.complexity.toFixed(1)} too high`);
    if (running >= slots) reasons.push(`all ${slots} slot(s) busy`);
    if (state === 'halted' || state === 'locked') reasons.push(`pool ${state}`);
    if (budget?.state === 'halted') reasons.push(`budget used up (${budget.pct}%)`);
    // Codex's shell has no network (Phase 6.2): cards that install or download go elsewhere.
    if (routing?.needsNetwork && pool.harness === 'codex') reasons.push("its shell has no network, and the card needs installs or downloads");
    // Subscription pools whose 5-hour usage we can read keep a share of it for the orchestrator.
    const reserve = pool.id === 'claude' ? settings.claudeReservePct : pool.id === 'codex' ? (settings.codexReservePct ?? 30) : 0;
    if (reserve > 0 && (fiveHourPct ?? 0) >= 100 - reserve) {
      reasons.push(`5h at ${fiveHourPct}% (reserve ${reserve}% kept for the orchestrator)`);
    }
    if (reasons.length) return { ...base, eligible: false, score: 0, reasons };

    const expected = priorSuccess(prior, skill, c.complexity, skill === 'review' ? 0 : (c.frontend ?? 0));
    const seen = req.history?.[historyKey(pool.id, base.model)];
    const success = seen && seen.n > 0 ? (seen.rate * seen.n + expected * PRIOR_WEIGHT) / (seen.n + PRIOR_WEIGHT) : expected;
    const headroom = Math.max(0.05, 1 - topPct / 100) * (state === 'warn' ? 0.5 : 1) * (budget?.state === 'warn' ? 0.5 : 1);
    const scarcity = settings.scarcity[pool.id] ?? 1;
    const load = 1 - (running / slots) * 0.5;
    const preferred = req.preferredPool && ruleMatches(req.preferredPool, agent) ? 1.25 : 1;
    const failed = req.failedAgents?.includes(agent.id) ? 0.2 : 1;
    const score = success * headroom * scarcity * load * preferred * failed;
    reasons.push(
      seen && seen.n > 0
        ? `success ${round(success)} (prior ${round(expected)} ${prior.family}, observed ${round(seen.rate)} n=${seen.n})`
        : `success ${round(success)} (prior ${prior.family}, ${skill})`,
      `headroom ${round(headroom)}${state === 'warn' ? ' (warn)' : ''}${budget?.state === 'warn' ? ' (budget warn)' : ''}`,
      `scarcity ${scarcity}`,
      `load ${round(load)}`,
      ...(preferred > 1 ? ['previous agent'] : []),
      ...(failed < 1 ? ['failed this card before'] : []),
    );
    return { ...base, eligible: true, score: round(score), reasons };
  });
  return out.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score);
}
