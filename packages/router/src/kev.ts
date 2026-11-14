import { WORK_TYPES, type Classification, type WorkType } from '@ih/core';

type Json = any;

export interface KevOptions {
  /** Full URL of the Decision API, e.g. http://host:8888/v1/systemone */
  url: string;
  apiKey?: string;
  model: string;
  /** Kev answers in ~1 s warm but ~13 s cold (model load). */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export type KevQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

/** Complexity levels, lowest first; Kev returns an expected index on this 0–4 scale. */
export const COMPLEXITY_LEVELS = [
  'trivial: a one-line or config change',
  'small: one file, obvious approach',
  'moderate: a few files or some design choices',
  'large: cross-cutting, many files, careful testing',
  'very large or risky: architecture, data migrations, security',
];

/** Asked when the orchestrator did not tag the card. Kev is sharper with few options (clarifications Q9). */
const UNTAGGED_CHOICES: Record<string, string> = {
  feature: 'adds new behaviour or capability',
  bugfix: 'fixes behaviour that is wrong today',
  refactor: 'restructures code without changing behaviour',
  docs: 'documentation, tests or other non-functional work only',
};

const WORK_TYPE_HINT: Record<WorkType, string> = {
  feature: 'adding new behaviour or capability',
  bugfix: 'fixing behaviour that is wrong today',
  refactor: 'restructuring code without changing behaviour',
  test: 'writing or fixing tests',
  docs: 'writing documentation',
  research: 'investigating and reporting, without shipping code',
};

/** Levels for scoring landed work, worst first; the expected index is scaled to 0–1. */
export const OUTCOME_LEVELS = [
  'does not do the task',
  'partly done: major pieces missing or wrong',
  'mostly done: minor gaps',
  'fully meets the task and its acceptance criteria',
];

/** Levels for scoring a council member's proposed split of a goal, worst first. */
export const PROPOSAL_LEVELS = [
  'leaves major parts of the goal uncovered, or shares overlap heavily',
  'covers most of the goal; some gaps or overlapping shares',
  'covers the goal with little overlap between shares',
  "covers the goal completely, with clean boundaries between shares that play to each member's team",
];

export interface OutcomeForKev {
  title: string;
  description: string;
  /** Trimmed diff of the landed change (stat and hunks). */
  diff: string;
  /** The agent's own summary of its work. */
  summary?: string;
}

export interface CardForKev {
  title: string;
  description: string;
  /** The orchestrator's tag, confirmed with a yes/no question instead of a multi-way choice. */
  workType?: WorkType | null;
  parentTitle?: string | null;
  /** Agent notes on the board (lower-cased): Kev says how much the card needs each (Phase 9). */
  notes?: string[];
}

/** Defaults when Kev is unreachable: the card still routes, on a middling estimate. */
export function fallbackClassification(card: CardForKev): Classification {
  return {
    workType: card.workType ?? 'feature',
    workTypeProbs: {},
    complexity: 2,
    complexityProbs: {},
    needsReview: 0.5,
    source: 'fallback',
    at: new Date().toISOString(),
  };
}

/** Client for the self-hosted Kev judge (Unsloth Studio Decision API, master plan §3). */
export class KevClient {
  private opts: KevOptions;
  private fetch: typeof fetch;

  constructor(opts: KevOptions) {
    this.opts = opts;
    this.fetch = opts.fetch ?? fetch;
  }

  /** Asks several questions about one state in a single call; returns Kev's raw answers by question name. */
  async decide(state: unknown, questions: Record<string, KevQuestion>): Promise<Record<string, Json>> {
    const res = await this.fetch(this.opts.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.opts.model, state, questions }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
    if (!res.ok) throw new Error(`kev ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as Json;
    if (!body?.answers) throw new Error('kev: response has no answers');
    return body.answers;
  }

  /** Keeps the model loaded so routing calls stay ~1 s (clarifications Q9). */
  async warm(): Promise<boolean> {
    try {
      await this.decide('ping', { ok: { type: 'noul', instructions: 'Is this a ping?' } });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * How well landed work meets its card (master plan §5.4 step 7): a 0–1 quality score against the acceptance
   * criteria, and the probability that the change stayed in scope. One call.
   */
  async scoreOutcome(input: OutcomeForKev): Promise<{ quality: number; inScope: number }> {
    const state = {
      card: `${input.title}\n\n${input.description}`.trim().slice(0, 4000),
      ...(input.summary ? { agent_summary: input.summary.slice(0, 1500) } : {}),
      change: input.diff.slice(0, 9000),
    };
    const a = await this.decide(state, {
      quality: { type: 'score', instructions: "How well does the change meet the card's task and acceptance criteria?", criteria: OUTCOME_LEVELS },
      in_scope: { type: 'noul', instructions: 'Does the change stay within what the card asked for, without unrelated edits?' },
    });
    const score = Number(a.quality?.score);
    return {
      quality: Number.isFinite(score) ? Math.round(Math.min(1, Math.max(0, score / (OUTCOME_LEVELS.length - 1))) * 1000) / 1000 : 0.75,
      inScope: Number(a.in_scope?.noul ?? 0.5),
    };
  }

  /**
   * Council planning: scores each member's proposed split of a goal (0–1), in one call. The best one is used.
   * Kev answers choices best with few options, so every proposal gets its own score question instead.
   */
  async scoreProposals(goal: string, members: string, proposals: { id: string; text: string }[]): Promise<Record<string, number>> {
    const state: Record<string, string> = { goal: goal.slice(0, 3000), council_members: members.slice(0, 2000) };
    const questions: Record<string, KevQuestion> = {};
    proposals.forEach((p, i) => {
      state[`proposal_${i + 1}`] = p.text.slice(0, Math.max(1500, Math.floor(9000 / proposals.length)));
      questions[`p${i + 1}`] = { type: 'score', instructions: `How good is proposal_${i + 1} as a split of the goal between the council members?`, criteria: PROPOSAL_LEVELS };
    });
    const a = await this.decide(state, questions);
    return Object.fromEntries(
      proposals.map((p, i) => {
        const score = Number(a[`p${i + 1}`]?.score);
        return [p.id, Number.isFinite(score) ? Math.round((score / (PROPOSAL_LEVELS.length - 1)) * 1000) / 1000 : 0];
      }),
    );
  }

  /** Work type, complexity and review need for a card (master plan §5.4 step 2). */
  async classify(card: CardForKev): Promise<Classification> {
    const state = {
      card: `${card.title}\n\n${card.description}`.trim().slice(0, 6000),
      ...(card.parentTitle ? { parent: card.parentTitle } : {}),
    };
    const questions: Record<string, KevQuestion> = {
      complexity: { type: 'score', instructions: 'How much work is this card for a capable coding agent?', criteria: COMPLEXITY_LEVELS },
      needs_review: { type: 'noul', instructions: "Is a mistake here risky enough to need a second agent's review?" },
      frontend: { type: 'noul', instructions: 'Is this mainly web front-end work (UI, pages, HTML/CSS, browser JavaScript)?' },
    };
    if (card.workType) {
      questions.work_type = { type: 'noul', instructions: `Is this card mainly ${WORK_TYPE_HINT[card.workType]}?` };
    } else {
      questions.work_type = { type: 'choice', instructions: 'What kind of work is this card?', criteria: UNTAGGED_CHOICES };
    }
    const notes = (card.notes ?? []).slice(0, 6);
    notes.forEach((n, i) => {
      questions[`note_${i}`] = { type: 'noul', instructions: `Does this card need someone who is strong at: ${n}?` };
    });
    const a = await this.decide(state, questions);

    let workType: WorkType;
    let workTypeProbs: Record<string, number>;
    if (card.workType) {
      const p = Number(a.work_type?.noul ?? 0.5);
      workTypeProbs = { [card.workType]: p };
      workType = card.workType;
    } else {
      workTypeProbs = Object.fromEntries(Object.entries(a.work_type?.probabilities ?? {}).map(([k, v]) => [k, Number(v)]));
      const pick = String(a.work_type?.choice ?? 'feature');
      workType = (WORK_TYPES as readonly string[]).includes(pick) ? (pick as WorkType) : 'feature';
    }
    return {
      workType,
      workTypeProbs,
      complexity: Number(a.complexity?.score ?? 2),
      complexityProbs: Object.fromEntries(Object.entries(a.complexity?.probabilities ?? {}).map(([k, v]) => [k, Number(v)])),
      needsReview: Number(a.needs_review?.noul ?? 0.5),
      frontend: Number(a.frontend?.noul ?? 0),
      ...(notes.length ? { noteProbs: Object.fromEntries(notes.map((n, i) => [n, Number(a[`note_${i}`]?.noul ?? 0)])) } : {}),
      source: 'kev',
      at: new Date().toISOString(),
    };
  }
}
