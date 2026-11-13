import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { CARD_ROLES, delegationTargets, effectiveAgents, type AgentProfile, type CardRole, type Settings } from '@ih/core';
import { api, type ActiveSession, type AgentPrior, type ModelCatalog, type PoolWithStatus, type SystemHarnessId, type SystemHarnessStatus } from './api.ts';
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

/**
 * Is this pool's model answering? Shows the last check (endpoint pools are checked every minute, harnesses on request),
 * a Test button to check now, and, for a pool taken out of rotation after its endpoint stopped answering, the reason and
 * the button that puts it back (it stays out until you do).
 */
function PoolHealthLine({ pool, onChanged, onError }: { pool?: PoolWithStatus; onChanged: () => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState<'test' | 'restore' | null>(null);
  if (!pool) return null;
  const h = pool.health;
  async function run(kind: 'test' | 'restore') {
    setBusy(kind);
    try {
      await (kind === 'test' ? api.testPool(pool!.id) : api.restorePool(pool!.id));
      onChanged();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const at = h?.checkedAt ? new Date(h.checkedAt).toLocaleTimeString() : null;
  const what = h?.checked === 'harness' ? 'harness ready' : 'online';
  const label = h?.ejected ? 'out of rotation' : h?.reachable === 'online' ? `${what}${h.latencyMs !== null ? ` · ${h.latencyMs} ms` : ''}` : h?.reachable === 'offline' ? 'no response' : 'not checked';
  const tone = h?.ejected || h?.reachable === 'offline' ? 'bad' : h?.reachable === 'online' ? 'ok' : 'idle';
  return (
    <div className="pool-health">
      <span className={`health-chip ${tone}`} title={[h?.detail, at ? `checked ${at}` : 'not checked yet'].filter(Boolean).join(' · ')}>
        <span className="dot" />
        {label}
      </span>
      <button className="ghost small" disabled={busy !== null} onClick={() => void run('test')} title={h?.checked === 'harness' ? 'Starts the harness and asks what it offers' : 'Asks the model endpoint now'}>
        {busy === 'test' ? 'Testing…' : 'Test'}
      </button>
      {h?.ejected && (
        <>
          <button className="small" disabled={busy !== null} onClick={() => void run('restore')} title="It stays out of routing until you do this">
            Put back in rotation
          </button>
          <span className="muted small ejected-why">
            Out since {new Date(h.ejected.since).toLocaleTimeString()}: {h.ejected.reason}. Not held against the model.
          </span>
        </>
      )}
      {!h?.ejected && h?.reachable === 'offline' && <span className="muted small ejected-why">{h.detail}</span>}
    </div>
  );
}

/**
 * Discovers, links, installs, and authenticates the agent harnesses on this machine (Claude Code, Codex, Kimi,
 * Antigravity, OpenCode for NIM & Local LLM, and GitHub CLI for PR landing).
 */
function SystemHarnessesPanel(props: {
  pools: PoolWithStatus[];
  onPoolsChanged?: () => void;
  onRefreshModels: () => void;
  onError: (m: string) => void;
}) {
  const [harnesses, setHarnesses] = useState<SystemHarnessStatus[] | null>(null);
  const [busyId, setBusyId] = useState<SystemHarnessId | null>(null);
  const [busyAction, setBusyAction] = useState<'install' | 'login' | 'env' | 'scan' | null>(null);
  const [installLog, setInstallLog] = useState<{ id: SystemHarnessId; ok: boolean; output: string } | null>(null);
  const [apiKeyOpen, setApiKeyOpen] = useState<SystemHarnessId | null>(null);
  const [apiKeyValue, setApiKeyValue] = useState('');
  const [envOpen, setEnvOpen] = useState(false);
  const [nimKey, setNimKey] = useState('');
  const [nimModel, setNimModel] = useState('deepseek-ai/deepseek-v3.2');
  const [localUrl, setLocalUrl] = useState('');
  const [localModel, setLocalModel] = useState('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const loadHarnesses = useCallback(async (notifyPools = false) => {
    try {
      const list = await api.harnesses();
      setHarnesses(list);
      const oc = list.find((h) => h.id === 'opencode')?.envConfig;
      if (oc) {
        setNimModel((prev) => prev || oc.nimModel || 'deepseek-ai/deepseek-v3.2');
        setLocalUrl((prev) => prev || oc.localBaseUrl || '');
        setLocalModel((prev) => prev || oc.localModel || '');
      }
      if (notifyPools) {
        props.onPoolsChanged?.();
      }
    } catch {
      // daemon may not support /api/harnesses in older mocks
    }
  }, [props]);

  useEffect(() => {
    void loadHarnesses(false);
  }, [loadHarnesses]);

  // Poll while any sign-in flow is active so OAuth/device completion updates automatically.
  const anyActiveFlow = harnesses?.some((h) => h.loginFlow?.active) ?? false;
  useEffect(() => {
    if (!anyActiveFlow) return;
    const t = setInterval(() => {
      void api.harnesses().then((list) => {
        setHarnesses((prev) => {
          const wasActive = prev?.some((h) => h.loginFlow?.active) ?? false;
          const nowActive = list.some((h) => h.loginFlow?.active);
          if (wasActive && !nowActive) {
            props.onPoolsChanged?.();
            props.onRefreshModels();
          }
          return list;
        });
      }, () => {});
    }, 1800);
    return () => clearInterval(t);
  }, [anyActiveFlow, props]);

  if (!harnesses) return null;

  const copyText = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((c) => (c === key ? null : c)), 1600);
  };

  async function handleInstall(id: SystemHarnessId) {
    setBusyId(id);
    setBusyAction('install');
    setInstallLog(null);
    try {
      const r = await api.installHarness(id);
      setInstallLog({ id, ok: r.ok, output: r.output });
      if (!r.ok) props.onError(`Install failed for ${id}: ${r.output.trim().split('\n').slice(-2).join(' ')}`);
      await loadHarnesses(true);
      props.onRefreshModels();
    } catch (err) {
      props.onError((err as Error).message);
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  }

  async function handleLogin(id: SystemHarnessId, opts: { apiKey?: string; mode?: string } = {}) {
    setBusyId(id);
    setBusyAction('login');
    try {
      const r = await api.loginHarness(id, opts);
      setHarnesses((prev) => (prev ? prev.map((h) => (h.id === id ? r.harness : h)) : [r.harness]));
      if (opts.apiKey) {
        setApiKeyOpen(null);
        setApiKeyValue('');
      }
      props.onPoolsChanged?.();
      props.onRefreshModels();
    } catch (err) {
      props.onError((err as Error).message);
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  }

  async function handleCancelLogin(id: SystemHarnessId) {
    try {
      const r = await api.cancelHarnessLogin(id);
      setHarnesses((prev) => (prev ? prev.map((h) => (h.id === id ? r.harness : h)) : [r.harness]));
    } catch (err) {
      props.onError((err as Error).message);
    }
  }

  async function handleSaveEnv() {
    setBusyId('opencode');
    setBusyAction('env');
    try {
      await api.configureHarnessEnv({
        ...(nimKey.trim() ? { nimApiKey: nimKey.trim() } : {}),
        nimModel: nimModel.trim() || 'deepseek-ai/deepseek-v3.2',
        localBaseUrl: localUrl.trim(),
        localModel: localModel.trim(),
      });
      setNimKey('');
      setEnvOpen(false);
      await loadHarnesses(true);
      props.onRefreshModels();
    } catch (err) {
      props.onError((err as Error).message);
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  }

  const readyCount = harnesses.filter((h) => h.installed && (h.auth.status === 'signed_in' || h.auth.status === 'configured')).length;

  return (
    <section className="agent-group harness-system-section">
      <div className="row harness-system-head">
        <div>
          <h3>System Harnesses &amp; Logins</h3>
          <p className="muted small">
            Agents detected on this machine ({readyCount} of {harnesses.length} ready). Install missing CLIs or ACP bridges and sign in directly — newly linked pools appear immediately without restarting the daemon.
          </p>
        </div>
        <span className="spacer" />
        <button
          className="ghost small-btn"
          disabled={busyAction === 'scan'}
          onClick={async () => {
            setBusyAction('scan');
            await loadHarnesses(true);
            setBusyAction(null);
          }}
          title="Re-scan system PATH, credentials, and .env pools"
        >
          {busyAction === 'scan' ? 'Scanning…' : 'Re-scan system'}
        </button>
      </div>

      <div className="harness-status-grid">
        {harnesses.map((h) => {
          const isReady = h.installed && (h.auth.status === 'signed_in' || h.auth.status === 'configured');
          const isBusy = busyId === h.id;
          const activePools = props.pools.filter((p) => h.poolIds.includes(p.id));
          return (
            <div key={h.id} className={`harness-sys-card surface-box ${isReady ? 'ready' : h.installed ? 'needs-auth' : 'missing'}`}>
              <div className="row nowrap harness-sys-card-head">
                <strong>{h.label}</strong>
                <span className="spacer" />
                <span className={`badge ${h.installed ? 'approve' : h.missingParts.length === 1 && h.id === 'codex' ? 'pending' : ''}`}>
                  {h.installed ? 'Installed' : h.missingParts.includes('codex-acp') && !h.missingParts.includes('codex') ? 'Missing bridge' : 'Not installed'}
                </span>
                <span className={`badge ${h.auth.status === 'signed_in' || h.auth.status === 'configured' ? 'approve' : 'pending'}`}>
                  {h.auth.status === 'signed_in'
                    ? 'Signed in'
                    : h.auth.status === 'configured'
                      ? 'Configured'
                      : h.auth.status === 'unconfigured'
                        ? 'Not configured'
                        : 'Needs sign-in'}
                </span>
              </div>

              <p className="muted small harness-sys-desc">{h.description}</p>

              <div className="harness-sys-meta small">
                <div>
                  <span className="muted">Account / Auth: </span>
                  <strong>{h.auth.account ? `${h.auth.account} (${h.auth.detail})` : h.auth.detail ?? '—'}</strong>
                </div>
                <div className="ellipsis" title={h.binaryPath ?? h.installCommand}>
                  <span className="muted">{h.binaryPath ? 'Binary: ' : 'Install cmd: '}</span>
                  <code>{h.binaryPath ?? h.installCommand}</code>
                  {h.version && <span className="muted"> · {h.version}</span>}
                </div>
                {activePools.length > 0 && (
                  <div className="row" style={{ gap: 6, marginTop: 2 }}>
                    <span className="muted">Linked pool{activePools.length > 1 ? 's' : ''}:</span>
                    {activePools.map((p) => (
                      <span key={p.id} className={`chip pool ${p.status.state}`}>
                        <span className="dot" />
                        {p.label}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {h.loginFlow && (h.loginFlow.active || h.loginFlow.url || h.loginFlow.error) && (
                <div className="harness-login-box">
                  <div className="row">
                    <strong>{h.loginFlow.active ? 'Complete sign-in in your browser' : h.loginFlow.error ? 'Sign-in status' : 'Sign-in link ready'}</strong>
                    <span className="spacer" />
                    {h.loginFlow.active && (
                      <button className="ghost small-btn" onClick={() => void handleCancelLogin(h.id)}>
                        Cancel
                      </button>
                    )}
                  </div>
                  {h.loginFlow.code && (
                    <div className="row harness-device-code">
                      <span className="muted small">One-time code:</span>
                      <code>{h.loginFlow.code}</code>
                      <button className="ghost small-btn" onClick={() => copyText(`code-${h.id}`, h.loginFlow!.code!)}>
                        {copiedKey === `code-${h.id}` ? 'Copied!' : 'Copy code'}
                      </button>
                    </div>
                  )}
                  {h.loginFlow.url && (
                    <div className="row">
                      <a className="btn-link" href={h.loginFlow.url} target="_blank" rel="noreferrer">
                        Open Sign-In Page ↗
                      </a>
                      <button className="ghost small-btn" onClick={() => copyText(`url-${h.id}`, h.loginFlow!.url!)}>
                        {copiedKey === `url-${h.id}` ? 'Copied!' : 'Copy link'}
                      </button>
                    </div>
                  )}
                  {h.loginFlow.error && <p className="small error">{h.loginFlow.error}</p>}
                  {h.loginFlow.active && <p className="muted small">Waiting for authentication to finish… This card will update automatically.</p>}
                </div>
              )}

              {installLog?.id === h.id && (
                <div className="harness-login-box">
                  <div className="row">
                    <strong>{installLog.ok ? 'Install finished' : 'Install output'}</strong>
                    <span className="spacer" />
                    <button className="ghost small-btn" onClick={() => setInstallLog(null)}>Dismiss</button>
                  </div>
                  {installLog.output && <pre className="small">{installLog.output.slice(-600)}</pre>}
                </div>
              )}

              {apiKeyOpen === h.id && (
                <div className="harness-login-box">
                  <label className="small">
                    {h.id === 'gh' ? 'Paste GitHub Personal Access Token:' : 'Paste OpenAI API Key:'}
                    <div className="row" style={{ marginTop: 4 }}>
                      <input
                        type="password"
                        value={apiKeyValue}
                        onChange={(e) => setApiKeyValue(e.target.value)}
                        placeholder={h.id === 'gh' ? 'ghp_...' : 'sk-...'}
                        aria-label={`${h.label} API key`}
                      />
                      <button className="small-btn" disabled={!apiKeyValue.trim() || isBusy} onClick={() => void handleLogin(h.id, { apiKey: apiKeyValue })}>
                        {isBusy ? 'Saving…' : 'Save'}
                      </button>
                      <button className="ghost small-btn" onClick={() => { setApiKeyOpen(null); setApiKeyValue(''); }}>
                        Cancel
                      </button>
                    </div>
                  </label>
                </div>
              )}

              {h.id === 'opencode' && envOpen && (
                <div className="harness-login-box">
                  <div className="agent-fields">
                    <label>
                      NVIDIA NIM API Key
                      <input
                        type="password"
                        value={nimKey}
                        onChange={(e) => setNimKey(e.target.value)}
                        placeholder={h.envConfig?.nimApiKeySet ? '•••••••• (already set in .env)' : 'nvapi-...'}
                      />
                    </label>
                    <label>
                      NVIDIA Model
                      <input value={nimModel} onChange={(e) => setNimModel(e.target.value)} placeholder="deepseek-ai/deepseek-v3.2" />
                    </label>
                    <label>
                      Local LLM Base URL
                      <input value={localUrl} onChange={(e) => setLocalUrl(e.target.value)} placeholder="http://127.0.0.1:8000/v1" />
                    </label>
                    <label>
                      Local LLM Model
                      <input value={localModel} onChange={(e) => setLocalModel(e.target.value)} placeholder="qwen3-coder" />
                    </label>
                  </div>
                  <div className="row" style={{ marginTop: 6 }}>
                    <button className="small-btn" disabled={isBusy} onClick={() => void handleSaveEnv()}>
                      {isBusy && busyAction === 'env' ? 'Saving…' : 'Save to .env & Link Pools'}
                    </button>
                    <button className="ghost small-btn" onClick={() => setEnvOpen(false)}>Cancel</button>
                  </div>
                </div>
              )}

              <div className="row harness-sys-actions">
                {!h.installed ? (
                  <>
                    <button className="small-btn" disabled={isBusy} onClick={() => void handleInstall(h.id)} title={`Runs: ${h.installCommand}`}>
                      {isBusy && busyAction === 'install'
                        ? 'Installing…'
                        : h.missingParts.includes('codex-acp') && !h.missingParts.includes('codex')
                          ? 'Install ACP Bridge'
                          : `Install ${h.label}`}
                    </button>
                    <button className="ghost small-btn" onClick={() => copyText(`cmd-${h.id}`, h.installCommand)} title={h.installCommand}>
                      {copiedKey === `cmd-${h.id}` ? 'Copied!' : 'Copy install cmd'}
                    </button>
                  </>
                ) : (
                  <>
                    {h.loginCommand && (
                      <button
                        className={h.auth.status === 'signed_in' ? 'ghost small-btn' : 'small-btn'}
                        disabled={isBusy}
                        onClick={() => void handleLogin(h.id)}
                        title={`Runs: ${h.loginCommand}`}
                      >
                        {isBusy && busyAction === 'login' ? 'Starting sign-in…' : h.auth.status === 'signed_in' ? 'Re-authenticate' : 'Sign in'}
                      </button>
                    )}
                    {h.supportsApiKeyLogin && (
                      <button
                        className="ghost small-btn"
                        onClick={() => setApiKeyOpen(apiKeyOpen === h.id ? null : h.id)}
                      >
                        {h.id === 'gh' ? 'Use token' : 'Use API key'}
                      </button>
                    )}
                    {h.id === 'opencode' && (
                      <button className={h.auth.status === 'configured' ? 'ghost small-btn' : 'small-btn'} onClick={() => setEnvOpen(!envOpen)}>
                        {envOpen ? 'Hide settings' : 'Configure NIM / Local LLM'}
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
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
  /** Reloads the pools (their health changed). */
  onPoolsChanged?: () => void;
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
  const commit = (next: AgentProfile[], more: Partial<Settings> = {}) => save({ agents: next.map(({ implicit: _, ...a }) => a), ...more });
  const weights = settings.agentWeights ?? {};
  const setWeight = (id: string, v: number) => {
    const { [id]: _, ...rest } = weights;
    void save({ agentWeights: v === 1 ? rest : { ...rest, [id]: Math.min(10, Math.max(0, v)) } });
  };
  const update = (i: number, patch: Partial<AgentProfile>) => {
    const before = agents[i]!;
    let next = agents.map((a, j) => (j === i ? { ...a, ...patch } : a));
    if (patch.id !== undefined && patch.id !== before.id) next = next.map((a) => ({ ...a, delegatesTo: a.delegatesTo.map((t) => (t === before.id ? patch.id! : t)) }));
    if (patch.role === 'worker') next[i] = { ...next[i]!, delegatesTo: [] };
    if (patch.role === 'orchestrator') next = next.map((a) => ({ ...a, delegatesTo: a.delegatesTo.filter((t) => t !== before.id) }));
    if (patch.poolId !== undefined && patch.poolId !== before.poolId) next[i] = { ...next[i]!, model: '', reasoning: '' };
    // The weight belongs to the agent, so it follows a rename.
    const renamed = patch.id !== undefined && patch.id !== before.id && weights[before.id] !== undefined;
    void commit(next, renamed ? { agentWeights: Object.fromEntries(Object.entries(weights).map(([k, v]) => [k === before.id ? patch.id! : k, v])) } : {});
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

      <SystemHarnessesPanel
        pools={pools}
        onPoolsChanged={props.onPoolsChanged}
        onRefreshModels={props.onRefreshModels}
        onError={props.onError}
      />

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
                    <div className="row nowrap agent-card-head">
                      <span className={`role-tag ${a.role}`}>{ROLE_LABEL[a.role]}</span>
                      <input
                        className="agent-id"
                        defaultValue={a.id}
                        key={a.id}
                        aria-label="Agent name"
                        title="Click to rename this agent"
                        onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== a.id && update(i, { id: e.target.value.trim() })}
                        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                      />
                      {a.implicit && <span className="badge default-badge" title="Added because this pool has no worker or lead of its own; editing saves it">default</span>}
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
                    <div className="agent-status-bar">
                      <div className="row">
                        <PoolState pool={pool} sessions={props.sessions} />
                        <Strengths prior={priors.find((p) => p.agentId === a.id)} />
                        {a.role !== 'orchestrator' && (
                          <label className="weight-field" title="Your thumb on the scale for automatic routing. 1 is neutral; above 1 favours this agent for cards it handles well, below 1 holds it back, 0 keeps cards off it. Open a card to see how each agent scored.">
                            <span>Weight</span>
                            <input
                              type="number"
                              min={0}
                              max={10}
                              step={0.1}
                              value={weights[a.id] ?? 1}
                              className={weights[a.id] !== undefined ? 'overridden' : ''}
                              aria-label={`${a.id} routing weight`}
                              onChange={(e) => e.target.value !== '' && setWeight(a.id, Number(e.target.value))}
                            />
                          </label>
                        )}
                      </div>
                      <PoolHealthLine pool={pool} onChanged={props.onPoolsChanged ?? (() => {})} onError={props.onError} />
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
          <thead><tr><th>Role</th><th>Create cards</th><th>Add dependencies</th><th title="spawn_agent: add an agent to the board">Spawn agents</th><th title="propose_mcp and propose_skill: always wait for you">Propose MCP / skills</th><th title="request_grant, and grants on cards it creates">Request tool grants</th><th title="request_peer: ask another swarm for a fix or a piece of work (waits for you by default, see Settings → Tools)">Ask other swarms</th></tr></thead>
          <tbody>
            {CARD_ROLES.map((role) => (
              <tr key={role}>
                <td><span className={`role-tag ${role}`}>{ROLE_LABEL[role]}</span></td>
                {(['canCreateCards', 'canAddDependencies', 'canSpawnAgents', 'canInstallMcp', 'canRequestGrants', 'canRequestPeers'] as const).map((key) => (
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
