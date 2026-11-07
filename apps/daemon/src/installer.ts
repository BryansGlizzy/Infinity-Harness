import { execFile } from 'node:child_process';
import { findBinary } from './config.ts';
import type { ToolInstaller } from './approvals.ts';

const TIMEOUT_MS = 15 * 60_000;

/** Runs a grant's install command through `sh -c` with the daemon's environment, keeping the last of its output. */
export function shellInstaller(env: NodeJS.ProcessEnv): ToolInstaller {
  return {
    isInstalled: (command) => !!findBinary(command, env),
    run: (command) =>
      new Promise((resolve) => {
        execFile('sh', ['-c', command], { env, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
          const output = `${stdout}${stderr}`.slice(-4000);
          const killed = !!err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
          resolve({ ok: !err, output: killed ? `${output}\n(stopped after ${TIMEOUT_MS / 60_000} minutes)` : output });
        });
      }),
  };
}
