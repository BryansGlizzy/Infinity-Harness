// The real terminal: alternate screen, raw keys, mouse reporting. Everything it turns on is turned off again on exit,
// on a crash and on a signal, because a terminal left reporting the mouse prints garbage for every movement.
import type { InputEvent } from './input.ts';
import { InputParser } from './input.ts';

export const ENTER_ALT = '\x1b[?1049h';
export const LEAVE_ALT = '\x1b[?1049l';
export const HIDE_CURSOR = '\x1b[?25l';
export const SHOW_CURSOR = '\x1b[?25h';
export const MOUSE_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
export const MOUSE_OFF = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';

/** What the app needs from a terminal; tests supply their own. */
export interface TermIo {
  write(data: string): void;
  size(): { width: number; height: number };
  onInput(fn: (e: InputEvent) => void): void;
  onResize(fn: () => void): void;
  enter(): void;
  leave(): void;
  /** Hand the terminal to something else (an attached agent session) and take it back. */
  suspend(): void;
  resume(): void;
  readonly color: boolean;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

export class RealTerminal implements TermIo {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  readonly color: boolean;
  private mouse: boolean;
  private parser = new InputParser();
  private input: ((e: InputEvent) => void) | null = null;
  private active = false;
  private onData = (chunk: Buffer) => {
    for (const e of this.parser.push(chunk.toString('utf8'))) this.input?.(e);
  };
  private cleanup = () => this.leave();

  constructor(opts: { stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream; mouse?: boolean; env?: NodeJS.ProcessEnv } = {}) {
    this.stdin = opts.stdin ?? process.stdin;
    this.stdout = opts.stdout ?? process.stdout;
    this.mouse = opts.mouse ?? true;
    this.color = !(opts.env ?? process.env).NO_COLOR;
  }

  write(data: string) {
    this.stdout.write(data);
  }
  size() {
    return { width: this.stdout.columns || 80, height: this.stdout.rows || 24 };
  }
  onInput(fn: (e: InputEvent) => void) {
    this.input = fn;
  }
  onResize(fn: () => void) {
    this.stdout.on('resize', fn);
  }

  enter() {
    if (this.active) return;
    this.active = true;
    if (this.stdin.isTTY) this.stdin.setRawMode(true);
    this.stdin.resume();
    this.stdin.on('data', this.onData);
    this.write(ENTER_ALT + HIDE_CURSOR + (this.mouse ? MOUSE_ON : ''));
    process.on('exit', this.cleanup);
    for (const sig of ['SIGTERM', 'SIGHUP'] as const) process.once(sig, () => (this.leave(), process.exit(1)));
    process.once('uncaughtException', (err) => {
      this.leave();
      console.error(err);
      process.exit(1);
    });
  }

  leave() {
    if (!this.active) return;
    this.active = false;
    this.stdin.off('data', this.onData);
    this.write((this.mouse ? MOUSE_OFF : '') + SHOW_CURSOR + LEAVE_ALT);
    if (this.stdin.isTTY) this.stdin.setRawMode(false);
    this.stdin.pause();
  }

  suspend() {
    this.stdin.off('data', this.onData);
    this.write((this.mouse ? MOUSE_OFF : '') + SHOW_CURSOR + LEAVE_ALT);
  }

  resume() {
    this.stdin.on('data', this.onData);
    this.write(ENTER_ALT + HIDE_CURSOR + (this.mouse ? MOUSE_ON : ''));
  }
}
