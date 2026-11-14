import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  mcpLevel,
  mcpToolAllowed,
  mcpToolOffered,
  type Card,
  type McpLevel,
  type McpLibraryEntry,
  type McpRunState,
  type McpServerView,
  type McpToolInfo,
  type Settings,
} from '@ih/core';
import type { Store } from '@ih/db';
import type { McpServerConfig } from '@ih/adapters';
import type { Live } from './live.ts';
import type { RunIdentity, Runner } from './runner.ts';

/** A discovered tool with the server's own definition, which the hub passes on unchanged. */
type HubTool = McpToolInfo & { raw?: Record<string, unknown> };

// The MCP hub (master plan Phase 9). Servers are installed or linked once per machine (the library). The daemon runs
// each shared server once and agents reach it through `/hub/<id>`, authenticated with the session token they already
// hold: the hub lists only the tools that agent may use on this board and refuses the rest, so a server's own address
// and secrets never reach an agent. Per-session servers (a browser per card) are started by the sessions themselves.

interface Running {
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  tools: HubTool[];
  startedAt: string;
}

interface Slot {
  state: McpRunState;
  error: string | null;
  running?: Running;
  starting?: Promise<Running>;
  calls: number;
  log: string[];
  /** Writes to an exclusive server go through this chain, one at a time. */
  writeChain: Promise<unknown>;
  stopping: boolean;
  restarts: number;
  restartTimer?: NodeJS.Timeout;
  /** Calls in a row that failed in a way that means the server cannot reach what it drives. */
  downStreak: number;
  /** While this is in the future, calls are refused at once instead of waiting for another failure. */
  openUntil: number;
  lastDown: string;
}

const LOG_LINES = 40;
const CALL_TIMEOUT_MS = 10 * 60_000;
const MAX_RESTARTS = 5;
/** Failures in a row, and how long calls are then refused at once, before the server is tried again. */
const BREAKER_AFTER = 2;
const BREAKER_MS = 20_000;
/** An error that says the server cannot reach what it drives (Studio gone, plugin not connected, a call that timed out). */
export const looksDown = (text: string): boolean => /not connected|no (studio|place|plugin|peer)|disconnected|connection (closed|refused|reset)|ECONN|timed? ?out|timeout|unreachable|not running/i.test(text);

/**
 * The folder Studio reads local plugins from under Vinegar. That is the one inside the Wine prefix
 * (`prefixes/studio/drive_c/users/<user>/AppData/Local/Roblox/Plugins`, what Studio's own "Plugins Folder" button opens), not
 * Vinegar's `appdata/Roblox/Plugins`, where RbxSync keeps the real file and links to it from the prefix. A plugin written to the
 * appdata folder is never scanned: the first Roblox run on this machine lost a day to exactly that. The appdata folder is only
 * the fallback for a prefix that is not there yet.
 */
export function vinegarPluginsDir(home = homedir()): string | null {
  const roots = [join(home, '.var/app/org.vinegarhq.Vinegar/data/vinegar'), join(home, '.local/share/vinegar')];
  for (const root of roots) {
    const users = join(root, 'prefixes/studio/drive_c/users');
    let names: string[] = [];
    try {
      names = readdirSync(users).filter((n) => n !== 'Public');
    } catch {
      /* no prefix here */
    }
    for (const n of names) {
      const dir = join(users, n, 'AppData/Local/Roblox/Plugins');
      if (existsSync(dir)) return dir;
    }
  }
  return roots.map((r) => join(r, 'appdata/Roblox/Plugins')).find((c) => existsSync(c)) ?? null;
}

/**
 * Servers that ship with the daemon. They can be edited (the saved copy wins) but not removed. Paths depend on where
 * the daemon lives, so they are built here rather than stored.
 */
export function builtinMcp(root: string, home = homedir()): McpLibraryEntry[] {
  const dist = join(root, 'mcp', '_installed', 'node_modules', '@chrrxs', 'robloxstudio-mcp', 'dist', 'index.js');
  const plugins = vinegarPluginsDir(home);
  return [
    {
      id: 'roblox-studio',
      label: 'Roblox Studio',
      description:
        'Edit and inspect a running Roblox Studio place: read and change the DataModel, scripts and properties, run Luau in edit mode or in a live playtest server/client, start and stop playtests, read logs, capture screenshots and profiler data, search Creator Store assets. Studio must be open with the MCP plugin showing Connected. It is one shared place: calls that change it are served one at a time.',
      transport: 'stdio',
      command: 'node',
      args: [dist, '--auto-install-plugin'],
      env: { ...(plugins ? { MCP_PLUGINS_DIR: plugins } : {}) },
      hosting: 'shared',
      exclusive: true,
      version: '3.4.3',
      install: 'npm install --prefix mcp/_installed --ignore-scripts --no-audit --no-fund @chrrxs/robloxstudio-mcp@3.4.3',
      usage:
        'Call get_connected_instances first if more than one place is open. Use canonical DataModel paths the tools return. Pass a unique operation_id to write tools when a retry must be safe. Verify what you changed by reading it back, and say what you saw in your summary.',
      toolKinds: {},
      // The Studio server advertises 50 tools (about 14k tokens on every step). Workers need these; the rest (profilers, monetization,
      // experience settings, asset upload, device simulation, launching Studio) is left out. Settings → MCP lists them all.
      toolAllow: ['get_connected_instances', 'get_place_info', 'get_project_structure', 'search_objects', 'grep_scripts', 'get_instance_properties', 'get_attributes', 'set_properties', 'get_script_source', 'set_script_source', 'edit_script_lines', 'insert_script_lines', 'delete_script_lines', 'find_and_replace_in_scripts', 'execute_luau', 'eval_server_runtime', 'eval_client_runtime', 'selection', 'solo_playtest', 'get_runtime_logs', 'get_simulation_state', 'capture_screenshot', 'simulate_mouse_input', 'simulate_keyboard_input', 'get_request_status', 'get_roblox_docs', 'get_roblox_skills'],
      unavailableHint: 'It looks disconnected from what it drives. Do not investigate the machine (ps, ss, logs and other folders are refused and cost steps). Call addon_status once; if it says Studio is not connected, call ask_parent with what you were doing, then report_blocked.',
      autoStart: true,
      builtin: true,
    },
    {
      id: 'rbxsync',
      label: 'RbxSync',
      description:
        "RbxSync's own tools for the Studio place and this board's folder: extract the open place into files, push file changes to Studio right now, run Luau, run a test, git status and commit. It needs the Roblox add-on's file sync running for the board (the add-on starts it). Scripts stay in step on their own; use these for what the sync does not do by itself.",
      transport: 'stdio',
      command: 'rbxsync-mcp',
      args: [],
      hosting: 'shared',
      exclusive: true,
      version: '1.4.0',
      usage: 'Edit the .luau files; then call sync_to_studio to push them (the sync does not push by itself). Use extract_game once to pull an existing place into files. For everything else (inspecting or changing the live place, running Luau, playtests, logs) use roblox-studio.',
      // RbxSync marks none of its tools read-only, so the ones that plainly only look are listed here (everything else counts as a change).
      toolKinds: Object.fromEntries(
        ['get_attributes', 'get_selection', 'get_tags', 'get_tagged', 'get_class_info', 'get_script_source', 'read_properties', 'search_by_property', 'find_instances', 'explore_hierarchy', 'connection_status', 'git_status', 'diff', 'console_history', 'playtest_status', 'harness_status'].map((t) => [t, 'read' as const]),
      ),
      // The sync does the editing; its tools overlap the Studio server's, which agents are told to prefer. Two are left: the sync does not
      // push on its own (autoSync is off in rbxsync.json), and extracting is how an existing place becomes files.
      toolAllow: ['sync_to_studio', 'extract_game'],
      unavailableHint: 'It looks disconnected from what it drives. Do not investigate the machine (ps, ss, logs and other folders are refused and cost steps). Call addon_status once; if it says Studio is not connected, call ask_parent with what you were doing, then report_blocked.',
      autoStart: false,
      builtin: true,
    },
  ];
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/i;

/** Problems with an entry the operator wants to save, or null. */
export function validateMcpEntry(e: Partial<McpLibraryEntry>): string | null {
  if (!e.id || !ID_PATTERN.test(e.id)) return 'id must be 1 to 40 letters, digits, dots, dashes or underscores';
  if (e.id === 'board') return '"board" is the harness\'s own server';
  if (!e.label?.trim()) return 'a label is required';
  if (e.transport !== 'stdio' && e.transport !== 'http') return 'transport must be stdio or http';
  if (e.transport === 'stdio' && !e.command?.trim()) return 'a stdio server needs a command';
  if (e.transport === 'http') {
    try {
      const u = new URL(e.url ?? '');
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'url must be http or https';
    } catch {
      return 'an http server needs a valid url';
    }
  }
  if (e.hosting !== 'shared' && e.hosting !== 'per-session') return 'hosting must be shared or per-session';
  if (e.hosting === 'per-session' && e.transport !== 'stdio') return 'a per-session server must be stdio (each session starts its own)';
  return null;
}

const fill = (s: string, card: Pick<Card, 'id'>, worktree: string) => s.replaceAll('{card}', card.id).replaceAll('{worktree}', worktree);

export interface McpHubOptions {
  /** The daemon's root folder: relative commands and install text run from here. */
  root: string;
  env: NodeJS.ProcessEnv;
  /** The daemon's port (a function when it is only known after the listener starts). */
  port: number | (() => number);
  live?: Live;
  /** Whether a command exists on this machine (for `installed`). */
  isInstalled?: (command: string) => boolean;
}

export class McpHub {
  private slots = new Map<string, Slot>();
  private stopped = false;
  private store: Store;
  private opts: McpHubOptions;

  constructor(store: Store, opts: McpHubOptions) {
    this.store = store;
    this.opts = opts;
  }

  // --- library

  /** Built-in servers, with the operator's saved copy over each, then the rest of the saved ones. */
  library(): McpLibraryEntry[] {
    const saved = new Map(this.store.listMcpLibrary().map((e) => [e.id, e]));
    // A saved copy of a built-in keeps the operator's edits; fields it never set follow the shipped definition.
    const out: McpLibraryEntry[] = builtinMcp(this.opts.root).map((b) => ({ ...b, ...(saved.get(b.id) ?? {}), builtin: true }));
    for (const e of saved.values()) if (!out.some((o) => o.id === e.id)) out.push(e);
    return out;
  }

  entry(id: string): McpLibraryEntry | undefined {
    return this.library().find((e) => e.id === id);
  }

  save(entry: McpLibraryEntry): McpLibraryEntry {
    const problem = validateMcpEntry(entry);
    if (problem) throw new Error(problem);
    const clean: McpLibraryEntry = {
      id: entry.id,
      label: entry.label.trim(),
      description: (entry.description ?? '').trim(),
      transport: entry.transport,
      ...(entry.command ? { command: entry.command.trim() } : {}),
      ...(entry.args?.length ? { args: entry.args } : {}),
      ...(entry.env && Object.keys(entry.env).length ? { env: entry.env } : {}),
      ...(entry.cwd ? { cwd: entry.cwd } : {}),
      ...(entry.url ? { url: entry.url.trim() } : {}),
      ...(entry.headers && Object.keys(entry.headers).length ? { headers: entry.headers } : {}),
      hosting: entry.hosting,
      exclusive: !!entry.exclusive,
      ...(entry.version ? { version: entry.version } : {}),
      ...(entry.install ? { install: entry.install } : {}),
      ...(entry.usage ? { usage: entry.usage } : {}),
      toolKinds: entry.toolKinds ?? {},
      ...(entry.toolAllow !== undefined ? { toolAllow: entry.toolAllow } : {}),
      ...(entry.unavailableHint ? { unavailableHint: entry.unavailableHint } : {}),
      autoStart: !!entry.autoStart,
      ...(builtinMcp(this.opts.root).some((b) => b.id === entry.id) ? { builtin: true } : {}),
    };
    const had = this.slots.get(clean.id)?.running;
    this.store.saveMcpEntry(clean);
    // A running server keeps its old settings until restarted; say so rather than silently restarting a Studio bridge.
    if (had) this.publish(clean.id);
    return clean;
  }

  async remove(id: string): Promise<boolean> {
    const e = this.entry(id);
    if (!e) return false;
    if (e.builtin && !this.store.getMcpEntry(id)) throw new Error('this server ships with the harness; it can be edited but not removed');
    await this.stop(id);
    this.slots.delete(id);
    // A built-in's saved copy goes (back to the shipped definition); anything else disappears.
    this.store.deleteMcpEntry(id);
    for (const b of this.store.listBoards()) {
      const s = this.store.getSettings(b.id);
      if (s.mcp.enabled.includes(id)) this.store.updateSettings(b.id, { mcp: { ...s.mcp, enabled: s.mcp.enabled.filter((x) => x !== id) } }, 'user:local');
    }
    return true;
  }

  // --- running servers

  private slot(id: string): Slot {
    let s = this.slots.get(id);
    if (!s) {
      s = { state: 'stopped', error: null, calls: 0, log: [], writeChain: Promise.resolve(), stopping: false, restarts: 0, downStreak: 0, openUntil: 0, lastDown: '' };
      this.slots.set(id, s);
    }
    return s;
  }

  private installed(e: McpLibraryEntry): boolean {
    if (e.transport === 'http') return true;
    const first = (e.args ?? []).find((a) => /\.(c|m)?js$/.test(a) && a.includes('/'));
    if (e.command === 'node' && first) return existsSync(first);
    return this.opts.isInstalled ? this.opts.isInstalled(e.command ?? '') : true;
  }

  view(id: string): McpServerView | undefined {
    const entry = this.entry(id);
    if (!entry) return undefined;
    const s = this.slots.get(id);
    return {
      entry,
      state: s?.state ?? 'stopped',
      error: s?.error ?? null,
      tools: (s?.running?.tools ?? []).map(({ raw: _raw, ...t }) => ({ ...t, offered: mcpToolOffered(entry, t) })),
      startedAt: s?.running?.startedAt ?? null,
      calls: s?.calls ?? 0,
      installed: this.installed(entry),
      log: s?.log ?? [],
    };
  }

  list(): McpServerView[] {
    return this.library().map((e) => this.view(e.id)!);
  }

  private publish(id: string) {
    this.opts.live?.publish('mcp.status', id, this.view(id) ?? null);
  }

  /** Starts a shared server (or returns the running one). */
  ensure(id: string): Promise<Running> {
    const slot = this.slot(id);
    if (slot.running) return Promise.resolve(slot.running);
    if (slot.starting) return slot.starting;
    const entry = this.entry(id);
    if (!entry) return Promise.reject(new Error(`no MCP server "${id}" in the library`));
    if (this.stopped) return Promise.reject(new Error('the daemon is shutting down'));
    slot.state = 'starting';
    slot.error = null;
    slot.stopping = false;
    this.publish(id);
    slot.starting = this.connect(entry, slot)
      .then((running) => {
        slot.running = running;
        slot.state = 'running';
        slot.restarts = 0;
        return running;
      })
      .catch((err: Error) => {
        slot.state = 'error';
        slot.error = err.message;
        throw err;
      })
      .finally(() => {
        slot.starting = undefined;
        this.publish(id);
      });
    // Nobody may be listening yet (autostart): a failed start is shown in the view, not thrown at the daemon.
    slot.starting.catch(() => {});
    return slot.starting;
  }

  private async connect(entry: McpLibraryEntry, slot: Slot): Promise<Running> {
    const client = new Client({ name: 'infinity-harness-hub', version: '1' });
    let transport: StdioClientTransport | StreamableHTTPClientTransport;
    if (entry.transport === 'http') {
      transport = new StreamableHTTPClientTransport(new URL(entry.url!), { requestInit: { headers: entry.headers ?? {} } });
    } else {
      const t = new StdioClientTransport({
        command: entry.command!,
        args: entry.args ?? [],
        env: { ...cleanEnv(this.opts.env), ...(entry.env ?? {}) },
        cwd: entry.cwd || this.opts.root,
        stderr: 'pipe',
      });
      t.stderr?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) if (line.trim()) slot.log.push(line.slice(0, 400));
        if (slot.log.length > LOG_LINES) slot.log.splice(0, slot.log.length - LOG_LINES);
      });
      transport = t;
    }
    transport.onclose = () => this.onClosed(entry.id, slot);
    await client.connect(transport);
    const tools = await listAllTools(client);
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      const r = slot.running;
      if (r) {
        r.tools = await listAllTools(r.client).catch(() => r.tools);
        this.publish(entry.id);
      }
    });
    return { client, transport, tools, startedAt: new Date().toISOString() };
  }

  private onClosed(id: string, slot: Slot) {
    if (slot.stopping || this.stopped) return;
    slot.running = undefined;
    slot.state = 'error';
    slot.error = slot.error ?? 'the server stopped';
    this.publish(id);
    // Restart with backoff, a few times; after that it waits for a person (Start).
    if (slot.restarts >= MAX_RESTARTS) return;
    slot.restarts++;
    slot.restartTimer = setTimeout(() => void this.ensure(id).catch(() => {}), Math.min(30_000, 1000 * 2 ** slot.restarts));
    slot.restartTimer.unref?.();
  }

  async stop(id: string): Promise<void> {
    const slot = this.slots.get(id);
    if (!slot) return;
    slot.stopping = true;
    if (slot.restartTimer) clearTimeout(slot.restartTimer);
    const pending = slot.starting;
    if (pending) await pending.catch(() => {});
    const r = slot.running;
    slot.running = undefined;
    slot.state = 'stopped';
    slot.error = null;
    await r?.client.close().catch(() => {});
    this.publish(id);
  }

  async restart(id: string): Promise<McpServerView> {
    await this.stop(id);
    this.slot(id).restarts = 0;
    await this.ensure(id).catch(() => {});
    return this.view(id)!;
  }

  /** Reads the tool list again (after an install, or when the server added tools). */
  async refresh(id: string): Promise<McpServerView> {
    const r = await this.ensure(id);
    r.tools = await listAllTools(r.client);
    this.publish(id);
    return this.view(id)!;
  }

  /** Servers that start with the daemon, so a plugin waiting for one (Studio) can connect before any agent runs. */
  autoStart() {
    for (const e of this.library()) {
      if (e.hosting === 'shared' && e.autoStart && this.installed(e)) void this.ensure(e.id).catch(() => {});
    }
  }

  async close() {
    this.stopped = true;
    await Promise.all([...this.slots.keys()].map((id) => this.stop(id)));
  }

  /** Runs the entry's install command (operator pressed Install), then reads its tools if it is a shared server. */
  install(id: string): Promise<{ ok: boolean; output: string }> {
    const e = this.entry(id);
    if (!e?.install?.trim()) return Promise.resolve({ ok: false, output: 'this server has no install command' });
    return new Promise((resolve) => {
      const child = spawn('sh', ['-c', e.install!], { cwd: this.opts.root, env: this.opts.env });
      let out = '';
      const keep = (d: Buffer) => (out = (out + d.toString()).slice(-4000));
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      const timer = setTimeout(() => child.kill('SIGKILL'), 15 * 60_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        this.publish(id);
        resolve({ ok: code === 0, output: out });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, output: err.message });
      });
    });
  }

  /** One call made by the harness itself (a status probe), not by an agent: no access checks, no call log. */
  async callTool(id: string, name: string, args: Record<string, unknown> = {}, timeoutMs = 8000): Promise<{ ok: boolean; text: string }> {
    try {
      const running = await this.ensure(id);
      const r = (await running.client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs })) as { isError?: boolean; content?: { type: string; text?: string }[] };
      return { ok: !r.isError, text: (r.content ?? []).map((c) => c.text ?? '').join('\n') };
    } catch (err) {
      return { ok: false, text: (err as Error).message };
    }
  }

  // --- what agents get

  /** Servers a card's session is started with: hub entries for shared servers, direct stdio for per-session ones. */
  sessionServers(settings: Settings, card: Pick<Card, 'id' | 'agentId' | 'role'>, worktree: string, token: string): McpServerConfig[] {
    const out: McpServerConfig[] = [];
    for (const e of this.library()) {
      const level = mcpLevel(settings, e.id, card.agentId ?? '', card.role);
      if (level === 'off') continue;
      // A per-session server talks to its session directly, so "read only" cannot be enforced: it is on or off.
      if (e.hosting === 'per-session' && level !== 'full') continue;
      if (e.hosting === 'shared') {
        out.push({ type: 'http', name: e.id, url: `http://127.0.0.1:${typeof this.opts.port === 'function' ? this.opts.port() : this.opts.port}/hub/${encodeURIComponent(e.id)}`, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] });
      } else if (e.transport === 'stdio' && e.command) {
        const env = Object.entries(e.env ?? {}).map(([name, value]) => ({ name, value: fill(value, card, worktree) }));
        out.push({ name: e.id, command: e.command, args: (e.args ?? []).map((a) => fill(a, card, worktree)), env });
      }
    }
    return out;
  }

  /**
   * What a planner and a worker are told about the servers a board has on (Phase 9 §3.4). Given an agent, only what it
   * may use; without one, every enabled server and which agents may use it (for a planner deciding who can do what).
   */
  describe(settings: Settings, forAgent?: { id: string; role: Card['role'] }): string[] {
    const lines: string[] = [];
    const workers = settings.agents.filter((a) => a.enabled && a.role !== 'orchestrator');
    for (const e of this.library()) {
      if (!settings.mcp.enabled.includes(e.id)) continue;
      const names = (this.view(e.id)?.tools ?? []).filter((t) => t.offered !== false).map((t) => t.name);
      if (forAgent) {
        const level = mcpLevel(settings, e.id, forAgent.id, forAgent.role);
        if (level === 'off') continue;
        lines.push(
          `- ${e.id} (${e.label}): ${e.description}${level === 'read' ? ' You may use only its tools that read; the others are refused.' : ''}${e.usage ? ` ${e.usage}` : ''}${names.length ? ` Tools: ${names.slice(0, 40).join(', ')}.` : ''}`,
        );
      } else {
        const allowed = workers
          .map((a) => [a, mcpLevel(settings, e.id, a.id, a.role)] as const)
          .filter(([, l]) => l !== 'off')
          .map(([a, l]) => `${a.id}${l === 'read' ? ' (read only)' : ''}`);
        lines.push(`- ${e.id} (${e.label}): ${e.description} Agents that may use it: ${allowed.length ? allowed.join(', ') : 'none yet'}.${names.length ? ` Tools: ${names.slice(0, 25).join(', ')}.` : ''}`);
      }
    }
    return lines;
  }

  // --- the hub endpoint

  async handle(me: RunIdentity, id: string, req: FastifyRequest, reply: FastifyReply) {
    const entry = this.entry(id);
    if (!entry || entry.hosting !== 'shared') return reply.status(404).send({ error: `no shared MCP server "${id}"` });
    const server = new Server({ name: `ih-hub-${id}`, version: '1' }, { capabilities: { tools: { listChanged: false } } });
    const levelOf = (): McpLevel => mcpLevel(this.store.getSettings(me.board.id), id, this.store.getCard(me.card.id)?.agentId ?? '', me.card.role);

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const level = levelOf();
      if (level === 'off') return { tools: [] };
      const running = await this.ensure(id);
      const tools = running.tools.filter((t) => mcpToolAllowed(level, entry, t)).map((t) => t.raw ?? { name: t.name, description: t.description, inputSchema: { type: 'object' } });
      return { tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const level = levelOf();
      const fresh = this.entry(id) ?? entry;
      const refuse = (why: string) => ({ isError: true, content: [{ type: 'text' as const, text: why }] });
      if (level === 'off') return refuse(`You may not use the ${fresh.label} server on this board (MCP tab: access is off for your agent).`);
      let running: Running;
      try {
        running = await this.ensure(id);
      } catch (err) {
        return refuse(`The ${fresh.label} server is not running: ${(err as Error).message}`);
      }
      const tool = running.tools.find((t) => t.name === name);
      if (!tool) return refuse(`The ${fresh.label} server has no tool "${name}".`);
      if (!mcpToolOffered(fresh, tool)) return refuse(`"${name}" is not offered on this board: ${fresh.label} is limited to a short list of tools (Settings → MCP shows it). Use one of the tools you were given.`);
      if (!mcpToolAllowed(level, fresh, tool)) return refuse(`"${name}" changes things, and your access to ${fresh.label} is read only (MCP tab). Ask the human to raise it, or use a tool that only reads.`);
      const slot = this.slot(id);
      // The server just failed twice in a way that means it cannot reach what it drives: answer at once instead of waiting out
      // another timeout, and say what to do instead of probing the machine.
      if (slot.openUntil > Date.now()) return refuse(`${fresh.label} is not reachable right now (${slot.lastDown.slice(0, 160)}).${fresh.unavailableHint ? ` ${fresh.unavailableHint}` : ''}`);
      const write = !mcpToolAllowed('read', fresh, tool);
      const call = () => running.client.callTool({ name, arguments: request.params.arguments ?? {} }, undefined, { timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true });
      const started = Date.now();
      let ok = true;
      let bytes = 0;
      try {
        // An exclusive server drives one shared real thing: changes are served one at a time, reads run freely.
        const result = (fresh.exclusive && write ? await this.serial(slot, call) : await call()) as { isError?: boolean; content?: { type: string; text?: string }[] };
        bytes = JSON.stringify(result).length;
        ok = !result.isError;
        const said = (result.content ?? []).map((c) => c.text ?? '').join(' ');
        if (!ok && looksDown(said)) {
          this.noteDown(slot, said);
          if (fresh.unavailableHint) return { ...result, content: [...(result.content ?? []), { type: 'text' as const, text: fresh.unavailableHint }] } as never;
        } else if (ok) {
          slot.downStreak = 0;
          slot.openUntil = 0;
        }
        return result as never;
      } catch (err) {
        ok = false;
        const msg = (err as Error).message;
        if (looksDown(msg)) this.noteDown(slot, msg);
        return refuse(`${fresh.label} failed: ${msg}${looksDown(msg) && fresh.unavailableHint ? ` ${fresh.unavailableHint}` : ''}`);
      } finally {
        slot.calls++;
        // Arguments and results stay out of the log (they can be large or private): who, what, how long, how big.
        this.store.append('mcp.call', me.card.id, { server: id, tool: name, ms: Date.now() - started, ok, bytes, agentId: this.store.getCard(me.card.id)?.agentId ?? null, write }, `card:${me.card.id}`);
      }
    });

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  }

  private noteDown(slot: Slot, text: string) {
    slot.downStreak++;
    slot.lastDown = text.replace(/\s+/g, ' ');
    if (slot.downStreak >= BREAKER_AFTER) slot.openUntil = Date.now() + BREAKER_MS;
  }

  private serial<T>(slot: Slot, fn: () => Promise<T>): Promise<T> {
    const next = slot.writeChain.then(fn, fn);
    slot.writeChain = next.catch(() => {});
    return next;
  }
}

async function listAllTools(client: Client): Promise<HubTool[]> {
  const out: HubTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    for (const t of page.tools) {
      out.push({
        name: t.name,
        description: t.description ?? '',
        ...(t.annotations?.readOnlyHint !== undefined ? { readOnlyHint: t.annotations.readOnlyHint } : {}),
        ...(t.annotations?.destructiveHint !== undefined ? { destructiveHint: t.annotations.destructiveHint } : {}),
        raw: t as unknown as Record<string, unknown>,
      });
    }
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

/** The daemon's environment for a hosted server: provider keys and the harness's own markers stay out. */
function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const drop = /^(NVIDIA_API_KEY|GROQ_API_KEY|KEV_API_KEY|IH_API_TOKEN|IH_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|CLAUDECODE|CLAUDE_CODE_.*|.*_API_KEY)$/;
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && !drop.test(k)) as [string, string][]);
}

/** Registers `/hub/:id`: stateless, like `/mcp`, and authenticated by the session's board token. */
export function registerMcpHub(app: FastifyInstance, runner: Runner, hub: McpHub) {
  const handler = async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const token = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
    const me = token ? runner.identify(token) : null;
    if (!me) return reply.status(401).send({ error: 'unknown or expired board session token' });
    if (req.method !== 'POST') return reply.status(405).header('allow', 'POST').send({ error: 'stateless server: POST only' });
    return hub.handle(me, req.params.id, req, reply);
  };
  app.route({ method: ['GET', 'POST', 'DELETE'], url: '/hub/:id', handler });
}

