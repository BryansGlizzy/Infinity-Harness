// Turns the bytes a terminal sends into keys and mouse events. Mouse reports use the SGR form (`ESC [ < b ; x ; y M|m`),
// which has no coordinate limit; coordinates here are 0-based.

export interface KeyEvent {
  type: 'key';
  /** `enter`, `esc`, `tab`, `backtab`, `backspace`, `delete`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`, or the character. */
  name: string;
  ctrl?: boolean;
  alt?: boolean;
  /** The text typed, for printable keys. */
  text?: string;
}
export interface MouseEvent {
  type: 'mouse';
  action: 'down' | 'up' | 'drag' | 'wheel';
  button: 'left' | 'middle' | 'right' | 'none';
  /** For `wheel`. */
  dir?: 'up' | 'down';
  x: number;
  y: number;
}
export type InputEvent = KeyEvent | MouseEvent;

const CSI_KEYS: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', Z: 'backtab' };
const TILDE_KEYS: Record<string, string> = { '1': 'home', '3': 'delete', '4': 'end', '5': 'pageup', '6': 'pagedown', '7': 'home', '8': 'end' };

export class InputParser {
  private pending = '';

  push(chunk: string): InputEvent[] {
    const data = this.pending + chunk;
    this.pending = '';
    const events: InputEvent[] = [];
    let i = 0;
    while (i < data.length) {
      const ch = data[i]!;
      if (ch === '\x1b') {
        if (i + 1 >= data.length) {
          events.push({ type: 'key', name: 'esc' });
          i++;
        } else if (data[i + 1] === '[') {
          let j = i + 2;
          while (j < data.length && !/[\x40-\x7e]/.test(data[j]!)) j++;
          if (j >= data.length) {
            this.pending = data.slice(i); // a sequence split across chunks
            break;
          }
          const body = data.slice(i + 2, j);
          const final = data[j]!;
          i = j + 1;
          if (body.startsWith('<') && (final === 'M' || final === 'm')) {
            const m = /^<(\d+);(\d+);(\d+)$/.exec(body);
            if (m) events.push(mouse(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1, final === 'M'));
          } else if (final === '~') {
            const name = TILDE_KEYS[body.split(';')[0]!];
            if (name) events.push({ type: 'key', name });
          } else if (CSI_KEYS[final]) {
            events.push({ type: 'key', name: CSI_KEYS[final]!, ...(body.includes(';5') ? { ctrl: true } : {}) });
          }
        } else if (data[i + 1] === 'O' && i + 2 < data.length) {
          const name = CSI_KEYS[data[i + 2]!];
          if (name) events.push({ type: 'key', name });
          i += 3;
        } else {
          // Alt + key.
          const next = [...data.slice(i + 1)][0]!;
          events.push({ type: 'key', name: next, alt: true, text: next });
          i += 1 + next.length;
        }
        continue;
      }
      const cp = [...data.slice(i)][0]!;
      i += cp.length;
      if (cp === '\r' || cp === '\n') events.push({ type: 'key', name: 'enter' });
      else if (cp === '\t') events.push({ type: 'key', name: 'tab' });
      else if (cp === '\x7f' || cp === '\b') events.push({ type: 'key', name: 'backspace' });
      else if (cp.charCodeAt(0) < 32) events.push({ type: 'key', name: String.fromCharCode(cp.charCodeAt(0) + 96), ctrl: true });
      else events.push({ type: 'key', name: cp, text: cp });
    }
    return events;
  }
}

function mouse(code: number, x: number, y: number, pressed: boolean): MouseEvent {
  if (code & 64) return { type: 'mouse', action: 'wheel', button: 'none', dir: (code & 1) === 0 ? 'up' : 'down', x, y };
  const button = (['left', 'middle', 'right', 'none'] as const)[code & 3]!;
  if (code & 32) return { type: 'mouse', action: 'drag', button, x, y };
  return { type: 'mouse', action: pressed ? 'down' : 'up', button, x, y };
}
