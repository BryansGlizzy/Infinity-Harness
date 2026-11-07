// Fast lane (master plan §5.11): small, latency-sensitive utility jobs on Groq's free tier, with a
// Groq → NIM → local fallback. Requests go through the daemon's gateway, so they are counted and paced.

type Json = any;

export interface LaneModel {
  /** Gateway pool id: groq, nim or local. */
  poolId: string;
  /** Model id as the provider's raw API names it. */
  model: string;
}

export interface FastLaneOptions {
  gatewayUrl: string;
  token: string;
  /** Tried in order; a pool that is warn/halted/locked, or fails, falls through to the next. */
  chain: LaneModel[];
  poolState: (poolId: string) => string;
  /** Jobs running at once; the rest wait, highest priority first. */
  concurrency?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface Job {
  name: string;
  /** 1 is most urgent. */
  priority: number;
  system: string;
  input: string;
  /** Hard cap on input size, applied before sending (≈4 chars per token). */
  maxInputChars: number;
  maxTokens: number;
  json?: boolean;
}

export interface JobResult {
  text: string;
  poolId: string;
  model: string;
}

/** Keeps the start and end of an over-long input, where the useful context usually is. */
export function trimInput(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.4);
  return `${text.slice(0, head)}\n…\n${text.slice(text.length - (max - head - 3))}`;
}

/** Pulls the first JSON object out of model output (which may wrap it in prose or a code fence). */
export function parseJsonObject(text: string): Json | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export class FastLane {
  private opts: FastLaneOptions;
  private fetch: typeof fetch;
  private running = 0;
  private queue: { job: Job; resolve: (r: JobResult | null) => void }[] = [];

  constructor(opts: FastLaneOptions) {
    this.opts = opts;
    this.fetch = opts.fetch ?? fetch;
  }

  get available(): boolean {
    return this.opts.chain.length > 0;
  }

  /** Runs a job on the first usable model; null when every model in the chain is unavailable or failed. */
  run(job: Job): Promise<JobResult | null> {
    return new Promise((resolve) => {
      this.queue.push({ job, resolve });
      this.queue.sort((a, b) => a.job.priority - b.job.priority);
      this.pump();
    });
  }

  private pump() {
    while (this.running < (this.opts.concurrency ?? 2) && this.queue.length) {
      const { job, resolve } = this.queue.shift()!;
      this.running++;
      void this.attempt(job)
        .then(resolve, () => resolve(null))
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }

  private async attempt(job: Job): Promise<JobResult | null> {
    const input = trimInput(job.input, job.maxInputChars);
    for (const { poolId, model } of this.opts.chain) {
      if (this.opts.poolState(poolId) !== 'open') continue;
      try {
        const res = await this.fetch(`${this.opts.gatewayUrl}/p/${poolId}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.token}` },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: job.system },
              { role: 'user', content: input },
            ],
            max_tokens: job.maxTokens,
            temperature: 0.2,
            ...(job.json ? { response_format: { type: 'json_object' } } : {}),
          }),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
        });
        if (!res.ok) continue;
        const body = (await res.json()) as Json;
        const text = String(body?.choices?.[0]?.message?.content ?? '').trim();
        if (text) return { text, poolId, model };
      } catch {
        // fall through to the next model in the chain
      }
    }
    return null;
  }
}

// --- jobs

/** Job #1: one-line "who is doing what" status from a session's recent activity (~600 tokens in). */
export function narratorJob(cardTitle: string, activity: string[]): Job {
  return {
    name: 'narrator',
    priority: 1,
    system:
      'You narrate a coding agent\'s progress for a live dashboard. Reply with ONE short present-tense line (max 90 characters), no quotes, no preamble, e.g. "Adding retry logic to the upload client; tests next".',
    input: `Card: ${cardTitle}\nRecent activity, oldest first:\n${activity.join('\n')}`,
    maxInputChars: 2400,
    maxTokens: 60,
  };
}

export function cleanNarration(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.replace(/^["'`]+|["'`]+$/g, '').slice(0, 120);
}

/** Job #7: are the acceptance criteria present and the scope clear? (~1.5k tokens in) */
export function specLintJob(title: string, description: string): Job {
  return {
    name: 'spec-lint',
    priority: 2,
    system:
      'You check task cards before a coding agent picks them up. A card passes if an agent could start without asking questions: the goal is clear, the scope is bounded, and there are acceptance criteria (explicit or obvious from the text). Be lenient with small, obvious tasks. Reply with JSON only: {"ok": true} or {"ok": false, "problem": "<one sentence on what is missing>"}.',
    input: `Title: ${title}\n\n${description || '(no description)'}`,
    maxInputChars: 6000,
    maxTokens: 120,
    json: true,
  };
}

export function readLint(text: string): { ok: boolean; problem: string } {
  const parsed = parseJsonObject(text);
  if (!parsed || typeof parsed.ok !== 'boolean') return { ok: true, problem: '' }; // fail open
  return { ok: parsed.ok, problem: String(parsed.problem ?? '') };
}

/** Job #5: commit title and PR description from a trimmed diff (stat + hunks, ~4k tokens in). */
export function commitMessageJob(title: string, description: string, diff: string): Job {
  return {
    name: 'commit-message',
    priority: 2,
    system:
      'You write the squash commit and pull request text for a change made by a coding agent. Reply with JSON only: {"title": "<imperative summary, max 72 characters, no trailing period>", "body": "<markdown: 2–5 bullets on what changed and why, then a line on how it was tested if the diff shows tests>"}. Describe only what the diff shows.',
    input: `Card: ${title}\n\n${description || '(no description)'}\n\nDiff:\n${diff}`,
    maxInputChars: 16_000,
    maxTokens: 400,
    json: true,
  };
}

export function readCommitMessage(text: string): { title: string; body: string } | null {
  const parsed = parseJsonObject(text);
  const title = typeof parsed?.title === 'string' ? parsed.title.split('\n')[0]!.trim().slice(0, 100) : '';
  if (!title) return null;
  return { title, body: typeof parsed.body === 'string' ? parsed.body.trim() : '' };
}

/** Job #6: root cause, likely file and flakiness of a failed test run, from its log tail (~3k tokens in). */
export function triageJob(command: string, log: string): Job {
  return {
    name: 'test-triage',
    priority: 2,
    system:
      'You triage a failed test run for the coding agent that has to fix it. Reply with JSON only: {"cause": "<one sentence: the root cause as the log shows it>", "file": "<most likely file to fix, or empty>", "flaky": <true only if the log points to timing, network or ordering rather than the code>}.',
    input: `Command: ${command}\n\nLog (tail):\n${log}`,
    maxInputChars: 12_000,
    maxTokens: 200,
    json: true,
  };
}

export function readTriage(text: string): { cause: string; file: string; flaky: boolean } | null {
  const parsed = parseJsonObject(text);
  if (typeof parsed?.cause !== 'string' || !parsed.cause.trim()) return null;
  return { cause: parsed.cause.trim(), file: typeof parsed.file === 'string' ? parsed.file : '', flaky: parsed.flaky === true };
}

/** Job #3: expand a search query with keywords, and a hypothetical answer to embed (~300 tokens in). */
export function queryRewriteJob(query: string): Job {
  return {
    name: 'query-rewrite',
    priority: 2,
    system:
      'You improve search queries over a software project\'s notes (decisions, interface contracts, handoffs, findings, task specs). Reply with JSON only: {"keywords": ["<3–8 extra search terms: synonyms, likely identifiers, file or module names>"], "hypothetical": "<one or two sentences a matching note might contain>"}.',
    input: `Query: ${query}`,
    maxInputChars: 1200,
    maxTokens: 160,
    json: true,
  };
}

export function readQueryRewrite(text: string): { keywords: string[]; hypothetical: string } | null {
  const parsed = parseJsonObject(text);
  if (!parsed) return null;
  const keywords = Array.isArray(parsed.keywords) ? parsed.keywords.filter((k: unknown): k is string => typeof k === 'string' && !!k.trim()).slice(0, 10) : [];
  const hypothetical = typeof parsed.hypothetical === 'string' ? parsed.hypothetical.trim().slice(0, 600) : '';
  return keywords.length || hypothetical ? { keywords, hypothetical } : null;
}

/** Job #4: tags and a one-line summary for a saved artifact or handoff (~2k tokens in). */
export function taggingJob(kind: string, title: string, body: string): Job {
  return {
    name: 'artifact-tagging',
    priority: 3,
    system:
      'You index notes written by coding agents so other agents can find them. Reply with JSON only: {"tags": ["<3–6 short lowercase tags: topics, modules, file names, technologies>"], "summary": "<one sentence, max 160 characters, saying what the note establishes>"}.',
    input: `Kind: ${kind}\nTitle: ${title}\n\n${body}`,
    maxInputChars: 8000,
    maxTokens: 160,
    json: true,
  };
}

export function readTagging(text: string): { tags: string[]; summary: string } | null {
  const parsed = parseJsonObject(text);
  if (!parsed) return null;
  const tags = Array.isArray(parsed.tags)
    ? [...new Set(parsed.tags.filter((t: unknown): t is string => typeof t === 'string').map((t: string) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 8) as string[]
    : [];
  const summary = typeof parsed.summary === 'string' ? parsed.summary.split('\n')[0]!.trim().slice(0, 200) : '';
  return tags.length || summary ? { tags, summary } : null;
}

/** Job #2: answer a question to a busy agent from its card's notes, instead of interrupting it (~3k tokens in). */
export function quickAnswerJob(question: string, cardTitle: string, notes: string): Job {
  return {
    name: 'quick-answer',
    priority: 1,
    system:
      'Another coding agent asked a question of an agent that is busy. Answer it ONLY from the busy agent\'s notes below (its card, decisions, contracts, handoffs, summaries, recent messages). Be brief and concrete. If the notes do not answer it, reply with exactly UNKNOWN.',
    input: `Question: ${question}\n\nThe busy agent's card: ${cardTitle}\n\nIts notes:\n${notes}`,
    maxInputChars: 12_000,
    maxTokens: 300,
  };
}

/** The quick answer, or null when the notes didn't answer it. */
export function readQuickAnswer(text: string): string | null {
  const t = text.trim();
  return !t || /^UNKNOWN\b/i.test(t) ? null : t;
}

/**
 * Job #8 (Phase 6.4): notification text for a human who must decide something (an escalation, an agent asking for a new
 * agent, an MCP server, a skill or a tool grant). Two plain sentences: what is asked, and what approving does.
 */
export function notificationJob(kind: string, facts: string[]): Job {
  return {
    name: 'notification',
    priority: 3,
    system:
      'You write a short notification for a developer who must approve or answer something on their coding-agent dashboard. Reply with ONE or TWO plain sentences (max 220 characters): what is being asked and by whom, then what approving would do. No greeting, no markdown, no quotes.',
    input: `Kind: ${kind}\n${facts.join('\n')}`,
    maxInputChars: 2000,
    maxTokens: 120,
  };
}

/** The notification text, or null when the model gave nothing usable. */
export function readNotification(text: string): string | null {
  const line = text.replace(/```[a-z]*\n?|```/g, '').replace(/^["'\s]+|["'\s]+$/g, '').replace(/\s+/g, ' ');
  return line.length >= 8 ? line.slice(0, 280) : null;
}
