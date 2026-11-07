// A grid of styled cells the views draw on. Every clickable thing is registered as a region while it is drawn, so
// what the person sees and what a click lands on can never disagree (Ink and similar libraries do not expose where
// they put a box, which is why this is not built on one).

export type Color = 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'gray' | 'white';
export interface Style {
  bold?: boolean;
  dim?: boolean;
  inverse?: boolean;
  underline?: boolean;
  fg?: Color;
}

interface Cell {
  ch: string;
  style: Style | undefined;
}

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
  /** What a click on it does (interpreted by the app). */
  id: string;
}

const FG: Record<Color, number> = { red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90, white: 37 };

function sgr(style: Style | undefined, color: boolean): string {
  if (!style) return '';
  const codes: number[] = [];
  if (style.bold) codes.push(1);
  if (style.dim) codes.push(2);
  if (style.underline) codes.push(4);
  if (style.inverse) codes.push(7);
  if (style.fg && color) codes.push(FG[style.fg]);
  return codes.length ? `\x1b[${codes.join(';')}m` : '';
}

/** Shortens `text` to `width` characters, ending in an ellipsis when it was cut. */
export function fit(text: string, width: number): string {
  const flat = text.replace(/\s+/g, ' ');
  if (width <= 0) return '';
  return flat.length <= width ? flat : width === 1 ? '…' : `${flat.slice(0, width - 1)}…`;
}

/** Splits text into lines of at most `width` characters, breaking at spaces where it can. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    let line = raw;
    if (!line) out.push('');
    while (line.length > width) {
      let cut = line.lastIndexOf(' ', width);
      if (cut <= 0) cut = width;
      out.push(line.slice(0, cut));
      line = line.slice(cut).trimStart();
    }
    if (line) out.push(line);
  }
  return out;
}

export class Canvas {
  readonly width: number;
  readonly height: number;
  readonly regions: Region[] = [];
  private cells: Cell[][];

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.cells = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ ch: ' ', style: undefined })));
  }

  /** Writes text at (x, y), clipped to the canvas. Returns the width written. */
  put(x: number, y: number, text: string, style?: Style): number {
    if (y < 0 || y >= this.height) return 0;
    let written = 0;
    for (const ch of text) {
      const cx = x + written;
      written++;
      if (cx < 0 || cx >= this.width) continue;
      this.cells[y]![cx] = { ch, style };
    }
    return written;
  }

  fill(x: number, y: number, w: number, h: number, style?: Style, ch = ' ') {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.put(x + i, y + j, ch, style);
  }

  region(x: number, y: number, w: number, h: number, id: string) {
    this.regions.push({ x, y, w, h, id });
  }

  /** A clickable label. Returns the width used, so buttons can be laid out left to right. */
  button(x: number, y: number, label: string, id: string, style?: Style): number {
    const text = ` ${label} `;
    this.put(x, y, text, { inverse: true, ...style });
    this.region(x, y, text.length, 1, id);
    return text.length;
  }

  /** Greys out a rectangle (cached state from a machine that is not connected right now). */
  dim(x: number, y: number, w: number, h: number) {
    for (let j = y; j < y + h && j < this.height; j++) {
      for (let i = x; i < x + w && i < this.width; i++) {
        const cell = this.cells[j]![i]!;
        this.cells[j]![i] = { ch: cell.ch, style: { ...cell.style, dim: true, inverse: false } };
      }
    }
  }

  /** The region under a point; later-drawn regions (a dialog over a list) win. */
  hit(x: number, y: number): Region | undefined {
    for (let i = this.regions.length - 1; i >= 0; i--) {
      const r = this.regions[i]!;
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r;
    }
    return undefined;
  }

  /** A box with a title; clears what is under it. Returns the inner rectangle. */
  box(x: number, y: number, w: number, h: number, title?: string): { x: number; y: number; w: number; h: number } {
    this.fill(x, y, w, h);
    this.put(x, y, '┌' + '─'.repeat(Math.max(0, w - 2)) + '┐');
    for (let j = 1; j < h - 1; j++) {
      this.put(x, y + j, '│');
      this.put(x + w - 1, y + j, '│');
    }
    this.put(x, y + h - 1, '└' + '─'.repeat(Math.max(0, w - 2)) + '┘');
    if (title) this.put(x + 2, y, ` ${fit(title, w - 6)} `, { bold: true });
    return { x: x + 2, y: y + 1, w: w - 4, h: h - 2 };
  }

  /** The text as plain lines (tests, and a screen reader's view). */
  lines(): string[] {
    return this.cells.map((row) => row.map((c) => c.ch).join('').trimEnd());
  }

  /** ANSI for the whole frame; only lines that differ from `previous` are written. */
  toAnsi(previous: Canvas | null, color = true): string {
    let out = '';
    for (let y = 0; y < this.height; y++) {
      const row = this.cells[y]!;
      if (previous && previous.width === this.width && previous.height === this.height) {
        const before = previous.cells[y]!;
        if (row.every((c, i) => c.ch === before[i]!.ch && sgr(c.style, color) === sgr(before[i]!.style, color))) continue;
      }
      let line = '';
      let current = '';
      for (const cell of row) {
        const code = sgr(cell.style, color);
        if (code !== current) {
          line += '\x1b[0m' + code;
          current = code;
        }
        line += cell.ch;
      }
      out += `\x1b[${y + 1};1H${line}\x1b[0m\x1b[K`;
    }
    return out;
  }
}
