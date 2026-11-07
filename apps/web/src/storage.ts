/** Per-viewer conveniences (chosen board, view, theme, tree layout). Storage can be unavailable; never rely on it. */
export function saved(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // per-viewer convenience only
  }
}
