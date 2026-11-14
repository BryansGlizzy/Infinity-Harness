import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import type { AddonComponent, AddonView, Board, BoardMode, Card } from '@ih/core';
import type { Store } from '@ih/db';
import type { McpHub } from './mcp-hub.ts';
import type { Live } from './live.ts';
import { findBinary } from './config.ts';
import { vinegarPluginsDir } from './mcp-hub.ts';

// Add-ons (master plan Phase 9, §3.6). An add-on is a named bundle a board switches on in one go: a set of MCP servers
// from the library and, where the bundle needs one, a helper process that runs with the board's folder as its working
// directory. Roblox Studio is the first: the Studio MCP server, RbxSync's file sync (`rbxsync serve`) and its MCP
// server. Off by default. Switching on is the operator's decision: only text defined here is ever run, never an agent's.

/** A helper process the add-on keeps running for one board, in that board's folder. */
export interface AddonService {
  id: string;
  label: string;
  /** A command name (looked up on PATH and in the usual tool folders) or a path. */
  command: string;
  args: string[];
  /** It listens here on loopback; only one folder can be served at a time, so one board holds it. */
  port: number;
  healthPath: string;
  /** Set up once when the folder lacks `marker`. The command must not overwrite what is already there. */
  init?: { marker: string; command: string; args: (folder: string, name: string) => string[]; creates: string[] };
}

/** How an add-on's outside half is doing: Studio's plugins connected or not. `null` means unknown (never held against anyone). */
export interface AddonStatus {
  ready: boolean | null;
  parts: { id: string; label: string; connected: boolean | null; detail?: string }[];
  /** What a person or an agent should do about it, in a sentence. */
  advice: string;
}

export interface StatusContext {
  hub: McpHub;
  env: NodeJS.ProcessEnv;
  folder: string;
  /** The helper process's port and whether it is up, when the add-on has one. */
  service: { port: number; running: boolean; error: string | null } | null;
}

export interface AddonDef {
  id: string;
  label: string;
  description: string;
  /** Library servers it switches on for the board. */
  servers: string[];
  /** Boards it can be switched on for. Direct boards edit the folder in place, which is what a live sync needs. */
  boardModes: BoardMode[];
  service?: AddonService;
  /** Files whose presence means another tool already manages the folder. */
  conflicts?: { file: string; text: string }[];
  /** Said when it is switched on. */
  note?: string;
  /** Told to the agents that may use its servers: how the pieces fit, and what to do when they are down. */
  guide?: string[];
  /** Reads how its outside half is doing. Used for the MCP tab, for holding cards while it is down, and for the `addon_status` tool. */
  status?: (ctx: StatusContext) => Promise<AddonStatus>;
}

/** Studio's side of the Roblox add-on: the MCP server's bridge reports whether its plugin is connected, and RbxSync reports its own link. */
async function robloxStatus(ctx: StatusContext): Promise<AddonStatus> {
  const parts: AddonStatus['parts'] = [];
  const bridge = Number(ctx.env.ROBLOX_STUDIO_PORT) > 0 ? Number(ctx.env.ROBLOX_STUDIO_PORT) : 58741;
  try {
    const h = (await (await fetch(`http://127.0.0.1:${bridge}/health`, { signal: AbortSignal.timeout(2500) })).json()) as { pluginConnected?: boolean; instanceCount?: number };
    // Not connected is most often a plugin Studio never loaded: say so when its file is not in the folder Studio reads.
    const dir = vinegarPluginsDir();
    const missing = !h.pluginConnected && dir !== null && !existsSync(join(dir, 'MCPPlugin.rbxmx'));
    parts.push({
      id: 'studio-plugin',
      label: 'Studio MCP plugin',
      connected: h.pluginConnected === true,
      detail: h.pluginConnected
        ? `${h.instanceCount ?? 0} place${h.instanceCount === 1 ? '' : 's'} connected`
        : missing
          ? `MCPPlugin.rbxmx is not in Studio's plugins folder (${dir}): put it there and restart Studio`
          : 'restart Studio if the plugin was just installed, then press MCP Server in its plugin toolbar',
    });
  } catch {
    parts.push({ id: 'studio-plugin', label: 'Studio MCP plugin', connected: null, detail: 'the Studio MCP server is not answering' });
  }
  if (ctx.service && !ctx.service.running) {
    parts.push({ id: 'rbxsync-plugin', label: 'RbxSync plugin', connected: false, detail: ctx.service.error ?? 'the sync process is not running' });
  } else {
    const r = await ctx.hub.callTool('rbxsync', 'connection_status', {}, 6000);
    const text = r.text;
    const n = /(\d+)\s+place/i.exec(text);
    const connected = r.ok ? (n ? Number(n[1]) > 0 : /no places? connected|not connected/i.test(text) ? false : null) : null;
    const mapped = /→\s*(\S+)/.exec(text)?.[1];
    parts.push({
      id: 'rbxsync-plugin',
      label: 'RbxSync plugin',
      connected,
      detail: connected ? `place connected${mapped ? `, syncing ${mapped}` : ''}${mapped && mapped.replace(/\/$/, '') !== ctx.folder.replace(/\/$/, '') ? ` (this board's folder is ${ctx.folder})` : ''}` : connected === false ? 'press Connect in the RbxSync plugin' : 'its state is unknown',
    });
  }
  const down = parts.filter((p) => p.connected === false);
  const ready = down.length ? false : parts.every((p) => p.connected === true) ? true : null;
  const advice = down.length
    ? `${down.map((p) => `${p.label}: ${p.detail}`).join('; ')}. Open the place in Studio and connect the plugins; nothing in the project folder will reach Studio until then.`
    : ready
      ? 'Studio and RbxSync are connected.'
      : 'Studio\'s state could not be read.';
  return { ready, parts, advice };
}

/** `env.IH_RBXSYNC_PORT` moves RbxSync's sync server off 44755 (a second daemon instance, or a port something else holds). Studio's plugin looks on 44755. */
export function builtinAddons(env: NodeJS.ProcessEnv = process.env): AddonDef[] {
  const port = Number(env.IH_RBXSYNC_PORT) > 0 ? Number(env.IH_RBXSYNC_PORT) : 44755;
  return [
    {
      id: 'roblox',
      label: 'Roblox Studio',
      description:
        'Everything for building a Roblox game with agents: the Studio MCP server (read and change the open place, run Luau, playtest, logs, screenshots), RbxSync keeping this folder and Studio in step (scripts as .luau files, edited by agents in place), and RbxSync\'s own tools. Studio needs both plugins (MCP Server and RbxSync) showing Connected.',
      servers: ['roblox-studio', 'rbxsync'],
      boardModes: ['direct'],
      service: {
        id: 'rbxsync-serve',
        label: 'RbxSync file sync',
        command: 'rbxsync',
        args: port === 44755 ? ['serve'] : ['serve', '--port', String(port)],
        port,
        healthPath: '/health',
        init: {
          marker: 'rbxsync.json',
          command: 'rbxsync',
          args: (folder, name) => ['init', '--name', name, '--path', folder],
          creates: ['rbxsync.json', 'src/', 'assets/', 'terrain/', 'sourcemap.json', '.gitignore (appended to)'],
        },
      },
      conflicts: [
        { file: 'default.project.json', text: 'This folder has a Rojo project (default.project.json). RbxSync is a second sync tool for the same folder: use one of them.' },
        { file: 'rojo.project.json', text: 'This folder has a Rojo project. RbxSync is a second sync tool for the same folder: use one of them.' },
      ],
      note: 'Open your place in Studio and press Connect in the RbxSync plugin. Studio edits are written into the folder as you make them; agents\' file edits are pushed back.',
      status: robloxStatus,
      guide: [
        'The board has the Roblox add-on on. How the pieces fit:',
        '- The project folder is the place. Scripts are files under src/<Service>/…: Name.server.luau is a Script, Name.client.luau a LocalScript, other .luau files are ModuleScripts. Instances that are not scripts (a Part, a RemoteEvent) are Name.rbxjson files: copy the shape of one already in src/.',
        '- Write scripts as files. The sync does not push by itself: after saving files call rbxsync sync_to_studio to see them in Studio. Use extract_game once if the place already holds content you need as files.',
        '- Use the roblox-studio tools for everything else: reading and changing the live place (search_objects, get_instance_properties, set_properties), running Luau (execute_luau, eval_server_runtime), playtests (solo_playtest), logs (get_runtime_logs) and screenshots. Prefer roblox-studio wherever both servers could do it; rbxsync is only the sync.',
        '- Verify by reading your work back from Studio, and say what you saw.',
        '- If a Roblox tool fails or Studio looks disconnected: call addon_status once. If it says not connected, do not investigate the machine (ps, ss, logs and other folders are refused and cost steps): call ask_parent once with what you were doing, then report_blocked.',
      ],
    },
  ];
}

export type ServiceState = 'stopped' | 'starting' | 'running' | 'error';

interface Running {
  boardId: string;
  folder: string;
  proc: ChildProcess | null;
  state: ServiceState;
  error: string | null;
  log: string[];
  restarts: number;
  timer?: NodeJS.Timeout;
  stopping: boolean;
}

export class AddonError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export interface AddonsOptions {
  store: Store;
  hub: McpHub;
  env: NodeJS.ProcessEnv;
  defs?: AddonDef[];
  /** Where an add-on's state changes are pushed, so clients can show its link live (`addon.status`, subject = board id). */
  live?: Live;
}

const LOG_LINES = 40;
const START_WAIT_MS = 20_000;
const MAX_RESTARTS = 5;

const clip = (lines: string[], line: string) => {
  lines.push(line.slice(0, 400));
  if (lines.length > LOG_LINES) lines.splice(0, lines.length - LOG_LINES);
};

/** Does something answer HTTP on this loopback port? */
async function answers(port: number, path: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(1500) });
    return res.status < 500;
  } catch {
    return false;
  }
}

/** Is anything listening on this loopback port (an HTTP answer or not)? */
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ host: '127.0.0.1', port }, () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
    s.setTimeout(1000, () => {
      s.destroy();
      resolve(false);
    });
  });
}

export class Addons {
  private store: Store;
  private hub: McpHub;
  private env: NodeJS.ProcessEnv;
  private defs: AddonDef[];
  /** One per service id: the board that holds it and its process. */
  private running = new Map<string, Running>();
  private stopped = false;
  /** The last read of each switched-on add-on's outside half, per board. */
  private health = new Map<string, Map<string, { at: number; status: AddonStatus }>>();
  private poll: NodeJS.Timeout | null = null;
  private live: Live | undefined;
  /** What each board's clients were last sent for an add-on, so only real changes are pushed. */
  private pushed = new Map<string, string>();

  constructor(opts: AddonsOptions) {
    this.store = opts.store;
    this.hub = opts.hub;
    this.env = opts.env;
    this.defs = opts.defs ?? builtinAddons(opts.env);
    this.live = opts.live;
  }

  register(def: AddonDef) {
    this.defs = [...this.defs.filter((d) => d.id !== def.id), def];
  }

  def(id: string): AddonDef | undefined {
    return this.defs.find((d) => d.id === id);
  }

  private resolve(command: string): string | null {
    return command.includes('/') ? (existsSync(command) ? command : null) : findBinary(command, this.env);
  }

  private holderOf(def: AddonDef): { boardId: string; boardName: string } | null {
    const r = def.service ? this.running.get(def.service.id) : undefined;
    if (r && r.state !== 'stopped') return { boardId: r.boardId, boardName: this.store.getBoard(r.boardId)?.name ?? r.boardId };
    // Not running yet (a daemon that just started): whichever board has the add-on on holds it.
    for (const b of this.store.listBoards()) if (this.store.getSettings(b.id).addons.includes(def.id)) return { boardId: b.id, boardName: b.name };
    return null;
  }

  // --- live link state

  /** Sends clients an add-on's view when it differs from what they were last sent (a plugin connected, the sync stopped, it was switched off). */
  private push(boardId: string, defId: string) {
    const def = this.def(defId);
    const board = this.store.getBoard(boardId);
    if (!this.live || !def || !board) return;
    const view = this.viewOf(def, board);
    const key = `${boardId}:${defId}`;
    const text = JSON.stringify(view);
    if (this.pushed.get(key) === text) return;
    this.pushed.set(key, text);
    this.live.publish('addon.status', boardId, view);
  }

  /** The helper process of a service changed state: every board's view of the add-ons that use it is refreshed. */
  private pushService(serviceId: string) {
    for (const def of this.defs) {
      if (def.service?.id !== serviceId) continue;
      for (const b of this.store.listBoards()) if (this.store.getSettings(b.id).addons.includes(def.id)) this.push(b.id, def.id);
    }
  }

  // --- how the outside half is doing

  private statusContext(def: AddonDef, board: Board): StatusContext {
    const svc = def.service;
    const r = svc ? this.running.get(svc.id) : undefined;
    return { hub: this.hub, env: this.env, folder: board.repoPath, service: svc ? { port: svc.port, running: !!r && r.boardId === board.id && r.state === 'running', error: r && r.boardId === board.id ? r.error : null } : null };
  }

  /** Reads an add-on's state now (the `addon_status` tool, and the poll). */
  async status(boardId: string, id: string): Promise<AddonStatus | null> {
    const def = this.def(id);
    const board = this.store.getBoard(boardId);
    if (!def?.status || !board) return null;
    const status = await def.status(this.statusContext(def, board)).catch((): AddonStatus => ({ ready: null, parts: [], advice: 'its state could not be read' }));
    const perBoard = this.health.get(boardId) ?? this.health.set(boardId, new Map()).get(boardId)!;
    perBoard.set(id, { at: Date.now(), status });
    this.push(boardId, id);
    return status;
  }

  /** Re-reads every switched-on add-on every few seconds, so the tab and the scheduler see the last state without probing per tick. */
  startPolling(ms = 3000) {
    if (this.poll) return;
    const tick = async () => {
      for (const board of this.store.listBoards()) {
        for (const id of this.store.getSettings(board.id).addons) {
          if (!this.stopped) await this.status(board.id, id).catch(() => {});
        }
      }
    };
    this.poll = setInterval(() => void tick(), ms);
    this.poll.unref?.();
    void tick();
  }

  /** A worker card that needs an add-on's servers waits while its outside half is known to be down (Settings → addonGate). */
  holdReason(card: Card): string | null {
    if (!this.store.getSettings(card.boardId).addonGate) return null;
    const needs = this.store.effectiveRouting(card.id)?.needsMcp ?? [];
    if (!needs.length) return null;
    const enabled = this.store.getSettings(card.boardId).addons;
    for (const def of this.defs) {
      if (!enabled.includes(def.id) || !def.servers.some((s) => needs.includes(s))) continue;
      const seen = this.health.get(card.boardId)?.get(def.id);
      if (seen && Date.now() - seen.at < 30_000 && seen.status.ready === false) return `Waiting for ${def.label}: ${seen.status.advice}`;
    }
    return null;
  }

  /** The guide lines of every add-on this board has on, for the prompts of agents that may use its servers. */
  guideLines(boardId: string): string[] {
    const enabled = this.store.getSettings(boardId).addons;
    return this.defs.filter((d) => enabled.includes(d.id)).flatMap((d) => d.guide ?? []);
  }

  // --- what a board sees

  view(boardId: string): AddonView[] {
    const board = this.store.getBoard(boardId);
    if (!board) return [];
    return this.defs.map((def) => this.viewOf(def, board));
  }

  private viewOf(def: AddonDef, board: Board): AddonView {
    const settings = this.store.getSettings(board.id);
    const enabled = settings.addons.includes(def.id);
    const reasons: string[] = [];
    const warnings: string[] = [];
    if (!def.boardModes.includes(board.mode)) reasons.push(`It works on ${def.boardModes.join(' or ')} boards; this board is in ${board.mode} mode. ${board.mode === 'worktree' ? 'Agents on a worktree board edit separate copies, but a live sync serves one folder. Create a direct board for the project.' : ''}`.trim());
    if (!isFolder(board.repoPath)) reasons.push(`The board's folder is missing: ${board.repoPath}`);
    const svc = def.service;
    if (svc && !this.resolve(svc.command)) reasons.push(`\`${svc.command}\` is not installed on this machine.`);
    for (const c of def.conflicts ?? []) if (existsSync(join(board.repoPath, c.file))) warnings.push(c.text);
    const held = this.holderOf(def);
    const heldBy = held && held.boardId !== board.id ? held : null;

    const components: AddonComponent[] = [];
    for (const id of def.servers) {
      const v = this.hub.view(id);
      if (!v) {
        components.push({ id, label: id, kind: 'mcp', state: 'missing', detail: 'not in the library' });
        continue;
      }
      const state: AddonComponent['state'] = !v.installed ? 'missing' : v.state;
      components.push({ id, label: v.entry.label, kind: 'mcp', state, ...(!v.installed ? { detail: v.entry.install ? 'installed when you switch the add-on on' : 'not installed on this machine' } : v.error ? { detail: v.error } : {}) });
    }
    if (svc) {
      const r = this.running.get(svc.id);
      const mine = r && r.boardId === board.id;
      components.push({
        id: svc.id,
        label: svc.label,
        kind: 'service',
        state: !this.resolve(svc.command) ? 'missing' : mine ? r.state : 'stopped',
        ...(mine && r.error ? { detail: r.error } : mine && r.state === 'running' ? { detail: `serving ${r.folder} on port ${svc.port}` } : heldBy ? { detail: `serving ${this.store.getBoard(heldBy.boardId)?.repoPath ?? heldBy.boardName}` } : {}),
      });
      // The plugin's side of the link is only knowable for services that say so; Studio shows its own Connected.
    }
    // Studio's side (plugins connected or not) as last read; it is only known while the add-on is on.
    const seen = enabled ? this.health.get(board.id)?.get(def.id) : undefined;
    for (const part of seen?.status.parts ?? []) {
      if (part.connected === null) continue;
      components.push({ id: `${def.id}:${part.id}`, label: part.label, kind: 'plugin', state: part.connected ? 'running' : 'stopped', ...(part.detail ? { detail: part.detail } : {}) });
    }
    const willCreate = svc?.init && !existsSync(join(board.repoPath, svc.init.marker)) ? svc.init.creates : [];
    return { id: def.id, label: def.label, description: def.description, enabled, available: reasons.length === 0, reasons, warnings, heldBy, willCreate, components, ready: seen?.status.ready ?? null, advice: seen && seen.status.ready !== true ? seen.status.advice : null };
  }

  // --- switching on and off

  async enable(boardId: string, id: string, opts: { move?: boolean } = {}): Promise<AddonView> {
    const def = this.def(id);
    const board = this.store.getBoard(boardId);
    if (!def) throw new AddonError(404, `no add-on "${id}"`);
    if (!board) throw new AddonError(404, 'board not found');
    const view = this.viewOf(def, board);
    if (view.enabled) return view;
    if (!view.available) throw new AddonError(409, view.reasons.join(' '));
    if (view.heldBy) {
      if (!opts.move) throw new AddonError(409, `${def.label} sync is serving "${view.heldBy.boardName}", and only one folder can be served at a time. Move it here to switch it off there.`);
      await this.disable(view.heldBy.boardId, id);
    }
    const svc = def.service;
    if (svc) {
      // Something else already answers on the port (rbxsync serve started by hand, from VS Code): we cannot tell which folder it serves.
      if (await listening(svc.port)) {
        throw new AddonError(409, `Port ${svc.port} is already in use. If \`${svc.command}\` is running from a terminal or VS Code, stop it first: the harness has to start it in this folder itself to be sure which folder it serves.`);
      }
      if (svc.init && !existsSync(join(board.repoPath, svc.init.marker))) await this.runInit(svc, board);
    }
    // Servers that are not installed yet are installed now (the operator switched this on; only the entry's own install text runs).
    for (const sid of def.servers) {
      const v = this.hub.view(sid);
      if (v && !v.installed && v.entry.install) {
        const r = await this.hub.install(sid);
        if (!r.ok) throw new AddonError(409, `Installing ${v.entry.label} failed:\n${r.output.slice(-500)}`);
      }
    }
    const settings = this.store.getSettings(boardId);
    this.store.updateSettings(
      boardId,
      { addons: [...settings.addons, id], mcp: { ...settings.mcp, enabled: [...new Set([...settings.mcp.enabled, ...def.servers])] } },
      'user:local',
    );
    this.push(boardId, id);
    if (svc) await this.startService(svc, board);
    this.push(boardId, id);
    for (const sid of def.servers) void this.hub.ensure(sid).catch(() => {});
    void this.status(boardId, id).catch(() => {});
    return this.viewOf(def, board);
  }

  async disable(boardId: string, id: string): Promise<AddonView> {
    const def = this.def(id);
    const board = this.store.getBoard(boardId);
    if (!def) throw new AddonError(404, `no add-on "${id}"`);
    if (!board) throw new AddonError(404, 'board not found');
    const settings = this.store.getSettings(boardId);
    if (!settings.addons.includes(id)) return this.viewOf(def, board);
    this.health.get(boardId)?.delete(id);
    const remaining = settings.addons.filter((a) => a !== id);
    // Servers another switched-on add-on of this board still wants stay on.
    const wanted = new Set(this.defs.filter((d) => remaining.includes(d.id)).flatMap((d) => d.servers));
    this.store.updateSettings(
      boardId,
      { addons: remaining, mcp: { ...settings.mcp, enabled: settings.mcp.enabled.filter((s) => !def.servers.includes(s) || wanted.has(s)) } },
      'user:local',
    );
    if (def.service) {
      const r = this.running.get(def.service.id);
      if (r?.boardId === boardId) await this.stopService(def.service.id);
    }
    // A server only this add-on needed has nothing to do once its board lets go and nobody else has it on.
    for (const sid of def.servers) {
      const anyone = this.store.listBoards().some((b) => this.store.getSettings(b.id).mcp.enabled.includes(sid));
      if (!anyone && this.hub.entry(sid)?.autoStart !== true) await this.hub.stop(sid).catch(() => {});
    }
    this.push(boardId, id);
    return this.viewOf(def, board);
  }

  /** A board is removed: a helper process serving its folder is stopped (its settings go with the board). */
  async forgetBoard(boardId: string): Promise<void> {
    for (const [id, r] of [...this.running]) if (r.boardId === boardId) await this.stopService(id);
  }

  /** After a daemon start: services for boards that have an add-on on are started again. One board holds each. */
  async reconcile(): Promise<void> {
    for (const def of this.defs) {
      if (!def.service) continue;
      for (const board of this.store.listBoards()) {
        if (!this.store.getSettings(board.id).addons.includes(def.id)) continue;
        if (!this.viewOf(def, board).available) continue;
        if (this.running.get(def.service.id)) break;
        await this.startService(def.service, board).catch(() => {});
        for (const sid of def.servers) void this.hub.ensure(sid).catch(() => {});
        break;
      }
    }
  }

  // --- the helper process

  private runInit(svc: AddonService, board: Board): Promise<void> {
    const init = svc.init!;
    const bin = this.resolve(init.command);
    if (!bin) return Promise.reject(new AddonError(409, `\`${init.command}\` is not installed on this machine.`));
    return new Promise((resolve, reject) => {
      execFile(bin, init.args(board.repoPath, board.name), { cwd: board.repoPath, env: this.env, timeout: 60_000 }, (err, stdout, stderr) => {
        if (err) reject(new AddonError(409, `Setting up ${svc.label} in ${board.repoPath} failed: ${`${stdout}${stderr}`.slice(-400) || err.message}`));
        else resolve();
      });
    });
  }

  private async startService(svc: AddonService, board: Board): Promise<void> {
    const bin = this.resolve(svc.command);
    const r: Running = { boardId: board.id, folder: board.repoPath, proc: null, state: 'starting', error: null, log: [], restarts: 0, stopping: false };
    this.running.set(svc.id, r);
    if (!bin) {
      r.state = 'error';
      r.error = `\`${svc.command}\` is not installed`;
      return;
    }
    // Whatever already listens would be mistaken for the process started here (and that one would die on the busy port).
    if (await listening(svc.port)) {
      r.state = 'error';
      r.error = `port ${svc.port} is already in use by another process`;
      throw new AddonError(409, `${svc.label} did not start: ${r.error}`);
    }
    this.spawnService(svc, r, bin);
    // Up when it answers its health check; an exit before that is the error.
    const until = Date.now() + START_WAIT_MS;
    while (Date.now() < until && r.state === 'starting') {
      if (await answers(svc.port, svc.healthPath)) r.state = 'running';
      else await new Promise((res) => setTimeout(res, 250));
    }
    if (r.state === 'starting') {
      r.state = 'error';
      r.error = `it did not answer on port ${svc.port} within ${START_WAIT_MS / 1000} seconds`;
    }
    if (r.state === 'error') throw new AddonError(409, `${svc.label} did not start: ${r.error}${r.log.length ? ` (${r.log.at(-1)})` : ''}`);
  }

  private spawnService(svc: AddonService, r: Running, bin: string) {
    const proc = spawn(bin, svc.args, { cwd: r.folder, env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    r.proc = proc;
    const take = (d: Buffer) => d.toString().split('\n').forEach((l) => l.trim() && clip(r.log, l.replace(/\x1b\[[0-9;]*m/g, '')));
    proc.stdout?.on('data', take);
    proc.stderr?.on('data', take);
    proc.on('error', (err) => {
      r.state = 'error';
      r.error = err.message;
    });
    proc.on('exit', (code, signal) => {
      if (this.running.get(svc.id) !== r || r.proc !== proc) return;
      r.proc = null;
      if (r.stopping || this.stopped) {
        r.state = 'stopped';
        return;
      }
      r.state = 'error';
      r.error = `it stopped (${signal ?? `exit ${code}`})`;
      this.pushService(svc.id);
      // Restart with backoff a few times; after that it waits for a person (switch the add-on off and on).
      if (r.restarts >= MAX_RESTARTS) return;
      r.restarts++;
      r.timer = setTimeout(() => {
        if (this.running.get(svc.id) !== r || r.stopping || this.stopped) return;
        r.state = 'starting';
        this.spawnService(svc, r, bin);
        void (async () => {
          for (let i = 0; i < 40 && r.state === 'starting'; i++) {
            if (await answers(svc.port, svc.healthPath)) {
              r.state = 'running';
              r.error = null;
              this.pushService(svc.id);
              return;
            }
            await new Promise((res) => setTimeout(res, 250));
          }
        })();
      }, Math.min(30_000, 1000 * 2 ** r.restarts));
      r.timer.unref?.();
    });
  }

  private async stopService(serviceId: string): Promise<void> {
    const r = this.running.get(serviceId);
    if (!r) return;
    r.stopping = true;
    if (r.timer) clearTimeout(r.timer);
    const proc = r.proc;
    this.running.delete(serviceId);
    if (!proc || proc.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => proc.kill('SIGKILL'), 3000);
      proc.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      proc.kill('SIGTERM');
    });
  }

  /** The folder a service is serving and how it is doing, for tests and the status line. */
  serviceInfo(serviceId: string): { boardId: string; folder: string; state: ServiceState; log: string[] } | null {
    const r = this.running.get(serviceId);
    return r ? { boardId: r.boardId, folder: r.folder, state: r.state, log: r.log } : null;
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.poll) clearInterval(this.poll);
    await Promise.all([...this.running.keys()].map((id) => this.stopService(id)));
  }
}

/** True when the path is a folder: a board's folder is checked again right before anything runs in it. */
export const isFolder = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};
