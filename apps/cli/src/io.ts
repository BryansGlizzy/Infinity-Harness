import type { ConnectionOptions } from '@mh/client/node';

/** Everything the CLI touches outside its arguments, so tests can run it in-process. */
export interface Io {
  out(text: string): void;
  err(text: string): void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Human-readable output when true; JSON otherwise (a pipe, a script, an agent). */
  tty: boolean;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  /** Ends long-running commands (`watch`, `machine forward`). Default: Ctrl+C. */
  signal?: AbortSignal;
  /** Replaces how machine forwards are made (tests). */
  connection?: ConnectionOptions;
}

export function realIo(): Io {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  return {
    out: (t) => void process.stdout.write(t),
    err: (t) => void process.stderr.write(t),
    env: process.env,
    cwd: process.cwd(),
    tty: Boolean(process.stdout.isTTY),
    stdin: process.stdin,
    stdout: process.stdout,
    signal: controller.signal,
  };
}

/** A usage mistake (exit 2), as opposed to a failure talking to the daemon (exit 1). */
export class UsageError extends Error {}
