import { spawn } from 'node:child_process';

export interface CodexRateLimits {
  fiveHour?: { usedPct: number; resetsAt: number };
  sevenDay?: { usedPct: number; resetsAt: number };
  planType?: string;
  /** True when the account is out of usage (the limit was reached). */
  reached: boolean;
}

type Json = any;

/** Maps an `account/rateLimits/read` result (what Codex's `/status` shows) to the 5-hour and weekly windows, by their length. */
export function parseCodexRateLimits(result: Json): CodexRateLimits | null {
  const snap = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
  if (!snap) return null;
  const out: CodexRateLimits = { reached: Boolean(snap.rateLimitReachedType), planType: snap.planType ?? undefined };
  for (const w of [snap.primary, snap.secondary]) {
    if (!w || typeof w.usedPercent !== 'number') continue;
    const win = { usedPct: w.usedPercent, resetsAt: Number(w.resetsAt ?? 0) * 1000 };
    // Windows are identified by length, not by position: the weekly one can be the only one reported.
    if ((w.windowDurationMins ?? 0) >= 24 * 60) out.sevenDay = win;
    else out.fiveHour = win;
  }
  return out.fiveHour || out.sevenDay ? out : null;
}

/** Asks `codex app-server` for the account's usage once, then exits it. Resolves null if Codex can't answer in time. */
export function readCodexRateLimits(binary: string, env: NodeJS.ProcessEnv, timeoutMs = 20_000): Promise<CodexRateLimits | null> {
  return new Promise((resolve) => {
    const child = spawn(binary, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], env: env as NodeJS.ProcessEnv });
    let buf = '';
    let done = false;
    const finish = (value: CodexRateLimits | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    child.stdout.on('data', (d) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2) finish(msg.error ? null : parseCodexRateLimits(msg.result));
        } catch {
          // not JSON; ignore
        }
      }
    });
    const send = (o: object) => child.stdin.write(JSON.stringify(o) + '\n');
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'infinity-harness', version: '0' } } });
    send({ method: 'initialized' });
    send({ id: 2, method: 'account/rateLimits/read' });
  });
}
