export const COMPLEXITY_LABEL = ['trivial', 'small', 'moderate', 'large', 'very large'];

/** Kev's expected complexity (0–4) as a word. */
export function complexityLabel(c: number): string {
  return COMPLEXITY_LABEL[Math.min(4, Math.max(0, Math.round(c)))]!;
}
