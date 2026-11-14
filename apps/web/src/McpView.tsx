import { useCallback, useEffect, useState } from 'react';
import { effectiveAgents, mcpLevel, mcpToolIsRead, type AddonView, type AgentProfile, type BoardMcpView, type McpBoardSettings, type McpLevel, type McpServerView, type Settings } from '@ih/core';
import { api, type PoolWithStatus } from './api.ts';

const LEVEL_LABEL: Record<McpLevel, string> = { off: 'Off', read: 'Read only', full: 'Full' };

const STATE_LABEL: Record<McpServerView['state'], string> = { stopped: 'stopped', starting: 'starting…', running: 'running', error: 'error' };

/** Whether a server is up, and what to do if not: one small badge. */
export function ServerState({ view }: { view: McpServerView }) {
  if (!view.installed) return <span className="badge mcp-state warn" title="Its command is not on this machine yet">not installed</span>;
  return (
    <span className={`badge mcp-state ${view.state}`} title={view.error ?? undefined}>
      {STATE_LABEL[view.state]}
    </span>
  );
}

/** Tools a server offers, each marked as reading or changing things (the server's hint, or the operator's call). */
export function ToolList({ view }: { view: McpServerView }) {
  if (!view.tools.length) return <p className="muted small">{view.state === 'running' ? 'This server lists no tools.' : 'Start the server to see its tools.'}</p>;
  return (
    <ul className="mcp-tools">
      {view.tools.map((t) => {
        const read = mcpToolIsRead(view.entry, t);
        const hidden = t.offered === false;
        return (
          <li key={t.name} title={hidden ? `${t.description} (not offered to agents: Settings → MCP)` : t.description} className={hidden ? 'hidden-tool' : ''}>
            <code>{t.name}</code>
            {hidden ? <span className="kind">hidden</span> : <span className={`kind ${read ? 'read' : 'write'}`}>{read ? 'reads' : 'changes'}</span>}
          </li>
        );
      })}
    </ul>
  );
}

const COMPONENT_LABEL: Record<AddonView['components'][number]['state'], string> = { running: 'running', starting: 'starting…', stopped: 'off', error: 'error', missing: 'not installed' };
const componentLabel = (c: AddonView['components'][number]) => (c.kind === 'plugin' ? (c.state === 'running' ? 'connected' : 'not connected') : COMPONENT_LABEL[c.state]);

/** One add-on: a switch for a whole set of MCP servers and helper processes, with what each part is doing. */
function AddonCard(props: { addon: AddonView; boardName: string; busy: boolean; onToggle: (on: boolean, move: boolean) => void }) {
  const a = props.addon;
  const canSwitch = a.enabled || a.available;
  return (
    <section className={`mcp-card surface-box addon ${a.enabled ? 'on' : ''}`}>
      <div className="row nowrap mcp-card-head">
        <label className="switch" title={a.enabled ? 'On for this board' : a.available ? 'Off for this board' : 'Not available for this board'}>
          <input
            type="checkbox"
            checked={a.enabled}
            disabled={props.busy || !canSwitch}
            onChange={(e) => {
              if (e.target.checked && a.heldBy) return;
              props.onToggle(e.target.checked, false);
            }}
            aria-label={`${a.label} on for this board`}
          />
          <span />
        </label>
        <strong>{a.label}</strong>
        <span className="badge">add-on</span>
        {props.busy && <span className="muted small">Working…</span>}
        <span className="spacer" />
        {a.heldBy && !a.enabled && a.available && (
          <button className="small-btn" disabled={props.busy} onClick={() => props.onToggle(true, true)} title={`Stops it for “${a.heldBy.boardName}” and starts it here`}>Move sync here</button>
        )}
      </div>
      <p className="muted small">{a.description}</p>
      {a.reasons.map((r) => <p key={r} className="error-text small">{r}</p>)}
      {a.heldBy && !a.enabled && <p className="hint">The file sync is serving “{a.heldBy.boardName}”. Only one folder can be served at a time.</p>}
      {a.warnings.map((w) => <p key={w} className="hint">⚠ {w}</p>)}
      {a.enabled && a.ready === false && a.advice && <p className="hint">⚠ {a.advice} Cards that need it wait until it is connected.</p>}
      {!a.enabled && a.willCreate.length > 0 && a.available && <p className="hint">Switching it on creates {a.willCreate.join(', ')} in {props.boardName}'s folder (nothing already there is overwritten).</p>}
      <ul className="addon-parts">
        {a.components.map((c) => (
          <li key={c.id}>
            <span className={`badge mcp-state ${c.kind === 'plugin' && c.state === 'stopped' ? 'warn' : c.state === 'missing' ? 'warn' : c.state}`}>{componentLabel(c)}</span>
            <span>{c.label}</span>
            <span className="muted small">{c.kind === 'service' ? 'helper process in this board\'s folder' : c.kind === 'plugin' ? 'in Studio' : 'MCP server'}{c.detail ? ` · ${c.detail}` : ''}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The MCP tab of a board (master plan Phase 9): switch the machine's servers on for this board, say which agents may
 * use each one and how far, and set the per-card tool grants beside them. The library itself is managed in Settings.
 */
export function McpView(props: {
  boardId: string;
  boardName: string;
  settings: Settings | null;
  pools: PoolWithStatus[];
  onSettings: (s: Settings) => void;
  onOpenLibrary: () => void;
  onOpenAgents: () => void;
  onError: (m: string) => void;
}) {
  const { settings, boardId } = props;
  const [data, setData] = useState<BoardMcpView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newPreset, setNewPreset] = useState('');
  const [addons, setAddons] = useState<AddonView[]>([]);
  const [addonBusy, setAddonBusy] = useState<string | null>(null);

  const reload = useCallback(() => {
    void api.addons(boardId).then(setAddons, () => {});
    return api.boardMcp(boardId).then(setData, (e: Error) => props.onError(e.message));
  }, [boardId]);
  // Servers start and stop on their own; the view follows.
  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 3000);
    return () => clearInterval(t);
  }, [reload, settings?.mcp, settings?.grants]);

  if (!settings || !data) return <div className="page"><p className="muted">Loading…</p></div>;

  const mcp = settings.mcp;
  const agents = effectiveAgents(settings, props.pools).filter((a) => a.enabled);
  const save = async (patch: Partial<Settings>) => {
    try {
      props.onSettings(await api.updateSettings(boardId, patch));
    } catch (err) {
      props.onError((err as Error).message);
    }
  };
  const saveMcp = (next: McpBoardSettings) => save({ mcp: next });
  const known = new Set(data.servers.map((s) => s.entry.id));
  const setEnabled = (id: string, on: boolean) => {
    const enabled = on ? [...mcp.enabled.filter((e) => e !== id), id] : mcp.enabled.filter((e) => e !== id);
    void saveMcp({ ...mcp, enabled });
    // A server that is switched on should be up for the sessions that start next.
    if (on) void api.mcpAction(id, 'start').then(reload, (e: Error) => props.onError(e.message));
  };
  const setLevel = (serverId: string, agent: AgentProfile | 'default', level: McpLevel) => {
    const cur = mcp.access[serverId] ?? { default: 'full' as McpLevel, agents: {} };
    let next;
    if (agent === 'default') next = { ...cur, default: level };
    else {
      // An entry equal to what the agent would get anyway is dropped, so the matrix stays small.
      const fallback = agent.role === 'worker' ? cur.default : 'off';
      const { [agent.id]: _, ...rest } = cur.agents;
      next = { ...cur, agents: level === fallback ? rest : { ...rest, [agent.id]: level } };
    }
    void saveMcp({ ...mcp, access: { ...mcp.access, [serverId]: next } });
  };
  const toggleAddon = async (a: AddonView, on: boolean, move: boolean) => {
    if (on && !move && a.willCreate.length && !confirm(`Switching on ${a.label} creates ${a.willCreate.join(', ')} in this board's folder. Nothing already there is overwritten. Continue?`)) return;
    if (on && move && !confirm(`Move ${a.label} to this board? It stops serving “${a.heldBy?.boardName}” and starts here.`)) return;
    setAddonBusy(a.id);
    try {
      if (on) await api.addonEnable(boardId, a.id, move);
      else await api.addonDisable(boardId, a.id);
      props.onSettings(await api.settings(boardId));
    } catch (err) {
      props.onError((err as Error).message);
    } finally {
      setAddonBusy(null);
      void reload();
    }
  };
  const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  const applyPreset = (servers: string[]) => {
    const enabled = servers.filter((s) => known.has(s));
    void saveMcp({ ...mcp, enabled });
    for (const id of enabled) void api.mcpAction(id, 'start').then(reload, (e: Error) => props.onError(e.message));
  };
  const savePreset = () => {
    const name = newPreset.trim();
    if (!name) return;
    void saveMcp({ ...mcp, presets: [...mcp.presets.filter((p) => p.name !== name), { name, servers: mcp.enabled }] });
    setNewPreset('');
  };
  const act = async (id: string, action: 'start' | 'stop' | 'restart') => {
    setBusy(`${id}:${action}`);
    try {
      await api.mcpAction(id, action);
    } catch (err) {
      props.onError((err as Error).message);
    } finally {
      setBusy(null);
      void reload();
    }
  };
  const install = async (id: string) => {
    setBusy(`${id}:install`);
    try {
      const r = await api.mcpInstall(id);
      if (!r.ok) props.onError(`Install failed:\n${r.output.slice(-600)}`);
    } catch (err) {
      props.onError((err as Error).message);
    } finally {
      setBusy(null);
      void reload();
    }
  };

  return (
    <div className="page mcp-page">
      <div className="page-head">
        <div>
          <h2>MCP</h2>
          <p className="muted small">
            MCP servers give agents tools that act outside the repository, such as an open Roblox Studio place. They are installed once for this machine
            (<button className="link" onClick={props.onOpenLibrary}>Settings → MCP</button>); here you choose which are on for this board and how far each agent may use them.
            Agents reach them through the harness, which never hands out a server's own address or keys. Switching a server on applies to sessions that start afterwards;
            switching it off, or lowering access, applies at the next tool call. The orchestrator is told what is on and who may use it.
          </p>
        </div>
      </div>

      {addons.length > 0 && (
        <section className="mcp-addons" aria-label="Add-ons">
          <h3>Add-ons</h3>
          <p className="muted small">An add-on switches on a set of servers and, where it needs one, a helper process in this board's folder, all in one go. Off until you switch it on.</p>
          {addons.map((a) => (
            <AddonCard key={a.id} addon={a} boardName={props.boardName} busy={addonBusy === a.id} onToggle={(on, move) => void toggleAddon(a, on, move)} />
          ))}
        </section>
      )}

      <section className="mcp-presets" aria-label="Presets">
        <span className="muted small">Presets</span>
        <div className="row">
          {mcp.presets.map((p) => (
            <span key={p.name} className={`pill-check ${sameSet(p.servers.filter((s) => known.has(s)), mcp.enabled) ? 'on' : ''}`}>
              <button className="link" onClick={() => applyPreset(p.servers)} title={`Switch on exactly: ${p.servers.join(', ') || 'nothing'}`}>{p.name}</button>
              <button className="ghost icon-btn" aria-label={`Delete preset ${p.name}`} title="Delete this preset" onClick={() => void saveMcp({ ...mcp, presets: mcp.presets.filter((x) => x.name !== p.name) })}>✕</button>
            </span>
          ))}
          <span className="row">
            <input value={newPreset} placeholder="Save what is on now as…" aria-label="New preset name" onChange={(e) => setNewPreset(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && savePreset()} />
            <button className="ghost small-btn" disabled={!newPreset.trim()} onClick={savePreset}>Save preset</button>
          </span>
        </div>
      </section>

      <div className="mcp-servers">
        {data.servers.map((s) => {
          const id = s.entry.id;
          const on = mcp.enabled.includes(id);
          const access = mcp.access[id] ?? { default: 'full' as McpLevel, agents: {} };
          return (
            <section key={id} className={`mcp-card surface-box ${on ? 'on' : ''}`}>
              <div className="row nowrap mcp-card-head">
                <label className="switch" title={on ? 'On for this board' : 'Off for this board'}>
                  <input type="checkbox" checked={on} onChange={(e) => setEnabled(id, e.target.checked)} aria-label={`${s.entry.label} on for this board`} />
                  <span />
                </label>
                <strong>{s.entry.label}</strong>
                <code className="muted small">{id}</code>
                <ServerState view={s} />
                {s.entry.exclusive && <span className="badge" title="It drives one shared real thing; changes are served one at a time">one at a time</span>}
                <span className="spacer" />
                {!s.installed && s.entry.install && (
                  <button className="small-btn" disabled={busy === `${id}:install`} onClick={() => void install(id)}>{busy === `${id}:install` ? 'Installing…' : 'Install'}</button>
                )}
                {s.installed && s.state !== 'running' && s.state !== 'starting' && s.entry.hosting === 'shared' && (
                  <button className="ghost small-btn" disabled={!!busy} onClick={() => void act(id, 'start')}>Start</button>
                )}
                {s.state === 'running' && <button className="ghost small-btn" disabled={!!busy} onClick={() => void act(id, 'stop')}>Stop</button>}
              </div>
              <p className="muted small">{s.entry.description}</p>
              {s.state === 'error' && s.error && <p className="error-text small">{s.error}{s.log.length ? ` — ${s.log.at(-1)}` : ''}</p>}
              {s.entry.hosting === 'per-session' && <p className="hint">Each card's session starts its own copy of this server (it is not shared).</p>}

              {on && (
                <>
                  <h4>Who may use it</h4>
                  <div className="mcp-matrix">
                    <label className="mcp-row">
                      <span>Workers by default</span>
                      <select value={access.default} onChange={(e) => setLevel(id, 'default', e.target.value as McpLevel)} aria-label={`${s.entry.label}: default level for workers`}>
                        {(['full', 'read', 'off'] as McpLevel[]).map((l) => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}
                      </select>
                    </label>
                    {agents.map((a) => {
                      const level = mcpLevel(settings, id, a.id, a.role);
                      const own = access.agents[a.id] !== undefined;
                      return (
                        <label key={a.id} className="mcp-row">
                          <span>
                            <span className={`role-tag ${a.role}`}>{a.role}</span> {a.id}
                            {a.notes?.length ? <span className="muted small"> [{a.notes.join(', ')}]</span> : null}
                          </span>
                          <select className={own ? 'overridden' : ''} value={level} onChange={(e) => setLevel(id, a, e.target.value as McpLevel)} aria-label={`${s.entry.label}: ${a.id}`}>
                            {(['full', 'read', 'off'] as McpLevel[]).map((l) => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}
                          </select>
                        </label>
                      );
                    })}
                  </div>
                  <p className="hint">{s.entry.hosting === 'per-session' ? 'This server is started by each card itself, so access is on or off: Read only counts as off.' : 'Read only allows the tools the server marks as reading.'} Planners get none unless you give it here.</p>
                </>
              )}
              <details className="mcp-tools-box">
                <summary>{s.tools.filter((t) => t.offered !== false).length} of {s.tools.length} tool{s.tools.length === 1 ? '' : 's'} offered to agents</summary>
                <ToolList view={s} />
              </details>
            </section>
          );
        })}
        {!data.servers.length && <p className="muted">No servers in the library yet. Add one in Settings → MCP.</p>}
      </div>

      <h3>Tools granted to a card</h3>
      <p className="muted small">
        Some tools are started per card instead of shared, like a headless browser. A planner or an agent asks for one on a card; the mode says whether that waits for you.
      </p>
      <div className="surface-box mcp-grants">
        {data.grants.map((g) => (
          <div key={g.name} className="mcp-row">
            <span>
              <strong>{g.label}</strong> <code className="muted small">grant-{g.name}</code>
              <span className="muted small"> {g.description}</span>
              {!g.installed && <span className="badge mcp-state warn" title={`\`${g.command}\` is not installed`}>not installed</span>}
            </span>
            <span className="row nowrap">
              {!g.installed && g.installable && (
                <button className="small-btn" disabled={busy === `grant:${g.name}`} onClick={() => {
                  setBusy(`grant:${g.name}`);
                  api.installTool(boardId, g.name).then((r) => !r.ok && props.onError(`Install failed:\n${r.output.slice(-600)}`), (e: Error) => props.onError(e.message)).finally(() => { setBusy(null); void reload(); });
                }}>{busy === `grant:${g.name}` ? 'Installing…' : 'Install'}</button>
              )}
              <select value={g.mode} aria-label={`${g.label} mode`} onChange={(e) => void save({ grants: { ...settings.grants, [g.name]: { ...settings.grants[g.name]!, mode: e.target.value as 'auto' | 'approval' | 'off' } } })}>
                <option value="auto">Given when asked</option>
                <option value="approval">Ask me first</option>
                <option value="off">Off</option>
              </select>
            </span>
          </div>
        ))}
      </div>
      <p className="hint">Agents can also carry short notes (UI DEV, CODE REVIEW…) that steer which cards they get: set them in <button className="link" onClick={props.onOpenAgents}>Agents</button>.</p>
    </div>
  );
}
