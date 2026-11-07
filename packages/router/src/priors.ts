import { SKILLS, type PriorOverride, type Skill } from '@mh/core';

/** What routing expects of an agent before it has outcomes: per skill, up to a complexity it handles well. */
export interface Prior {
  /** Which built-in family matched, for the routing explanation (`pool` when none did). */
  family: string;
  /** Highest complexity (0–4) handled well; beyond it expected success drops quickly. */
  capability: number;
  skills: Record<Skill, number>;
  /** Success on web front-end work; blended in by the card's frontend probability. */
  frontend: number;
  /** Runs without web access (direct API models), so research cards never go to it. */
  noWeb: boolean;
}

interface Family {
  name: string;
  /** Tested against `<pool>:<model>`, lower case. */
  match: RegExp;
  capability: number;
  /** Success for skills not listed. */
  base: number;
  skills?: Partial<Record<Skill, number>>;
  frontend?: number;
  noWeb?: boolean;
}

/**
 * Model families, first match wins. The strengths are the operator's (2026-11-04), not benchmarks:
 * - Opus plans and oversees; Sonnet is the strong all-rounder; Haiku researches, plans and summarizes.
 * - Gemini 4 Argon: research, planning, creative. Gemini 3.8 Flash: web UX/front-end code, summaries, design ideas.
 * - Codex (GPT): GPT 6 Astra ~ Opus, GPT 6.1 Sol ~ Sonnet; Terra and 5.6 are a notch lower, Luna is light.
 * - Kimi K3.1 Pro: excellent, cheap coding, slower; good at Q/A, verification and large single projects. Other Kimi
 *   models are for manual, cheaper picks only.
 * - Nemotron (NIM): tool use, code review, scanning files and documents; light code generation.
 * - Local Qwen: slow but free; simple code, reviewing, tool use. GLM on the same server: much stronger at code/review.
 * - NIM and local run as direct API models without a research harness: no web, so no research cards.
 */
const FAMILIES: Family[] = [
  { name: 'opus', match: /^claude:.*opus/, capability: 4, base: 0.9, skills: { research: 0.88, docs: 0.85 }, frontend: 0.85 },
  { name: 'sonnet', match: /^claude:.*sonnet/, capability: 4, base: 0.88, skills: { research: 0.82, docs: 0.85, review: 0.85 }, frontend: 0.85 },
  // Codex / OpenAI (operator's view): GPT 6 Astra ~ Opus, GPT 6.1 Sol ~ Sonnet. Other GPT models are Sonnet-class (Terra/5.6 a notch lower), Luna is light.
  { name: 'gpt-astra', match: /^codex:.*astra/, capability: 4, base: 0.9, skills: { research: 0.86, docs: 0.84 }, frontend: 0.82 },
  { name: 'gpt-mini', match: /^codex:.*(mini|luna)/, capability: 2.5, base: 0.64, skills: { research: 0.7, docs: 0.75, test: 0.68 }, frontend: 0.6 },
  { name: 'gpt-terra', match: /^codex:.*(terra|5\.6)/, capability: 3.5, base: 0.8, skills: { research: 0.78, docs: 0.8, review: 0.82 }, frontend: 0.75 },
  { name: 'gpt', match: /^codex:/, capability: 4, base: 0.87, skills: { research: 0.8, docs: 0.82, review: 0.86, bugfix: 0.88 }, frontend: 0.8 },
  {
    name: 'haiku',
    match: /^claude:.*haiku/,
    capability: 2.5,
    base: 0.62,
    skills: { research: 0.85, docs: 0.85, review: 0.65, test: 0.65, feature: 0.65 },
    frontend: 0.6,
  },
  {
    name: 'gemini-argon',
    match: /^agy:.*argon/,
    capability: 3.5,
    base: 0.72,
    skills: { research: 0.92, docs: 0.8, feature: 0.74, review: 0.72 },
    frontend: 0.78,
  },
  {
    name: 'gemini-flash',
    match: /^agy:.*flash/,
    capability: 3,
    base: 0.7,
    skills: { docs: 0.86, research: 0.8, feature: 0.74, review: 0.7 },
    frontend: 0.9,
  },
  {
    name: 'kimi-k3.1',
    match: /^kimi:.*k3\.1/,
    capability: 4,
    base: 0.88,
    skills: { test: 0.9, review: 0.9, bugfix: 0.89, docs: 0.75, research: 0.7 },
    frontend: 0.8,
  },
  { name: 'kimi-other', match: /^kimi:/, capability: 3, base: 0.66, skills: { research: 0.6 } },
  {
    name: 'nemotron',
    match: /^nim:.*nemotron/,
    capability: 2.5,
    base: 0.6,
    skills: { review: 0.86, docs: 0.72, test: 0.7, refactor: 0.56 },
    frontend: 0.55,
    noWeb: true,
  },
  { name: 'glm', match: /^local:.*glm/, capability: 3.5, base: 0.8, skills: { review: 0.86, docs: 0.7 }, frontend: 0.7, noWeb: true },
  {
    name: 'qwen-local',
    match: /^local:/,
    capability: 2,
    base: 0.6,
    skills: { review: 0.76, test: 0.64, refactor: 0.55 },
    frontend: 0.55,
    noWeb: true,
  },
];

/** Per-pool fallbacks when no family matches the model (e.g. a new pool or model). */
const POOL_DEFAULTS: Record<string, Omit<Family, 'name' | 'match'>> = {
  claude: { capability: 4, base: 0.88 },
  codex: { capability: 3.5, base: 0.82 },
  kimi: { capability: 3.5, base: 0.8 },
  agy: { capability: 3.5, base: 0.78 },
  nim: { capability: 2.5, base: 0.65, noWeb: true },
  local: { capability: 2, base: 0.6, noWeb: true },
};
const DEFAULT: Omit<Family, 'name' | 'match'> = { capability: 2.5, base: 0.7 };

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** The prior for an agent on `poolId` running `model`, with the operator's per-agent override on top. */
export function priorFor(poolId: string, model: string, override?: PriorOverride): Prior {
  const key = `${poolId}:${model}`.toLowerCase();
  const family = FAMILIES.find((f) => f.match.test(key));
  const f = family ?? POOL_DEFAULTS[poolId] ?? DEFAULT;
  const skills = Object.fromEntries(SKILLS.map((s) => [s, f.skills?.[s] ?? f.base])) as Record<Skill, number>;
  for (const [s, v] of Object.entries(override?.skills ?? {})) if (typeof v === 'number' && (SKILLS as readonly string[]).includes(s)) skills[s as Skill] = clamp01(v);
  return {
    family: family?.name ?? 'pool',
    capability: override?.capability ?? f.capability,
    skills,
    frontend: clamp01(override?.frontend ?? f.frontend ?? f.base),
    noWeb: !!f.noWeb,
  };
}

/**
 * Expected success for a card: the skill's prior, blended toward the front-end prior by the card's frontend
 * probability, and lowered by 0.2 per complexity level beyond the agent's capability.
 */
export function priorSuccess(prior: Prior, skill: Skill, complexity: number, frontend = 0): number {
  const f = clamp01(frontend);
  const s = prior.skills[skill] * (1 - f) + prior.frontend * f;
  return Math.max(0.05, s - Math.max(0, complexity - prior.capability) * 0.2);
}
