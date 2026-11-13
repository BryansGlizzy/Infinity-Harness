import { resolve } from 'node:path';
import type { HarnessEvent, ModelOption, ReasoningOptions } from '@ih/core';
import { AcpConnection } from './acp.ts';
import { inShared, isInside, rootsFor, writableDirsFor } from './environment.ts';
import type { AgentSession, HarnessAdapter, PermissionDecision, SessionOptions, UsageReport } from './types.ts';

type Json = any;

const FLUSH_MS = 1000;

/**
 * Token usage in a `session/prompt` result, when the harness reports it. ACP's usage block (camelCase) is still
 * settling, so snake_case, `_meta.usage` and the usual cache field names are read too. Null when there is none.
 */
export function usageFrom(result: Json): UsageReport | null {
  const u = result?.usage ?? result?._meta?.usage;
  if (!u || typeof u !== 'object') return null;
  const n = (...keys: string[]) => {
    for (const k of keys) if (Number.isFinite(Number(u[k])) && u[k] !== null && u[k] !== '') return Number(u[k]);
    return 0;
  };
  const inputTokens = n('inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens');
  const outputTokens = n('outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens');
  const cacheTokens = n('cachedReadTokens', 'cached_read_tokens', 'cacheReadTokens', 'cache_read_tokens', 'cachedInputTokens') + n('cachedWriteTokens', 'cached_write_tokens');
  if (!inputTokens && !outputTokens) return null;
  const costUsd = Number(u.costUsd ?? u.cost_usd ?? u.cost?.amount);
  return { inputTokens, outputTokens, ...(cacheTokens ? { cacheTokens } : {}), ...(Number.isFinite(costUsd) && costUsd > 0 ? { costUsd } : {}) };
}

const PATH_KEYS = ['path', 'file_path', 'filePath', 'filename', 'Path', 'TargetFile', 'AbsolutePath'];

/** System locations shell commands may name without leaving the worktree in any meaningful way. */
const SHELL_SAFE_PREFIXES = ['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/tty', '/usr/', '/bin/', '/sbin/', '/opt/homebrew/', '/System/', '/Library/Developer/'];

/**
 * Path-like words in a shell command (absolute, `~`, `./`, `../`, including redirection targets and
 * `--flag=/path` values), resolved against the session cwd. Plain words like `src/a.ts` stay inside cwd anyway.
 */
export function shellPaths(command: string, cwd: string): string[] {
  const home = process.env.HOME ?? '~';
  const words = command
    .replace(/["'`]/g, ' ')
    .split(/[\s;|&()<>]+/)
    .map((w) => w.replace(/^\d*>+/, ''))
    .map((w) => (w.includes('=') && !w.startsWith('/') ? w.slice(w.indexOf('=') + 1) : w))
    .filter(Boolean);
  const paths: string[] = [];
  for (const w of words) {
    if (w.includes('://')) continue;
    if (!/^(\/|~|\.\.?(\/|$))/.test(w)) continue;
    const abs = w.startsWith('~') ? home + w.slice(1) : resolve(cwd, w);
    if (SHELL_SAFE_PREFIXES.some((p) => abs === p || abs.startsWith(p))) continue;
    paths.push(abs);
  }
  return paths;
}

/** The command line of a shell tool call, from whichever field the agent puts it in. */
export function shellCommand(toolCall: Json): string | null {
  const raw = toolCall?.rawInput ?? {};
  for (const key of ['command', 'CommandLine', 'cmd']) if (typeof raw[key] === 'string') return raw[key];
  for (const c of toolCall?.content ?? []) {
    const m = /Running:\s*(.+)$/s.exec(c?.type === 'content' ? String(c.content?.text ?? '') : '');
    if (m) return m[1]!;
  }
  // OpenCode titles shell calls with the command itself.
  return toolCall?.kind === 'execute' && typeof toolCall?.title === 'string' ? toolCall.title : null;
}

function isShell(toolCall: Json): boolean {
  return toolCall?.kind === 'execute' || /^(bash|shell|run_command)$/i.test(String(toolCall?.title ?? ''));
}

/**
 * Every path a permission request names. Agents report them differently: ACP `locations` (OpenCode, agy),
 * diff content entries (agy), raw tool input, or only prose such as "Requesting approval to Writing /abs/path" (Kimi).
 * Shell commands are judged by their working directory instead, since their text names binaries as well as files.
 */
export function permissionPaths(toolCall: Json): string[] {
  const paths = new Set<string>();
  for (const l of toolCall?.locations ?? []) if (l?.path) paths.add(String(l.path));
  for (const c of toolCall?.content ?? []) if (c?.type === 'diff' && c.path) paths.add(String(c.path));
  const raw = toolCall?.rawInput;
  if (raw && typeof raw === 'object') {
    for (const key of PATH_KEYS) if (typeof raw[key] === 'string') paths.add(raw[key]);
    if (isShell(toolCall)) for (const key of ['cwd', 'Cwd']) if (typeof raw[key] === 'string') paths.add(raw[key]);
  }
  if (!isShell(toolCall)) {
    for (const c of toolCall?.content ?? []) {
      const text = c?.type === 'content' ? String(c.content?.text ?? '') : '';
      for (const m of text.matchAll(/(?:^|[\s"'`(])(\/[^\s"'`)]+)/g)) paths.add(m[1]!.replace(/[.,;:]+$/, ''));
    }
  }
  return [...paths];
}

/**
 * Auto-approve policy: allow tool use unless it names a path outside the session's worktree and outside every shared
 * root (scratch space, toolchains, the repo's git dir, the harness's own state; see environment.ts). Under a root that
 * contains the worktree, the folder holding it stays refused, so sibling worktrees and the main checkout do too.
 */
export function decidePermission(toolCall: Json, cwd: string, roots: string[] = []): PermissionDecision {
  const paths = permissionPaths(toolCall);
  if (isShell(toolCall)) {
    const command = shellCommand(toolCall);
    if (command) paths.push(...shellPaths(command, cwd));
  }
  const shared = rootsFor(cwd, roots);
  let outside = false;
  for (const p of paths) {
    const abs = resolve(cwd, p);
    if (isInside(abs, cwd)) continue;
    if (inShared(abs, shared)) {
      outside = true;
      continue;
    }
    return { allow: false, reason: `path outside worktree: ${p}` };
  }
  if (outside) return { allow: true, reason: 'paths inside worktree or shared tool locations' };
  return { allow: true, reason: paths.length ? 'all paths inside worktree' : 'no paths named' };
}

function pickOption(options: Json[], allow: boolean): string | undefined {
  const order = allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  for (const kind of order) {
    const match = options.find((o) => o.kind === kind);
    if (match) return match.optionId;
  }
  return undefined;
}

function contentText(content: Json): string {
  if (!content) return '';
  if (content.type === 'text') return String(content.text ?? '');
  return '';
}

const MAX_OUTPUT = 8000;

/** Normalizes line endings and keeps the head and tail of very long output, so one noisy build cannot flood the log. */
export function clipOutput(text: string): string {
  const s = text.replace(/\r\n?/g, '\n');
  if (s.length <= MAX_OUTPUT) return s;
  const half = MAX_OUTPUT / 2;
  return `${s.slice(0, half)}\n… (${s.length - MAX_OUTPUT} characters omitted) …\n${s.slice(-half)}`;
}

/**
 * What a tool call printed, from whichever shape the harness uses:
 *  - Codex streams `_meta.terminal_output_delta` while the command runs, and `_meta.terminal_exit` at the end;
 *  - Kimi puts the whole output in `rawOutput` (a string) and in `content` text when the call completes;
 *  - Agy's `rawOutput` is an object (`combinedOutput`, `exitCode`) at completion.
 * Input (`rawInput`, and Kimi's in-progress `content`, which is the arguments as JSON) is never output.
 */
export function toolOutput(update: Json): { text: string; exitCode?: number } | null {
  const meta: Json = update?._meta ?? {};
  const delta = meta.terminal_output_delta;
  if (delta && typeof delta.data === 'string' && delta.data) return { text: String(delta.data).replace(/\r\n?/g, '\n') };
  if (update?.status !== 'completed' && update?.status !== 'failed') return null;
  const raw = update.rawOutput;
  let text = '';
  let exitCode: number | undefined;
  if (typeof raw === 'string') text = raw;
  else if (raw && typeof raw === 'object') {
    text = String(raw.combinedOutput ?? raw.formatted_output ?? raw.output ?? raw.stdout ?? raw.stderr ?? '');
    const code = raw.exitCode ?? raw.exit_code ?? raw.metadata?.exit; // OpenCode keeps it in metadata
    if (typeof code === 'number') exitCode = code;
  }
  if (!text) {
    text = (update.content ?? [])
      .filter((c: Json) => c?.type === 'content' && c.content?.type === 'text')
      .map((c: Json) => String(c.content.text ?? ''))
      .join('\n');
  }
  const code = meta.terminal_exit?.exit_code;
  if (exitCode === undefined && typeof code === 'number') exitCode = code;
  if (!text.trim() && exitCode === undefined) return null;
  return { text: clipOutput(text), ...(exitCode !== undefined ? { exitCode } : {}) };
}

/** Maps one ACP `session/update` payload to a normalized event. Text chunks are returned separately so they can be merged. */
export function mapUpdate(update: Json): { event?: HarnessEvent; chunk?: { kind: 'message' | 'thought'; text: string }; output?: Extract<HarnessEvent, { type: 'tool_output' }> } {
  switch (update?.sessionUpdate) {
    case 'agent_message_chunk':
      return { chunk: { kind: 'message', text: contentText(update.content) } };
    case 'agent_thought_chunk':
      return { chunk: { kind: 'thought', text: contentText(update.content) } };
    case 'tool_call':
      return {
        event: {
          type: 'tool_call',
          id: String(update.toolCallId),
          title: String(update.title ?? ''),
          kind: String(update.kind ?? 'other'),
          status: String(update.status ?? 'pending'),
          locations: (update.locations ?? []).map((l: Json) => String(l.path)),
        },
      };
    case 'tool_call_update': {
      const locations: string[] = (update.locations ?? []).map((l: Json) => String(l.path));
      const printed = toolOutput(update);
      const output = printed ? { output: { type: 'tool_output' as const, id: String(update.toolCallId), ...printed } } : {};
      if (!update.status && !update.title && !locations.length) return output;
      return {
        ...output,
        event: {
          type: 'tool_update',
          id: String(update.toolCallId),
          status: String(update.status ?? 'in_progress'),
          ...(update.title ? { title: String(update.title) } : {}),
          ...(locations.length ? { locations } : {}),
        },
      };
    }
    case 'session_info_update': {
      // OpenCode retries a failing provider by itself and only says so here; without this the card just looks stuck.
      const retry = update._meta?.['opencode/retry'];
      if (!retry) return {};
      const why = retry.error?.message ? String(retry.error.message) : 'provider error';
      const status = retry.error?.status ? ` (${retry.error.status})` : '';
      return { event: { type: 'notice', text: `Provider problem, retrying (attempt ${retry.attempt ?? '?'}): ${why}${status}` } };
    }
    case 'plan':
      return {
        event: {
          type: 'plan',
          entries: (update.entries ?? []).map((e: Json) => ({ content: String(e.content), status: String(e.status) })),
        },
      };
    default:
      return {};
  }
}

/**
 * Some harnesses (Kimi) repeat `tool_call_update … in_progress` several times a second while a command runs, with
 * nothing new in it. One card produced 9,000 such events: each is a database row, a broadcast and a re-render in every
 * open client. True when `event` just repeats the last update seen for the same tool (`seen` remembers them).
 */
export function isRepeatedToolUpdate(seen: Map<string, string>, event: HarnessEvent): boolean {
  if (event.type !== 'tool_call' && event.type !== 'tool_update') return false;
  const sig = JSON.stringify([event.status, event.title ?? null, event.locations ?? null]);
  if (event.type === 'tool_update' && seen.get(event.id) === sig) return true;
  seen.set(event.id, sig);
  return false;
}

interface LiveSession {
  opts: SessionOptions;
  /** Last update seen per tool call, to drop pure repeats. */
  tools: Map<string, string>;
  text: { kind: 'message' | 'thought'; value: string } | null;
  timer: NodeJS.Timeout | null;
}

export interface AcpAgentConfig {
  id: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Working directory for the agent process itself; sessions carry their own cwd. */
  cwd: string;
  /** ACP auth method to select after initialize, e.g. agy's `oauth-personal` (reuses the CLI login). */
  authMethod?: string;
  strayPaths?: string[];
  /** The harness's own state outside the worktree that its tools read (e.g. agy's per-conversation MCP tool files). */
  internalRoots?: string[];
  /**
   * Send the session's shared roots as ACP `additionalDirectories`. Codex's sandbox makes everything but the cwd and
   * /tmp read-only; this is how its commits (the repo's git dir) and tool caches (`~/.platformio`) become writable.
   */
  additionalDirectories?: boolean;
}

/** A harness driven over ACP. One agent process serves many concurrent sessions. */
/** ACP config option ids harnesses use for reasoning, when they don't tag it with the `thought_level` category. */
const REASONING_IDS = ['thinking', 'thinking_level', 'thought_level', 'effort', 'reasoning', 'reasoning_effort'];

/** The reasoning (thinking / effort) select among a session's config options, if it has one. */
export function reasoningFrom(options: Json[]): ReasoningOptions | null {
  const o = options.find((x: Json) => x?.category === 'thought_level') ?? options.find((x: Json) => REASONING_IDS.includes(String(x?.id)));
  if (!o || !Array.isArray(o.options)) return null;
  return {
    configId: String(o.id),
    levels: o.options.map((v: Json) => ({ id: String(v.value), name: String(v.name ?? v.value) })),
    ...(o.currentValue != null ? { current: String(o.currentValue) } : {}),
  };
}

export class AcpAgent implements HarnessAdapter {
  readonly id: string;
  readonly strayPaths?: string[];
  private conn: AcpConnection | null = null;
  private ready: Promise<AcpConnection> | null = null;
  private sessions = new Map<string, LiveSession>();
  private config: AcpAgentConfig;
  /** What the agent said it can do at `initialize` (`loadSession` is what makes resuming possible). */
  private capabilities: Json = {};

  constructor(config: AcpAgentConfig) {
    this.config = config;
    this.id = config.id;
    this.strayPaths = config.strayPaths;
  }

  private connect(): Promise<AcpConnection> {
    if (this.ready) return this.ready;
    const conn = new AcpConnection(this.config.command, this.config.args, { cwd: this.config.cwd, env: this.config.env });
    conn.onNotification((method, params) => {
      if (method === 'session/update') this.onUpdate(params);
    });
    conn.handle('session/request_permission', (params) => this.onPermission(params));
    void conn.exited.then(() => {
      for (const [id, s] of this.sessions) {
        this.flush(s);
        s.opts.onEvent({ type: 'error', message: `agent process exited: ${conn.stderr().slice(-300)}` });
        this.sessions.delete(id);
      }
      if (this.conn === conn) {
        this.conn = null;
        this.ready = null;
      }
    });
    this.conn = conn;
    this.ready = conn
      .request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      })
      .then(async (init) => {
        this.capabilities = init?.agentCapabilities ?? {};
        if (this.config.authMethod) await conn.request('authenticate', { methodId: this.config.authMethod });
        return conn;
      })
      .catch((err) => {
        this.ready = null;
        conn.close();
        throw err;
      });
    return this.ready;
  }

  /** Opens a throwaway session and returns every config option it publishes (model, reasoning level, mode, …). */
  async configOptions(cwd: string): Promise<Json[]> {
    const conn = await this.connect();
    const created = await conn.request('session/new', { cwd, mcpServers: [] });
    conn.request('session/close', { sessionId: String(created.sessionId) }).catch(() => {});
    return created.configOptions ?? [];
  }

  /** Models and the reasoning option, from one throwaway session. */
  async probe(cwd: string): Promise<{ models: ModelOption[]; reasoning: ReasoningOptions | null }> {
    const options = await this.configOptions(cwd);
    const model = options.find((o: Json) => o.id === 'model');
    return {
      models: (model?.options ?? []).map((o: Json) => ({ id: String(o.value), name: String(o.name ?? o.value) })),
      reasoning: reasoningFrom(options),
    };
  }

  /** The session's `model` config option (ACP has no separate model listing). */
  async listModels(cwd: string): Promise<ModelOption[]> {
    const modelOption = (await this.configOptions(cwd)).find((o: Json) => o.id === 'model');
    return (modelOption?.options ?? []).map((o: Json) => ({ id: String(o.value), name: String(o.name ?? o.value) }));
  }

  async startSession(opts: SessionOptions): Promise<AgentSession> {
    const conn = await this.connect();
    const extraDirs = this.config.additionalDirectories ? writableDirsFor(opts.cwd, opts.sharedRoots ?? []) : [];
    const dirs = extraDirs.length ? { additionalDirectories: extraDirs } : {};
    // Picking up an earlier conversation: the agent replays its history as updates while it loads; the session is not
    // registered yet, so those replays are dropped instead of being logged a second time.
    let created: Json | null = null;
    let sessionId = '';
    let resumed = false;
    if (opts.resume && this.capabilities.loadSession) {
      try {
        created = (await conn.request('session/load', { sessionId: opts.resume, cwd: opts.cwd, mcpServers: opts.mcpServers ?? [], ...dirs })) ?? {};
        sessionId = opts.resume;
        resumed = true;
      } catch (err) {
        opts.onEvent({ type: 'error', message: `could not pick up the earlier ${this.id} session (${(err as Error).message}); starting a new one` });
      }
    }
    if (!created) {
      created = await conn.request('session/new', { cwd: opts.cwd, mcpServers: opts.mcpServers ?? [], ...dirs });
      sessionId = String(created.sessionId);
    }
    if (opts.model && !(resumed && !created.configOptions)) {
      const modelOption = (created.configOptions ?? []).find((o: Json) => o.id === 'model');
      const values: string[] = (modelOption?.options ?? []).map((o: Json) => o.value);
      if (!values.includes(opts.model)) {
        throw new Error(`model ${opts.model} not offered by ${this.id}; available: ${values.join(', ')}`);
      }
      const set = await conn.request('session/set_config_option', { sessionId, configId: 'model', value: opts.model });
      // A model change may change the other options (e.g. which effort levels exist); use the new list when sent.
      if (Array.isArray(set?.configOptions)) created.configOptions = set.configOptions;
    }
    if (opts.reasoning && !(resumed && !created.configOptions)) {
      const r = reasoningFrom(created.configOptions ?? []);
      if (!r) opts.onEvent({ type: 'error', message: `${this.id} publishes no reasoning setting; "${opts.reasoning}" ignored` });
      else if (!r.levels.some((l) => l.id === opts.reasoning)) {
        opts.onEvent({ type: 'error', message: `reasoning level "${opts.reasoning}" is not offered here (${r.levels.map((l) => l.id).join(', ')}); using ${r.current ?? 'the default'}` });
      } else {
        await conn.request('session/set_config_option', { sessionId, configId: r.configId, value: opts.reasoning });
      }
    }
    const live: LiveSession = { opts, tools: new Map(), text: null, timer: null };
    this.sessions.set(sessionId, live);

    return {
      vendorSessionId: sessionId,
      resumed,
      prompt: async (text: string) => {
        try {
          const result = await conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
          this.flush(live);
          const usage = usageFrom(result);
          if (usage) opts.onUsage?.(usage);
          const stopReason = String(result?.stopReason ?? 'end_turn');
          opts.onEvent({ type: 'turn_end', stopReason });
          return stopReason;
        } catch (err) {
          this.flush(live);
          opts.onEvent({ type: 'error', message: (err as Error).message });
          throw err;
        }
      },
      cancel: async () => {
        conn.notify('session/cancel', { sessionId });
      },
      close: () => {
        this.flush(live);
        this.sessions.delete(sessionId);
        conn.request('session/close', { sessionId }).catch(() => {});
      },
    };
  }

  shutdown() {
    this.conn?.close();
  }

  private onUpdate(params: Json) {
    const live = this.sessions.get(String(params?.sessionId));
    if (!live) return;
    const { event, chunk, output } = mapUpdate(params.update);
    if (output) {
      this.flush(live);
      live.opts.onEvent(output);
    }
    if (chunk) {
      if (live.text && live.text.kind !== chunk.kind) this.flush(live);
      live.text = { kind: chunk.kind, value: (live.text?.value ?? '') + chunk.text };
      live.timer ??= setTimeout(() => this.flush(live), FLUSH_MS);
      return;
    }
    if (event) {
      if (isRepeatedToolUpdate(live.tools, event)) return;
      this.flush(live);
      live.opts.onEvent(event);
    }
  }

  private flush(live: LiveSession) {
    if (live.timer) clearTimeout(live.timer);
    live.timer = null;
    const text = live.text;
    live.text = null;
    if (!text || !text.value) return;
    live.opts.onEvent(text.kind === 'message' ? { type: 'message', role: 'agent', text: text.value } : { type: 'thought', text: text.value });
  }

  private onPermission(params: Json) {
    const live = this.sessions.get(String(params?.sessionId));
    const options: Json[] = params?.options ?? [];
    const roots = live ? [...(live.opts.sharedRoots ?? []), ...(this.config.internalRoots ?? [])] : [];
    let decision: PermissionDecision = live ? decidePermission(params.toolCall, live.opts.cwd, roots) : { allow: false, reason: 'unknown session' };
    if (live && decision.allow && live.opts.policy) decision = live.opts.policy(permissionPaths(params.toolCall), params.toolCall) ?? decision;
    const optionId = pickOption(options, decision.allow);
    if (live) {
      this.flush(live);
      live.opts.onEvent({
        type: 'permission',
        title: String(params?.toolCall?.title ?? 'tool'),
        decision: decision.allow && optionId ? 'allowed' : 'rejected',
        reason: decision.reason,
      });
    }
    if (!optionId) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId } };
  }
}
