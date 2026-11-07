import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HarnessEvent, ModelOption, ReasoningOptions } from '@mh/core';
import { decidePermission, shellPaths } from './acp-agent.ts';
import { Pty } from './pty.ts';
import type { AgentSession, HarnessAdapter, PermissionDecision, SessionOptions } from './types.ts';

type Json = any;

const HOOK_SCRIPT = fileURLToPath(new URL('./claude-hook.mjs', import.meta.url));
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'] as const;
const READY_TIMEOUT_MS = 60_000;
const CANCEL_GRACE_MS = 3_000;
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** Claude's 5-hour / weekly subscription usage, from the status line. */
export interface ClaudeRateLimits {
  fiveHour?: { usedPct: number; resetsAt: number };
  sevenDay?: { usedPct: number; resetsAt: number };
}

export interface ClaudeOptions {
  binary?: string;
  env: NodeJS.ProcessEnv;
  /** Where per-session settings and MCP config files are written. */
  stateDir: string;
  /** Daemon endpoint the hook script posts to. */
  hookUrl: string;
  onRateLimits?: (limits: ClaudeRateLimits) => void;
}

/**
 * Claude Code has no model listing; `--model` takes these aliases for the latest of each family (or a full model
 * name). Which ones a plan includes shows only when a session starts.
 */
/** `claude --effort <level>` (Claude Code 2.1.317). */
export const CLAUDE_EFFORT: ModelOption[] = ['low', 'medium', 'high', 'xhigh', 'max'].map((id) => ({ id, name: id }));

export const CLAUDE_MODELS: ModelOption[] = [
  { id: 'fable', name: 'Fable (latest)' },
  { id: 'opus', name: 'Opus (latest)' },
  { id: 'sonnet', name: 'Sonnet (latest)' },
  { id: 'haiku', name: 'Haiku (latest)' },
];

/**
 * Environment that makes Claude Code export OpenTelemetry metrics (token and cost counters) to the daemon's OTLP/HTTP
 * receiver. Deltas, so each export is new usage; the resource attributes name the session the numbers belong to.
 */
export function claudeTelemetryEnv(t: { endpoint: string; attributes: Record<string, string> }): NodeJS.ProcessEnv {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'none',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: t.endpoint,
    OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'delta',
    OTEL_METRIC_EXPORT_INTERVAL: '15000',
    OTEL_RESOURCE_ATTRIBUTES: Object.entries(t.attributes)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join(','),
  };
}

const PATH_KEYS = ['file_path', 'path', 'notebook_path'];

/** Paths a Claude tool call touches. Bash is judged by its working directory, like the ACP harnesses. */
export function claudeToolPaths(payload: Json): string[] {
  const input = payload?.tool_input ?? {};
  const paths = PATH_KEYS.map((k) => input[k]).filter((v): v is string => typeof v === 'string');
  if (payload?.tool_name === 'Bash' && typeof payload.cwd === 'string') {
    paths.push(payload.cwd);
    if (typeof input.command === 'string') paths.push(...shellPaths(input.command, payload.cwd));
  }
  return paths;
}

/**
 * Claude Code's own files for this session, outside the worktree: it saves large tool output under
 * `~/.claude/projects/<cwd>/<session>/tool-results/` and reads it back with Read. The hook payload names the
 * transcript (`<session>.jsonl`); its sibling folder holds those files.
 */
export function claudeSessionDirs(payload: Json): string[] {
  const transcript = typeof payload?.transcript_path === 'string' ? payload.transcript_path : '';
  return transcript.endsWith('.jsonl') ? [transcript.slice(0, -'.jsonl'.length)] : [];
}

function describeTool(payload: Json): string {
  const input = payload?.tool_input ?? {};
  const detail = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.description ?? '';
  return `${payload?.tool_name ?? 'tool'}${detail ? ` ${String(detail).slice(0, 160)}` : ''}`;
}

/** Strips terminal escape sequences so dialog text can be matched. */
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\s+/g, ' ');

interface ClaudeSessionState {
  opts: SessionOptions;
  pty: Pty;
  claudeSessionId: string | null;
  ready: () => void;
  turn: { resolve: (stopReason: string) => void; cancelTimer: NodeJS.Timeout | null } | null;
}

/**
 * The command line for a board worker: only the daemon's MCP servers and hooks plus the repo's own settings (the
 * person's global ones belong to their interactive use). `resume` picks an earlier conversation up again.
 */
export function claudeArgs(a: { settingsFile: string; mcpFile: string; model?: string; reasoning?: string; resume?: string }): string[] {
  const args = ['--settings', a.settingsFile, '--mcp-config', a.mcpFile, '--strict-mcp-config', '--setting-sources', 'project,local'];
  if (a.model) args.push('--model', a.model);
  if (a.reasoning && CLAUDE_EFFORT.some((l) => l.id === a.reasoning)) args.push('--effort', a.reasoning);
  if (a.resume) args.push('--resume', a.resume);
  return args;
}

/**
 * Claude Code as an interactive TUI in a pseudo-terminal, so all native features stay available and the
 * terminal can be attached from the UI. Prompts are typed in (bracketed paste); hooks report tool use and
 * turn ends, and PreToolUse decides every tool call with the worktree + lease policy. Billing is the user's
 * logged-in subscription (interactive usage).
 */
export class ClaudeAdapter implements HarnessAdapter {
  readonly id = 'claude';
  private sessions = new Map<string, ClaudeSessionState>();
  private opts: ClaudeOptions;

  constructor(opts: ClaudeOptions) {
    this.opts = opts;
  }

  async listModels(): Promise<ModelOption[]> {
    return CLAUDE_MODELS;
  }

  /** Claude Code has no listing API: its `--effort` levels are the ones `claude --help` names. */
  async probe(): Promise<{ models: ModelOption[]; reasoning: ReasoningOptions }> {
    return { models: CLAUDE_MODELS, reasoning: { configId: 'effort', levels: CLAUDE_EFFORT } };
  }

  async startSession(opts: SessionOptions): Promise<AgentSession> {
    if (opts.resume) {
      try {
        return await this.launch(opts, opts.resume);
      } catch (err) {
        opts.onEvent({ type: 'error', message: `could not pick up the earlier claude conversation (${(err as Error).message.split('\n')[0]!.slice(0, 160)}); starting a new one` });
      }
    }
    return this.launch(opts, undefined);
  }

  private async launch(opts: SessionOptions, resumeId: string | undefined): Promise<AgentSession> {
    const token = randomBytes(18).toString('hex');
    const dir = join(this.opts.stateDir, token);
    mkdirSync(dir, { recursive: true });

    const hook = (mode: string) => `"${process.execPath}" "${HOOK_SCRIPT}" ${mode}`;
    const settings = {
      hooks: Object.fromEntries(
        HOOK_EVENTS.map((event) => [event, [{ ...(event.endsWith('ToolUse') ? { matcher: '*' } : {}), hooks: [{ type: 'command', command: hook('hook') }] }]]),
      ),
      statusLine: { type: 'command', command: hook('status') },
    };
    const mcpServers: Record<string, unknown> = {};
    for (const server of opts.mcpServers ?? []) {
      if ('type' in server && server.type === 'http') {
        mcpServers[server.name] = { type: 'http', url: server.url, headers: Object.fromEntries(server.headers.map((h) => [h.name, h.value])) };
      } else if ('command' in server) {
        mcpServers[server.name] = { command: server.command, args: server.args, env: Object.fromEntries(server.env.map((e) => [e.name, e.value])) };
      }
    }
    const settingsFile = join(dir, 'settings.json');
    const mcpFile = join(dir, 'mcp.json');
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
    writeFileSync(mcpFile, JSON.stringify({ mcpServers }, null, 2));

    // Only the daemon's MCP servers and the repo's own settings: the user's global MCP servers, hooks and
    // status line belong to their interactive use, not to board workers.
    const args = claudeArgs({ settingsFile, mcpFile, model: opts.model, reasoning: opts.reasoning, resume: resumeId });
    if (opts.reasoning && !CLAUDE_EFFORT.some((l) => l.id === opts.reasoning)) {
      opts.onEvent({ type: 'error', message: `reasoning level "${opts.reasoning}" is not a Claude effort level (${CLAUDE_EFFORT.map((l) => l.id).join(', ')}); using the default` });
    }
    const pty = new Pty(this.opts.binary ?? join(homedir(), '.local', 'bin', 'claude'), args, {
      cwd: opts.cwd,
      env: { ...this.opts.env, ...(opts.telemetry ? claudeTelemetryEnv(opts.telemetry) : {}), MH_HOOK_URL: this.opts.hookUrl, MH_HOOK_TOKEN: token },
    });

    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => (markReady = resolve));
    const state: ClaudeSessionState = { opts, pty, claudeSessionId: null, ready: markReady, turn: null };
    this.sessions.set(token, state);

    // New worktrees show a trust dialog whose default is "No, exit": move to "Yes" before confirming.
    let trustAnswered = false;
    const offTrust = pty.onData(() => {
      if (trustAnswered) return;
      if (/Yes, ?I ?trust ?this ?folder/i.test(plain(pty.history().slice(-4000)))) {
        trustAnswered = true;
        setTimeout(() => {
          pty.write('\x1b[B');
          setTimeout(() => pty.write('\r'), 150);
        }, 300);
      }
    });
    void pty.exited.then((code) => {
      this.finishTurn(state, 'error');
      if (this.sessions.has(token)) opts.onEvent({ type: 'error', message: `claude exited (${code})` });
      this.sessions.delete(token);
    });

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`claude did not start within ${READY_TIMEOUT_MS / 1000}s:\n${plain(pty.history()).slice(-400)}`)), READY_TIMEOUT_MS).unref(),
    );
    try {
      await Promise.race([ready, timeout, pty.exited.then(() => Promise.reject(new Error(`claude exited during startup: ${plain(pty.history()).slice(-400)}`)))]);
    } catch (err) {
      pty.kill();
      this.sessions.delete(token);
      throw err;
    } finally {
      offTrust();
    }

    return {
      vendorSessionId: state.claudeSessionId ?? token,
      resumed: resumeId !== undefined,
      pty,
      prompt: (text: string) =>
        new Promise<string>((resolve) => {
          state.turn = { resolve, cancelTimer: null };
          pty.write(PASTE_START + text + PASTE_END);
          setTimeout(() => pty.write('\r'), 200);
        }),
      cancel: async () => {
        if (!state.turn) return;
        pty.write('\x1b');
        // An interrupted turn may not fire Stop; give it a moment, then report it as cancelled.
        state.turn.cancelTimer ??= setTimeout(() => this.finishTurn(state, 'cancelled'), CANCEL_GRACE_MS);
      },
      close: () => {
        this.sessions.delete(token);
        pty.kill();
      },
    };
  }

  private finishTurn(state: ClaudeSessionState, stopReason: string) {
    const turn = state.turn;
    if (!turn) return;
    state.turn = null;
    if (turn.cancelTimer) clearTimeout(turn.cancelTimer);
    state.opts.onEvent({ type: 'turn_end', stopReason });
    turn.resolve(stopReason);
  }

  private decide(state: ClaudeSessionState, payload: Json): PermissionDecision {
    const paths = claudeToolPaths(payload);
    const roots = [...(state.opts.sharedRoots ?? []), ...claudeSessionDirs(payload)];
    const decision = decidePermission({ locations: paths.map((path) => ({ path })) }, state.opts.cwd, roots);
    if (!decision.allow || !state.opts.policy) return decision;
    return state.opts.policy(paths, payload) ?? decision;
  }

  /** Handles one hook or status-line call from the hook script; returns what the script prints to Claude. */
  handleHook(token: string, mode: string, payload: Json): string | null {
    const state = this.sessions.get(token);
    if (!state) return null;
    const emit = (e: HarnessEvent) => state.opts.onEvent(e);

    if (mode === 'status') {
      const rl = payload?.rate_limits;
      if (rl && this.opts.onRateLimits) {
        const win = (w: Json) => (w ? { usedPct: Number(w.used_percentage), resetsAt: Number(w.resets_at) * 1000 } : undefined);
        this.opts.onRateLimits({ fiveHour: win(rl.five_hour), sevenDay: win(rl.seven_day) });
      }
      const pct = rl?.five_hour ? ` · 5h ${rl.five_hour.used_percentage}%` : '';
      return `meta-harness${pct}`;
    }

    switch (payload?.hook_event_name) {
      case 'SessionStart':
        state.claudeSessionId = String(payload.session_id ?? '') || null;
        state.ready();
        return '';
      case 'PreToolUse': {
        const id = String(payload.tool_use_id ?? '');
        const title = describeTool(payload);
        emit({ type: 'tool_call', id, title, kind: String(payload.tool_name ?? 'other'), status: 'pending', locations: claudeToolPaths(payload) });
        const decision = this.decide(state, payload);
        emit({ type: 'permission', title, decision: decision.allow ? 'allowed' : 'rejected', reason: decision.reason });
        if (!decision.allow) emit({ type: 'tool_update', id, status: 'failed' });
        return JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: decision.allow ? 'allow' : 'deny',
            permissionDecisionReason: decision.reason,
          },
        });
      }
      case 'PostToolUse':
        emit({ type: 'tool_update', id: String(payload.tool_use_id ?? ''), status: 'completed' });
        return '';
      case 'Stop':
        if (payload.last_assistant_message) emit({ type: 'message', role: 'agent', text: String(payload.last_assistant_message) });
        this.finishTurn(state, state.turn?.cancelTimer ? 'cancelled' : 'end_turn');
        return '';
      default:
        return '';
    }
  }

  shutdown() {
    for (const state of this.sessions.values()) state.pty.kill();
    this.sessions.clear();
  }
}
