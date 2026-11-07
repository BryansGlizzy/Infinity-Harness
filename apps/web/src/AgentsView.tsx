import { useEffect, useState, type ReactNode } from 'react';
import { CARD_ROLES, delegationTargets, effectiveAgents, type AgentProfile, type CardRole, type Settings } from '@mh/core';
import { api, type ActiveSession, type AgentPrior, type ModelCatalog, type PoolWithStatus } from './api.ts';
import { HARNESS_LABEL, ROLE_LABEL, shortModel } from './agentInfo.ts';

/** A model picker for one pool: the models its harness offers, plus "pool default" and any saved value not listed. */
export function ModelSelect(props: { pool?: PoolWithStatus; models: ModelCatalog; value: string; onChange: (model: string) => void; allowDefault?: boolean; label?: string }) {
  const { pool, value } = props;
  const entry = pool ? props.models[pool.id] : undefined;
  const options = entry?.models ?? [];
  return (
    <select value={value} onChange={(e) => props.onChange(e.target.value)} aria-label={props.label ?? 'Model'} title={entry?.error}>
      {props.allowDefault !== false && <option value="">pool default · {pool ? shortModel(pool.model) : '?'}</option>}
      {value && !options.some((m) => m.id === value) && <option value={value}>{value}</option>}
      {options.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      {!entry && <option disabled>discovering models…</option>}
    </select>
  );
}

/** The reasoning (thinking / effort) levels a pool's harness publishes, plus "harness default". */
function ReasoningSelect(props: { pool?: PoolWithStatus; models: ModelCatalog; value: string; onChange: (level: string) => void }) {
  const r = props.pool ? props.models[props.pool.id]?.reasoning : undefined;
  if (r === undefined) return <select disabled aria-label="Reasoning"><option>reasoning…</option></select>;
  if (r === null) return <span className="muted small" title="This harness publishes no reasoning setting">no reasoning setting</span>;
  return (
    <select value={props.value} onChange={(e) => props.onChange(e.target.value)} aria-label="Reasoning" title={`The harness's "${r.configId}" setting`}>
      <option value="">default{r.current ? ` (${r.current})` : ''}</option>
      {props.value && !r.levels.some((l) => l.id === props.value) && <option value={props.value}>{props.value} (not offered)</option>}
      {r.levels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
    </select>
  );
}

/** The delegation tree the agents form, starting at the orchestrators (master plan Phase 3.5). */
function Hierarchy({ agents, pools }: { agents: AgentProfile[]; pools: PoolWithStatus[] }) {
  const label = (a: AgentProfile) => shortModel(a.model || pools.find((p) => p.id === a.poolId)?.model || '');
  const node = (a: AgentProfile, seen: string[]): ReactNode => {
    const kids = a.role === 'worker' || seen.includes(a.id) ? [] : delegationTargets(a, a.role, agents);
    return (
      <li key={`${seen.join('>')}>${a.id}`}>
        <span className={`role-tag ${a.role}`}>{ROLE_LABEL[a.role]}</span> <strong>{a.id}</strong>{' '}
        <span className="muted">
          {pools.find((p) => p.id === a.poolId)?.label ?? a.poolId} · {label(a)}
          {a.reasoning ? ` · ${a.reasoning}` : ''}
        </span>
        {kids.length > 0 && <ul>{kids.map((k) => node(k, [...seen, a.id]))}</ul>}
      </li>
    );
  };
  const roots = agents.filter((a) => a.enabled && a.role === 'orchestrator');
  if (!roots.length) return <p className="muted small">No enabled orchestrator: goals fall back to the first open subscription pool.</p>;
  return <ul className="hierarchy">{roots.map((r) => node(r, []))}</ul>;
}

/** The three skills a model family is best at, from its routing prior. */
function Strengths({ prior }: { prior?: AgentPrior }) {
  if (!prior) return null;
  const top = Object.entries(prior.prior.skills)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  return (
    <div className="strengths" title={`Routing prior: family ${prior.prior.family}, handles complexity up to ${prior.prior.capability} of 4`}>
      <span className="muted small">{prior.prior.family}</span>
      {top.map(([skill, v]) => (
        <span key={skill} className="strength">
          {skill} <b>{Math.round(v * 100)}</b>
        </span>
      ))}
      {prior.prior.frontend >= 0.8 && <span className="strength">front-end <b>{Math.round(prior.prior.frontend * 100)}</b></span>}
      {prior.prior.noWeb && <span className="strength off">no web</span>}
    </div>
  );
}

function PoolState({ pool, sessions }: { pool?: PoolWithStatus; sessions: ActiveSession[] }) {
  if (!pool) return <span className="chip pool halted"><span className="dot" />not configured</span>;
  const top = pool.status.windows.reduce((a, w) => (w.pct > (a?.pct ?? -1) ? w : a), pool.status.windows[0]);
  const working = sessions.filter((s) => s.poolId === pool.id && s.state === 'working').length;
  return (
    <span className={`chip pool ${pool.status.state}`} title={`${pool.label}: ${pool.status.state}`}>
      <span className="dot" />
      {pool.status.state}
      {top && <span className="muted">· {Math.round(top.pct)}%</span>}
      {working > 0 && <span className="running">· {working} working</span>}
    </span>
  );
}

export function AgentsView(props: {
  boardId: string;
  settings: Settings | null;
  pools: PoolWithStatus[];
  sessions: ActiveSession[];
  models: ModelCatalog;
  onSettings: (s: Settings) => void;
  onRefreshModels: () => void;
  onError: (m: string) => void;
  /** Just created the board: say what to set up first. */
  intro?: boolean;
  onDismissIntro?: () => void;
}) {
  const { pools, models, settings } = props;
  const [priors, setPriors] = useState<AgentPrior[]>([]);
  useEffect(() => {
    let alive = true;
    api.priors(props.boardId).then((r) => alive && setPriors(r), () => {});
    return () => {
      alive = false;
    };
  }, [props.boardId, settings]);

  if (!settings) return <div className="page"><p className="muted">Loading…</p></div>;

  async function save(patch: Partial<Settings>) {
    try {
      props.onSettings(await api.updateSettings(props.boardId, patch));
    } catch (err) {
      props.onError((err as Error).message);
    }
  }

  const agents = effectiveAgents(settings, pools);
  const commit = (next: AgentProfile[]) => save({ agents: next.map(({ implicit: _, ...a }) => a) });
  const update = (i: number, patch: Partial<AgentProfile>) => {
    const before = agents[i]!;
    let next = agents.map((a, j) => (j === i ? { ...a, ...patch } : a));
    if (patch.id !== undefined && patch.id !== before.id) next = next.map((a) => ({ ...a, delegatesTo: a.delegatesTo.map((t) => (t === before.id ? patch.id! : t)) }));
    if (patch.role === 'worker') next[i] = { ...next[i]!, delegatesTo: [] };
    if (patch.role === 'orchestrator') next = next.map((a) => ({ ...a, delegatesTo: a.delegatesTo.filter((t) => t !== before.id) }));
    if (patch.poolId !== undefined && patch.poolId !== before.poolId) next[i] = { ...next[i]!, model: '', reasoning: '' };
    void commit(next);
  };
  const remove = (i: number) => {
    const gone = agents[i]!.id;
    void commit(agents.filter((_, j) => j !== i).map((a) => ({ ...a, delegatesTo: a.delegatesTo.filter((t) => t !== gone) })));
  };
  const add = (role: CardRole = 'worker') => {
    let n = agents.length + 1;
    while (agents.some((a) => a.id === `agent-${n}`)) n++;
    void commit([...agents, { id: `agent-${n}`, poolId: pools[0]?.id ?? '', model: '', role, delegatesTo: [], enabled: true }]);
  };
  const orchestrators = agents.filter((a) => a.enabled && a.role === 'orchestrator').length;

  return (
    <div className="page agents-page">
      {props.intro && (
        <div className="intro">
          <div className="row">
            <strong>New board: set up your agents first.</strong>
            <span className="spacer" />
            {props.onDismissIntro && <button className="ghost small-btn" onClick={props.onDismissIntro}>Got it</button>}
          </div>
          <ol>
            <li>Below: who plans (<strong>orchestrator</strong>), who breaks big chunks down (<strong>lead</strong>) and who codes (<strong>worker</strong>), each with a pool, a model and a reasoning level. Every pool already has a default worker.</li>
            <li>Two or more enabled orchestrators plan each goal together as a <strong>council</strong>.</li>
            <li>Open <strong>Settings → Refinery</strong> and set the test command every card must pass before it lands.</li>
            <li>Then type a goal in the top bar.</li>
          </ol>
        </div>
      )}

      <div className="page-head">
        <div>
          <h2>Agents</h2>
          <p className="muted small">
            An agent is a pool plus a model, a reasoning level and a role. Agents on one pool share its quota and slots. Orchestrators and leads plan; their cards go to the agents
            ticked under them (none ticked: any worker, and for the orchestrator any lead too).
            {orchestrators >= 2 && <> <strong>{orchestrators} orchestrators are enabled: goals are planned by a council.</strong></>}
          </p>
        </div>
        <div className="row">
          <button className="ghost small-btn" onClick={props.onRefreshModels} title="Ask each harness again which models your login offers">Refresh models</button>
          <button className="ghost small-btn" onClick={() => add('orchestrator')}>Add orchestrator</button>
          <button className="ghost small-btn" onClick={() => add('lead')}>Add lead</button>
          <button className="small-btn" onClick={() => add('worker')}>Add worker</button>
        </div>
      </div>

      <div className="agent-columns">
      {CARD_ROLES.map((role) => {
        const group = agents.map((a, i) => ({ a, i })).filter(({ a }) => a.role === role);
        if (!group.length) return null;
        return (
          <section key={role} className="agent-group">
            <h3>{ROLE_LABEL[role]}s</h3>
            <div className="agent-grid">
              {group.map(({ a, i }) => {
                const pool = pools.find((p) => p.id === a.poolId);
                const targets = agents.filter((t) => t.id !== a.id && t.role !== 'orchestrator');
                return (
                  <div key={`${a.id}-${i}`} className={`agent-card ${a.role} ${a.enabled ? '' : 'disabled'}`}>
                    <div className="row nowrap">
                      <span className={`role-tag ${a.role}`}>{ROLE_LABEL[a.role]}</span>
                      <input
                        className="agent-id"
                        defaultValue={a.id}
                        key={a.id}
                        aria-label="Agent name"
                        onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== a.id && update(i, { id: e.target.value.trim() })}
                        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                      />
                      {a.implicit && <span className="muted small" title="Added because this pool has no worker or lead of its own; editing saves it">default</span>}
                      <label className="switch" title={a.enabled ? 'Enabled' : 'Disabled'}>
                        <input type="checkbox" checked={a.enabled} onChange={(e) => update(i, { enabled: e.target.checked })} aria-label={`${a.id} enabled`} />
                        <span />
                      </label>
                      <button className="ghost icon-btn" onClick={() => remove(i)} aria-label={`Remove ${a.id}`} title="Remove">✕</button>
                    </div>
                    <div className="agent-fields">
                      <label>
                        Role
                        <select value={a.role} onChange={(e) => update(i, { role: e.target.value as CardRole })}>
                          {CARD_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                        </select>
                      </label>
                      <label>
                        Pool
                        <select value={a.poolId} onChange={(e) => update(i, { poolId: e.target.value })}>
                          {!pool && <option value={a.poolId}>{a.poolId} (not configured)</option>}
                          {pools.map((p) => <option key={p.id} value={p.id}>{p.label} · {HARNESS_LABEL[p.harness] ?? p.harness}</option>)}
                        </select>
                      </label>
                      <label>
                        Model
                        <ModelSelect pool={pool} models={models} value={a.model} onChange={(model) => update(i, { model })} />
                      </label>
                      <label>
                        Reasoning
                        <ReasoningSelect pool={pool} models={models} value={a.reasoning ?? ''} onChange={(reasoning) => update(i, { reasoning })} />
                      </label>
                    </div>
                    <div className="row">
                      <PoolState pool={pool} sessions={props.sessions} />
                      <Strengths prior={priors.find((p) => p.agentId === a.id)} />
                    </div>
                    {a.role !== 'worker' && (
                      <div className="delegates">
                        <span className="muted small">Delegates to {a.delegatesTo.length ? '' : '(any)'}</span>
                        <div className="row">
                          {targets.map((t) => (
                            <label key={t.id} className={`pill-check ${a.delegatesTo.includes(t.id) ? 'on' : ''}`}>
                              <input
                                type="checkbox"
                                checked={a.delegatesTo.includes(t.id)}
                                onChange={(e) => update(i, { delegatesTo: e.target.checked ? [...a.delegatesTo, t.id] : a.delegatesTo.filter((x) => x !== t.id) })}
                              />
                              {t.id}
                            </label>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
      </div>

      <div className="agent-columns">
      <section className="agent-group">
        <h3>Hierarchy</h3>
        <div className="surface-box">
          <Hierarchy agents={agents} pools={pools} />
        </div>
      </section>

      <section className="agent-group">
        <h3>Permissions</h3>
        <p className="muted small">What each role may do with the board's tools. Workers can't create cards by default. Requests to spawn agents, add MCP servers or skills, and tool grants that need approval wait for you in Approvals.</p>
        <table className="pools-table surface-box">
          <thead><tr><th>Role</th><th>Create cards</th><th>Add dependencies</th><th title="spawn_agent: add an agent to the board">Spawn agents</th><th title="propose_mcp and propose_skill: always wait for you">Propose MCP / skills</th><th title="request_grant, and grants on cards it creates">Request tool grants</th></tr></thead>
          <tbody>
            {CARD_ROLES.map((role) => (
              <tr key={role}>
                <td><span className={`role-tag ${role}`}>{ROLE_LABEL[role]}</span></td>
                {(['canCreateCards', 'canAddDependencies', 'canSpawnAgents', 'canInstallMcp', 'canRequestGrants'] as const).map((key) => (
                  <td key={key}>
                    <input
                      type="checkbox"
                      aria-label={`${role} ${key}`}
                      checked={settings.permissions[role][key] ?? false}
                      onChange={(e) => save({ permissions: { ...settings.permissions, [role]: { ...settings.permissions[role], [key]: e.target.checked } } })}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      </div>
    </div>
  );
}
