import { useCallback, useEffect, useState } from 'react';
import { mcpToolIsRead, type McpLibraryEntry, type McpServerView } from '@ih/core';
import { api } from './api.ts';
import { ServerState } from './McpView.tsx';

const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);
const pairs = (text: string, sep: string) =>
  Object.fromEntries(
    lines(text).flatMap((l) => {
      const i = l.indexOf(sep);
      return i > 0 ? [[l.slice(0, i).trim(), l.slice(i + 1).trim()] as [string, string]] : [];
    }),
  );
const unpairs = (o: Record<string, string> | undefined, sep: string) => Object.entries(o ?? {}).map(([k, v]) => `${k}${sep}${v}`).join('\n');

const BLANK: McpLibraryEntry = { id: '', label: '', description: '', transport: 'stdio', command: '', args: [], env: {}, hosting: 'shared', exclusive: false, toolKinds: {}, autoStart: false };

/** Add or change a server. Everything here is the operator's text: agents never write to the library. */
function EntryForm(props: { initial: McpLibraryEntry; adding: boolean; onSave: (e: McpLibraryEntry) => Promise<void>; onCancel: () => void }) {
  const i = props.initial;
  const [e, setE] = useState<McpLibraryEntry>(i);
  const [args, setArgs] = useState((i.args ?? []).join('\n'));
  const [env, setEnv] = useState(unpairs(i.env, '='));
  const [headers, setHeaders] = useState(unpairs(i.headers, ': '));
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<McpLibraryEntry>) => setE((cur) => ({ ...cur, ...patch }));
  const stdio = e.transport === 'stdio';
  return (
    <form
      className="mcp-form surface-box"
      onSubmit={async (ev) => {
        ev.preventDefault();
        setSaving(true);
        try {
          await props.onSave({ ...e, args: lines(args), env: pairs(env, '='), headers: pairs(headers, ':') });
        } finally {
          setSaving(false);
        }
      }}
    >
      <div className="fields">
        <label className="field">
          <span className="field-label">Id</span>
          <input value={e.id} disabled={!props.adding} placeholder="roblox-studio" onChange={(ev) => set({ id: ev.target.value.trim() })} required />
          <span className="hint">Letters, digits, dots and dashes. Agents see the server under this name.</span>
        </label>
        <label className="field">
          <span className="field-label">Name</span>
          <input value={e.label} placeholder="Roblox Studio" onChange={(ev) => set({ label: ev.target.value })} required />
        </label>
      </div>
      <label className="field">
        <span className="field-label">What it is for</span>
        <textarea rows={3} value={e.description} onChange={(ev) => set({ description: ev.target.value })} placeholder="Planners read this to decide which cards can use the server, so say what it can and cannot do." />
      </label>
      <div className="fields">
        <label className="field">
          <span className="field-label">How it runs</span>
          <select value={e.transport} onChange={(ev) => set({ transport: ev.target.value as 'stdio' | 'http', ...(ev.target.value === 'http' ? { hosting: 'shared' as const } : {}) })}>
            <option value="stdio">A command on this machine (stdio)</option>
            <option value="http">A server that is already running (HTTP)</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Shared or per card</span>
          <select value={e.hosting} disabled={!stdio} onChange={(ev) => set({ hosting: ev.target.value as 'shared' | 'per-session' })}>
            <option value="shared">Shared: the harness runs one copy for every agent</option>
            <option value="per-session">Per card: each session starts its own copy</option>
          </select>
        </label>
      </div>
      {stdio ? (
        <>
          <label className="field">
            <span className="field-label">Command</span>
            <input value={e.command ?? ''} placeholder="node" onChange={(ev) => set({ command: ev.target.value })} />
          </label>
          <label className="field">
            <span className="field-label">Arguments (one per line)</span>
            <textarea rows={3} value={args} onChange={(ev) => setArgs(ev.target.value)} />
            <span className="hint">{'{card}'} and {'{worktree}'} are filled in for per-card servers.</span>
          </label>
          <label className="field">
            <span className="field-label">Environment (NAME=value, one per line)</span>
            <textarea rows={3} value={env} onChange={(ev) => setEnv(ev.target.value)} />
            <span className="hint">Stored in the harness's database, not given to agents. Provider keys from the harness's own environment are never passed on.</span>
          </label>
        </>
      ) : (
        <>
          <label className="field">
            <span className="field-label">URL</span>
            <input value={e.url ?? ''} placeholder="http://127.0.0.1:8123/mcp" onChange={(ev) => set({ url: ev.target.value })} />
          </label>
          <label className="field">
            <span className="field-label">Headers (Name: value, one per line)</span>
            <textarea rows={2} value={headers} onChange={(ev) => setHeaders(ev.target.value)} />
          </label>
        </>
      )}
      <div className="fields">
        <label className="field">
          <span className="field-label">Version</span>
          <input value={e.version ?? ''} placeholder="3.4.3" onChange={(ev) => set({ version: ev.target.value })} />
          <span className="hint">Shown beside the server. Pin it: some servers and their plugins must match exactly.</span>
        </label>
        <label className="field">
          <span className="field-label">Install command</span>
          <input value={e.install ?? ''} placeholder="npm install --prefix mcp/_installed …" onChange={(ev) => set({ install: ev.target.value })} />
          <span className="hint">Runs from the harness folder when you press Install. Only this text is ever run.</span>
        </label>
      </div>
      <label className="field">
        <span className="field-label">Told to agents that may use it</span>
        <textarea rows={2} value={e.usage ?? ''} onChange={(ev) => set({ usage: ev.target.value })} />
      </label>
      <div className="row">
        <label className="toggle-row">
          <span className="switch"><input type="checkbox" checked={e.exclusive} onChange={(ev) => set({ exclusive: ev.target.checked })} /><span /></span>
          <span className="toggle-text"><span className="field-label">One change at a time</span><span className="hint">It drives one shared real thing (an open place), so tools that change it are served in turn.</span></span>
        </label>
        <label className="toggle-row">
          <span className="switch"><input type="checkbox" checked={e.autoStart} onChange={(ev) => set({ autoStart: ev.target.checked })} /><span /></span>
          <span className="toggle-text"><span className="field-label">Start with the harness</span><span className="hint">Otherwise it starts the first time a board switches it on or an agent uses it.</span></span>
        </label>
      </div>
      <div className="row">
        <button type="submit" disabled={saving}>{saving ? 'Saving…' : props.adding ? 'Add server' : 'Save'}</button>
        <button type="button" className="ghost" onClick={props.onCancel}>Cancel</button>
        {!props.adding && <span className="hint">A running server keeps its old settings until you press Restart.</span>}
      </div>
    </form>
  );
}

/** One server in the library: its state, what it offers, and the operator's calls on its tools. */
function ServerRow(props: { view: McpServerView; busy: string | null; onAct: (action: 'start' | 'stop' | 'restart' | 'refresh' | 'install') => void; onEdit: () => void; onRemove: () => void; onKinds: (kinds: Record<string, 'read' | 'write'>) => void; onAllow: (allow: string[]) => void }) {
  const { view: v } = props;
  const e = v.entry;
  const b = (a: string) => props.busy === `${e.id}:${a}`;
  return (
    <section className="mcp-card surface-box">
      <div className="row nowrap mcp-card-head">
        <strong>{e.label}</strong>
        <code className="muted small">{e.id}</code>
        <ServerState view={v} />
        {e.version && <span className="badge" title="Pinned version">v{e.version}</span>}
        {e.builtin && <span className="badge" title="Ships with the harness: it can be edited but not removed">built in</span>}
        <span className="badge">{e.hosting === 'shared' ? 'shared' : 'per card'}</span>
        <span className="spacer" />
        {!v.installed && e.install && <button className="small-btn" disabled={!!props.busy} onClick={() => props.onAct('install')}>{b('install') ? 'Installing…' : 'Install'}</button>}
        {e.hosting === 'shared' && v.installed && v.state !== 'running' && v.state !== 'starting' && <button className="ghost small-btn" disabled={!!props.busy} onClick={() => props.onAct('start')}>Start</button>}
        {v.state === 'running' && (
          <>
            <button className="ghost small-btn" disabled={!!props.busy} onClick={() => props.onAct('refresh')} title="Ask the server for its tools again">Refresh tools</button>
            <button className="ghost small-btn" disabled={!!props.busy} onClick={() => props.onAct('restart')}>Restart</button>
            <button className="ghost small-btn" disabled={!!props.busy} onClick={() => props.onAct('stop')}>Stop</button>
          </>
        )}
        <button className="ghost small-btn" onClick={props.onEdit}>Edit</button>
        {!e.builtin && <button className="ghost small-btn" onClick={props.onRemove}>Remove</button>}
      </div>
      <p className="muted small">{e.description || 'No description.'}</p>
      {v.state === 'error' && v.error && <p className="error-text small">{v.error}</p>}
      {e.transport === 'stdio' && <p className="hint"><code>{[e.command, ...(e.args ?? [])].join(' ')}</code></p>}
      {v.tools.length > 0 && (
        <details className="mcp-tools-box">
          <summary>{v.tools.filter((t) => t.offered !== false).length} of {v.tools.length} tools offered to agents · {v.calls} call{v.calls === 1 ? '' : 's'} served</summary>
          <p className="hint">Every tool an agent is offered costs context on every step, so only the ones you leave <em>shown</em> are listed to agents (the others cannot be called). Read only access allows the tools marked <em>reads</em>; the server's own hint decides unless you click that mark to overrule it.</p>
          <div className="row">
            <button className="ghost small-btn" onClick={() => props.onAllow([])} disabled={v.tools.every((t) => t.offered !== false)}>Show all tools</button>
            <button className="ghost small-btn" onClick={() => props.onAllow(v.tools.filter((t) => mcpToolIsRead(e, t)).map((t) => t.name))}>Only the tools that read</button>
          </div>
          <ul className="mcp-tools">
            {v.tools.map((t) => {
              const read = mcpToolIsRead(e, t);
              const own = e.toolKinds[t.name];
              const shown = t.offered !== false;
              const offeredNames = v.tools.filter((x) => x.offered !== false).map((x) => x.name);
              return (
                <li key={t.name} title={t.description} className={shown ? '' : 'hidden-tool'}>
                  <button
                    className={`kind ${shown ? 'read' : ''}`}
                    title={shown ? 'Offered to agents; click to hide it' : 'Hidden from agents; click to offer it'}
                    onClick={() => {
                      const next = shown ? offeredNames.filter((n) => n !== t.name) : [...offeredNames, t.name];
                      // Everything offered again means no allowlist (saved as empty, which overrides a shipped list).
                      props.onAllow(next.length === v.tools.length ? [] : next);
                    }}
                  >
                    {shown ? 'shown' : 'hidden'}
                  </button>
                  <code>{t.name}</code>
                  <button
                    className={`kind ${read ? 'read' : 'write'} ${own ? 'overridden' : ''}`}
                    title={own ? 'Your call; click to go back to the server\'s hint' : 'The server\'s hint; click to overrule it'}
                    onClick={() => {
                      const { [t.name]: _, ...rest } = e.toolKinds;
                      props.onKinds(own ? rest : { ...rest, [t.name]: read ? 'write' : 'read' });
                    }}
                  >
                    {read ? 'reads' : 'changes'}
                  </button>
                </li>
              );
            })}
          </ul>
        </details>
      )}
      {v.log.length > 0 && (
        <details className="mcp-tools-box">
          <summary>Server log (last {v.log.length} lines)</summary>
          <pre className="mcp-log">{v.log.join('\n')}</pre>
        </details>
      )}
    </section>
  );
}

/** Settings → MCP: the machine's library of servers (shared by every board; each board switches them on in its MCP tab). */
export function McpLibrary(props: { onError: (m: string) => void }) {
  const [servers, setServers] = useState<McpServerView[] | null>(null);
  const [editing, setEditing] = useState<{ entry: McpLibraryEntry; adding: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const reload = useCallback(() => api.mcpServers().then(setServers, (e: Error) => props.onError(e.message)), []);
  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 3000);
    return () => clearInterval(t);
  }, [reload]);

  async function save(entry: McpLibraryEntry, adding: boolean) {
    try {
      if (adding) await api.mcpAdd(entry);
      else await api.mcpSave(entry.id, entry);
      setEditing(null);
      await reload();
    } catch (err) {
      props.onError((err as Error).message);
    }
  }
  async function act(id: string, action: 'start' | 'stop' | 'restart' | 'refresh' | 'install') {
    setBusy(`${id}:${action}`);
    try {
      if (action === 'install') {
        const r = await api.mcpInstall(id);
        if (!r.ok) props.onError(`Install failed:\n${r.output.slice(-600)}`);
        else await api.mcpAction(id, 'start').catch(() => {});
      } else await api.mcpAction(id, action);
    } catch (err) {
      props.onError((err as Error).message);
    } finally {
      setBusy(null);
      void reload();
    }
  }

  return (
    <>
      <p className="hint">
        MCP servers installed or linked for this machine. A <strong>shared</strong> server runs once and every agent reaches it through the harness, which checks each call
        against the board's access settings (MCP tab); a <strong>per card</strong> server is started by each card's own session. Boards switch servers on in their MCP tab.
      </p>
      <div className="row">
        <button className="small-btn" onClick={() => setEditing({ entry: BLANK, adding: true })}>Add a server</button>
        <span className="muted small">Paste a command you would put in an MCP client's config, or point at one that is already running.</span>
      </div>
      {editing && (
        <EntryForm
          key={editing.entry.id || 'new'}
          initial={editing.entry}
          adding={editing.adding}
          onSave={(entry) => save(entry, editing.adding)}
          onCancel={() => setEditing(null)}
        />
      )}
      {(servers ?? []).map((v) => (
        <ServerRow
          key={v.entry.id}
          view={v}
          busy={busy}
          onAct={(a) => void act(v.entry.id, a)}
          onEdit={() => setEditing({ entry: v.entry, adding: false })}
          onRemove={() => {
            if (!confirm(`Remove ${v.entry.label} from the library? Boards that use it switch it off.`)) return;
            api.mcpRemove(v.entry.id).then(reload, (e: Error) => props.onError(e.message));
          }}
          onKinds={(kinds) => void save({ ...v.entry, toolKinds: kinds }, false)}
          onAllow={(allow) => void save({ ...v.entry, toolAllow: allow }, false)}
        />
      ))}
      {servers && !servers.length && <p className="muted">Nothing in the library yet.</p>}
    </>
  );
}
