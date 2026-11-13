// The text side of @swarm/project completion, free of React so it can be tested on its own.
import type { Mention } from '@ih/core';

/** The `@word` being typed right before the caret, if any: where it starts and what has been typed after the @. */
export function mentionAt(value: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)@([A-Za-z0-9._/-]*)$/.exec(value.slice(0, caret));
  return m ? { start: caret - m[2]!.length - 1, query: m[2]! } : null;
}

/** Candidates for what has been typed: names that start with it first, then ones that contain it anywhere. */
export function matchMentions(all: Mention[], query: string): Mention[] {
  const q = query.toLowerCase();
  const key = (m: Mention) => `${m.token}\n${m.swarm}\n${m.project}`.toLowerCase();
  const starts = all.filter((m) => m.token.toLowerCase().startsWith(`@${q}`));
  const contains = all.filter((m) => !starts.includes(m) && key(m).includes(q));
  return [...starts, ...contains].slice(0, 8);
}
