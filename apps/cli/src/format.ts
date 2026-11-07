/** Aligned columns, two spaces apart. Cells are cut to `max` characters. */
export function table(rows: string[][], header?: string[], max = 60): string {
  const all = header ? [header, ...rows] : rows;
  if (!all.length) return '';
  const cut = (s: string) => (s.length > max ? `${s.slice(0, max - 1)}…` : s).replace(/\s+/g, ' ');
  const cells = all.map((r) => r.map(cut));
  const widths = cells[0]!.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? '').length)));
  return cells.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join('  ').trimEnd()).join('\n') + '\n';
}

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129_600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

export const pct = (n: number) => `${Math.round(n)}%`;
