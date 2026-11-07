import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, type Settings, type ToolGrant } from '@mh/core';
import { api } from './api.ts';
import { Field, NumField, Toggle } from './SettingsFields.tsx';

/** One tool grant: who may give it, and the MCP server command it runs. Saved when a field loses focus. */
function GrantEditor(props: { name: string; grant: ToolGrant; status?: { installed: boolean; installable: boolean }; installing: boolean; onInstall: () => void; onSave: (g: ToolGrant) => void; onRemove?: () => void }) {
  const { grant } = props;
  const [command, setCommand] = useState(grant.command);
  const [args, setArgs] = useState(grant.args.join(' '));
  useEffect(() => {
    setCommand(grant.command);
    setArgs(grant.args.join(' '));
  }, [grant.command, grant.args]);
  const commit = () => {
    const parsed = args.trim() ? args.trim().split(/\s+/) : [];
    if (command !== grant.command || parsed.join('\u0000') !== grant.args.join('\u0000')) props.onSave({ ...grant, command: command.trim(), args: parsed });
  };
  return (
    <div className="grant surface-box">
      <div className="row">
        <strong>{grant.label}</strong> <code className="muted small">grant-{props.name}</code>
        {props.status && (props.status.installed ? <span className="badge approve">installed</span> : <span className="badge" title={`\`${grant.command}\` isn't on the daemon's PATH`}>not installed</span>)}
        {props.status && !props.status.installed && props.status.installable && (
          <button className="small-btn" disabled={props.installing} onClick={props.onInstall} title={`Runs on this machine, with your permissions: ${grant.install}`}>{props.installing ? 'Installing…' : 'Install'}</button>
        )}
        <span className="spacer" />
        <select value={grant.mode} aria-label={`${grant.label} mode`} onChange={(e) => props.onSave({ ...grant, mode: e.target.value as ToolGrant['mode'] })}>
          <option value="off">Off</option>
          <option value="approval">Needs your approval</option>
          <option value="auto">Given when asked</option>
        </select>
        {props.onRemove && <button className="ghost small-btn" onClick={props.onRemove}>Remove</button>}
      </div>
      <p className="hint">{grant.description}</p>
      <div className="fields">
        <Field label="Command" hint="Started as a local MCP server for the card's session." def={DEFAULT_SETTINGS.grants[props.name]?.command || 'none'}>
          <input value={command} onChange={(e) => setCommand(e.target.value)} onBlur={commit} placeholder="npx" aria-label={`${grant.label} command`} />
        </Field>
        <Field label="Install command" hint="Run on this machine, with your permissions, only when you approve an install or click Install. Agents never supply it.">
          <input defaultValue={grant.install ?? ''} key={grant.install} onBlur={(e) => e.target.value !== (grant.install ?? '') && props.onSave({ ...grant, install: e.target.value.trim() || undefined })} aria-label={`${grant.label} install command`} />
        </Field>
        <Field label="Arguments" hint="Space-separated. {card} and {worktree} are filled in per card.">
          <input value={args} onChange={(e) => setArgs(e.target.value)} onBlur={commit} aria-label={`${grant.label} arguments`} />
        </Field>
      </div>
    </div>
  );
}

/** Settings → Tools & review (master plan Phases 6.1, 6.4, 6.5): review, best-of-N, tool grants, and what agents proposed. */
export function ToolsTab(props: { boardId: string; settings: Settings; save: (patch: Partial<Settings>) => void; onError: (m: string) => void }) {
  const { settings, save } = props;
  const [tools, setTools] = useState<Record<string, { installed: boolean; installable: boolean }>>({});
  const [installing, setInstalling] = useState<string | null>(null);
  const refreshTools = () => api.tools(props.boardId).then((l) => setTools(Object.fromEntries(l.map((t) => [t.name, t]))), () => {});
  useEffect(() => void refreshTools(), [props.boardId, settings.grants]);
  async function install(name: string) {
    setInstalling(name);
    try {
      const r = await api.installTool(props.boardId, name);
      if (!r.ok) props.onError(`Install did not finish cleanly: ${r.output.trim().split('\n').slice(-3).join(' ')}`);
    } catch (err) {
      props.onError((err as Error).message);
    } finally {
      setInstalling(null);
      void refreshTools();
    }
  }
  const D = DEFAULT_SETTINGS;
  const [newGrant, setNewGrant] = useState('');
  const saveGrant = (name: string, g: ToolGrant) => save({ grants: { ...settings.grants, [name]: g } });
  const removeGrant = (name: string) => {
    const next = { ...settings.grants };
    delete next[name];
    save({ grants: next });
  };
  return (
    <>
      <h3>Review</h3>
      <Toggle
        label="Hold cards in Review for me"
        hint="A finished card waits until you approve it or ask for changes (the card panel, or VS Code), instead of going to an agent reviewer. A verdict you give anyway always counts."
        checked={settings.humanReview}
        def={D.humanReview}
        onChange={(v) => save({ humanReview: v })}
      />

      <h3>Best-of-N</h3>
      <p className="hint">Run a big card on several agents at once, each on its own branch; Kev scores their changes and the best one goes on to landing. It costs N times the tokens, so it is off by default and only applies to cards of at least the complexity below, when two different agents are free.</p>
      <Toggle label="Race big cards" checked={settings.bestOfN.enabled} def={D.bestOfN.enabled} onChange={(v) => save({ bestOfN: { ...settings.bestOfN, enabled: v } })} />
      <div className="fields">
        <NumField label="Candidates" hint="Agents racing each card (2 or 3)." value={settings.bestOfN.n} def={D.bestOfN.n} min={2} max={3} onSave={(n) => save({ bestOfN: { ...settings.bestOfN, n } })} />
        <NumField label="From complexity" hint="Kev's 0–4 scale: 2 is a medium card." value={settings.bestOfN.minComplexity} def={D.bestOfN.minComplexity} min={0} max={4} step={0.5} onSave={(n) => save({ bestOfN: { ...settings.bestOfN, minComplexity: n } })} />
      </div>

      <h3>Tool grants</h3>
      <p className="hint">Extra MCP servers a card's agent can be given, e.g. a browser to check a UI. An orchestrator can set them when it plans a card, and an agent can ask for one for its own card. A grant set to approval holds the card until you decide, in Approvals.</p>
      <div className="grants">
        {Object.entries(settings.grants).map(([name, g]) => (
          <GrantEditor key={name} name={name} grant={g} status={tools[name]} installing={installing === name} onInstall={() => void install(name)} onSave={(x) => saveGrant(name, x)} onRemove={D.grants[name] ? undefined : () => removeGrant(name)} />
        ))}
      </div>
      <div className="row">
        <input value={newGrant} onChange={(e) => setNewGrant(e.target.value)} placeholder="name of a new grant, e.g. docs" aria-label="New grant name" />
        <button
          className="ghost"
          disabled={!/^[a-z0-9][a-z0-9_-]{0,23}$/.test(newGrant) || !!settings.grants[newGrant]}
          onClick={() => {
            saveGrant(newGrant, { label: newGrant, description: 'A custom tool.', command: '', args: [], env: {}, mode: 'off' });
            setNewGrant('');
          }}
        >
          Add
        </button>
      </div>

      <h3>Approvals</h3>
      <Toggle label="Apply new-agent requests without asking" hint="Agents allowed to spawn_agent (Agents → Permissions) get their agent at once. MCP servers and skills always wait for you." checked={settings.autoApproveSpawn} def={D.autoApproveSpawn} onChange={(v) => save({ autoApproveSpawn: v })} />
      <Toggle label="Fast lane words notifications" hint="A short plain sentence for each request, from the fast lane (falls back to the plain text)." checked={settings.notificationText} def={D.notificationText} onChange={(v) => save({ notificationText: v })} />

      <h3>Approved for this board</h3>
      {settings.mcpServers.length === 0 && settings.skills.length === 0 && <p className="muted small">Nothing yet. MCP servers and skills agents propose appear here once you approve them.</p>}
      {settings.mcpServers.length > 0 && (
        <div className="surface-box">
          <span className="muted small">MCP servers (every new session gets these)</span>
          <ul className="plain">
            {settings.mcpServers.map((m) => (
              <li key={m.name}>
                <strong>{m.name}</strong> <code className="small">{m.url ?? [m.command, ...(m.args ?? [])].join(' ')}</code>{' '}
                <button className="link" onClick={() => save({ mcpServers: settings.mcpServers.filter((x) => x.name !== m.name) })}>remove</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {settings.skills.length > 0 && (
        <div className="surface-box">
          <span className="muted small">Skills (worker prompts carry these)</span>
          <ul className="plain">
            {settings.skills.map((s) => (
              <li key={s.name}>
                <details>
                  <summary><strong>{s.name}</strong> <span className="muted">{s.description}</span></summary>
                  <pre className="skill-body">{s.body}</pre>
                </details>{' '}
                <button className="link" onClick={() => save({ skills: settings.skills.filter((x) => x.name !== s.name) })}>remove</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
