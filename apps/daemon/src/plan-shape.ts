// The shape of a plan: which cards can run together. A card's wave is one more than the deepest wave among the
// cards it waits for, so cards in one wave can all run at the same time and the number of waves is the critical
// path. Planners are shown this while they build a plan, so a chain of cards that could have run side by side is
// noticed while it is still cheap to fix.

export interface PlanShape {
  cards: number;
  /** Length of the longest chain of waiting cards. */
  waves: number;
  /** The most cards in any one wave: how wide the plan can run. */
  widest: number;
  /** Card ids on one longest chain, first to last. */
  criticalPath: string[];
}

/** Waves of `ids` given "cardId waits for blockedBy" edges. Edges leaving the set are ignored. */
export function planShape(ids: string[], deps: { cardId: string; blockedBy: string }[]): PlanShape {
  const inSet = new Set(ids);
  const waits = new Map<string, string[]>();
  for (const d of deps) {
    if (!inSet.has(d.cardId) || !inSet.has(d.blockedBy)) continue;
    waits.set(d.cardId, [...(waits.get(d.cardId) ?? []), d.blockedBy]);
  }
  const wave = new Map<string, number>();
  const via = new Map<string, string>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    const known = wave.get(id);
    if (known) return known;
    if (visiting.has(id)) return 1; // the store refuses cycles; stay safe anyway
    visiting.add(id);
    let best = 0;
    for (const b of waits.get(id) ?? []) {
      const d = depth(b);
      if (d > best) {
        best = d;
        via.set(id, b);
      }
    }
    visiting.delete(id);
    wave.set(id, best + 1);
    return best + 1;
  };
  for (const id of ids) depth(id);

  const sizes = new Map<number, number>();
  for (const w of wave.values()) sizes.set(w, (sizes.get(w) ?? 0) + 1);
  const waves = Math.max(0, ...wave.values());
  let tail = ids.find((id) => wave.get(id) === waves);
  const criticalPath: string[] = [];
  while (tail) {
    criticalPath.unshift(tail);
    tail = via.get(tail);
  }
  return { cards: ids.length, waves, widest: Math.max(0, ...sizes.values()), criticalPath };
}

/**
 * A nudge for a plan that runs in more waves than it needs to, or null. `parallel` is how many cards the board can
 * run at once: with one lane nothing can run side by side, so a chain costs nothing extra.
 */
export function planHint(shape: PlanShape, parallel: number, title: (id: string) => string): string | null {
  if (parallel < 2 || shape.cards < 4) return null;
  // A plan that fits the board's width would finish in about cards/parallel waves; allow some slack for real dependencies.
  const wanted = Math.max(3, Math.ceil(shape.cards / Math.min(parallel, shape.cards)) + 1);
  if (shape.waves <= wanted) return null;
  const chain = shape.criticalPath.map((id) => `"${title(id)}"`).join(' → ');
  return (
    `This plan has ${shape.cards} cards but runs in ${shape.waves} waves one after another (widest wave: ${shape.widest}), while ${parallel} agents could work at once. ` +
    `The longest chain is ${chain}. For each link ask: does the later card need the earlier one's code or output, or only its topic? ` +
    'If it only touches different files or can code against an interface you write down (put_artifact, kind contract), drop the dependency, or fold a thin foundation into one first card so the rest can start together.'
  );
}
