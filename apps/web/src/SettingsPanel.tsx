import { useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_SETTINGS, SKILLS, type PriorOverride, type Settings, type Skill } from '@mh/core';
import { api, type AgentPrior, type PoolWithStatus } from './api.ts';
import { remember, saved } from './storage.ts';
import { Field, NumField, Toggle } from './SettingsFields.tsx';
import { BudgetsTab } from './SettingsBudgets.tsx';
import { ToolsTab } from './SettingsTools.tsx';

export { ModelSelect } from './AgentsView.tsx';

const TABS = [
  { id: 'routing', label: 'Routing & pools' },
  { id: 'refinery', label: 'Refinery' },
  { id: 'learning', label: 'Learning' },
  { id: 'fastlane', label: 'Fast lane' },
  { id: 'guardrails', label: 'Guardrails' },
  { id: 'budgets', label: 'Budgets' },
  { id: 'tools', label: 'Tools' },
] as const;
type Tab = (typeof TABS)[number]['id'];

/** Settings each tab owns, for its "Reset to defaults". */
const SECTION_KEYS: Record<Tab, (keyof Settings)[]> = {
  routing: ['autoRoute', 'claudeReservePct', 'codexReservePct', 'rerouteAfterSec', 'stallMinutes', 'poolSlots', 'scarcity'],
  refinery: ['autoLand', 'landMode', 'testTimeoutSec', 'mergeAttempts', 'maxRetries', 'crossReview', 'reviewThreshold', 'maxReviewRounds'],
  learning: ['learnFromOutcomes', 'kevOutcomeScoring', 'priorOverrides'],
  fastlane: ['narrator', 'specLint', 'queryRewrite', 'artifactTagging', 'quickAnswers', 'notificationText'],
  guardrails: ['maxDepth', 'maxChildren', 'maxCardsPerTurn', 'councilVerifyRounds', 'shareToolchains', 'toolPaths', 'directParallel'],
  budgets: ['budgets'],
  tools: ['humanReview', 'bestOfN', 'grants', 'autoApproveSpawn'],
};

/** One folder per line; saved when the field loses focus. Only absolute and `~/` paths are kept. */
function PathListField(props: { label: string; hint?: string; value: string[]; onSave: (v: string[]) => void }) {
  const [text, setText] = useState(props.value.join('\n'));
  useEffect(() => setText(props.value.join('\n')), [props.value]);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const bad = lines.filter((l) => !l.startsWith('/') && !l.startsWith('~/'));
  const error = bad.length ? `Use absolute or ~/ paths: ${bad.join(', ')}` : null;
  return (
    <Field label={props.label} hint={props.hint} def="none" error={error}>
      <textarea
        rows={3}
        value={text}
        placeholder={'~/sdk/zephyr\n/opt/xilinx'}
        aria-invalid={Boolean(error)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (!error && lines.join('\n') !== props.value.join('\n')) props.onSave(lines);
        }}
      />
    </Field>
  );
}

/**
 * Routing priors per agent (master plan Phase 5): expected success per skill from the model's built-in family, which
 * the operator can override, and what outcomes have shown so far. Routing blends the two, the prior counting like
 * three outcomes.
 */
function PriorsEditor(props: { boardId: string; settings: Settings; save: (patch: Partial<Settings>) => void; onError: (m: string) => void }) {
  const [rows, setRows] = useState<AgentPrior[]>([]);
  useEffect(() => {
    let alive = true;
    api.priors(props.boardId).then((r) => alive && setRows(r), (e: Error) => props.onError(e.message));
    return () => {
      alive = false;
    };
  }, [props.boardId, props.settings]);
  const overrides = props.settings.priorOverrides;
  const set = (agentId: string, patch: PriorOverride) => {
    const cur = overrides[agentId] ?? {};
    const next = { ...cur, ...patch, skills: { ...cur.skills, ...patch.skills } };
    props.save({ priorOverrides: { ...overrides, [agentId]: next } });
  };
  const reset = (agentId: string) => {
    const { [agentId]: _, ...rest } = overrides;
    props.save({ priorOverrides: rest });
  };
  const cols: (Skill | 'frontend')[] = [...SKILLS, 'frontend'];
  const pct = (v: number) => Math.round(v * 100);
  return (
    <>
      <div className="table-scroll surface-box">
        <table className="pools-table priors">
          <thead>
            <tr>
              <th>Agent</th>
              <th title="Highest complexity (0–4) handled well">Cap.</th>
              {cols.map((c) => <th key={c}>{c}</th>)}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.filter((r) => r.role === 'worker' || r.role === 'lead').map((r) => {
              const own = overrides[r.agentId];
              return (
                <tr key={r.agentId}>
                  <td>
                    {r.agentId}
                    <div className="muted small">{r.model.split('/').pop()} · {r.prior.family}{r.prior.noWeb ? ' · no web' : ''}</div>
                  </td>
                  <td>
                    <input type="number" min={0} max={4} step={0.5} value={r.prior.capability} className={own?.capability !== undefined ? 'overridden' : ''} onChange={(e) => set(r.agentId, { capability: Number(e.target.value) })} />
                  </td>
                  {cols.map((c) => {
                    const value = c === 'frontend' ? r.prior.frontend : r.prior.skills[c];
                    const changed = c === 'frontend' ? own?.frontend !== undefined : own?.skills?.[c] !== undefined;
                    const seen = c === 'frontend' || c === 'review' ? undefined : r.observed[c];
                    return (
                      <td key={c}>
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={5}
                          value={pct(value)}
                          aria-label={`${r.agentId} ${c} prior %`}
                          className={changed ? 'overridden' : ''}
                          onChange={(e) => {
                            const v = Math.min(100, Math.max(0, Number(e.target.value))) / 100;
                            set(r.agentId, c === 'frontend' ? { frontend: v } : { skills: { [c]: v } });
                          }}
                        />
                        {seen && <div className="muted small" title="Observed mean outcome value">{pct(seen.mean)}% · n={seen.n}</div>}
                      </td>
                    );
                  })}
                  <td>{own && <button className="ghost small-btn" onClick={() => reset(r.agentId)}>Reset</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="hint">
        Expected success (%) per work type, plus reviewing and web front-end work. Built-in values come from each model's family; edited cells are highlighted. Below a value: what
        landed cards have shown so far (mean outcome, count). Research never goes to agents without web access.
      </p>
    </>
  );
}

/** Board settings in tabs. Agents and permissions live in the Agents view; pools' live state in the Pools view. */
export function SettingsPanel(props: {
  boardId: string;
  pools: PoolWithStatus[];
  settings: Settings | null;
  onSettings: (s: Settings) => void;
  onClose: () => void;
  onError: (m: string) => void;
  onOpenAgents: () => void;
}) {
  const { settings } = props;
  const [tab, setTab] = useState<Tab>(() => {
    const t = new URLSearchParams(location.search).get('settings') || saved('ih.settings.tab');
    return TABS.some((x) => x.id === t) ? (t as Tab) : 'routing';
  });

  async function save(patch: Partial<Settings>) {
    try {
      props.onSettings(await api.updateSettings(props.boardId, patch));
    } catch (err) {
      props.onError((err as Error).message);
    }
  }
  const resetSection = () => {
    const patch: Partial<Settings> = {};
    for (const k of SECTION_KEYS[tab]) (patch as Record<string, unknown>)[k] = DEFAULT_SETTINGS[k];
    void save(patch);
  };

  if (!settings) return null;
  const D = DEFAULT_SETTINGS;

  return (
    <aside className="settings" role="dialog" aria-label="Board settings">
      <div className="panel-head">
        <h2>Settings</h2>
        <button className="ghost icon-btn" onClick={props.onClose} aria-label="Close settings">✕</button>
      </div>
      <p className="hint">
        Agents, roles and permissions are in <button className="link" onClick={props.onOpenAgents}>Agents</button>. Live pool usage is in Pools.
      </p>
      <div className="tabs settings-tabs" role="tablist" aria-label="Settings sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`tab ${tab === t.id ? 'on' : ''}`}
            onClick={() => {
              setTab(t.id);
              remember('ih.settings.tab', t.id);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="settings-body" role="tabpanel">
        {tab === 'routing' && (
          <>
            <Toggle label="Start ready cards automatically" hint="A card moved to Ready is routed to the best agent with a free slot." checked={settings.autoRoute} def={D.autoRoute} onChange={(v) => save({ autoRoute: v })} />
            <div className="fields">
              <NumField label="Claude reserve for the orchestrator" unit="%" hint="Workers stop taking Claude cards when its 5-hour usage passes 100 − this." value={settings.claudeReservePct} def={D.claudeReservePct} min={0} max={90} onSave={(n) => save({ claudeReservePct: n })} />
              <NumField label="Codex reserve for the orchestrator" unit="%" hint="The same, for Codex's 5-hour window." value={settings.codexReservePct ?? 30} def={D.codexReservePct} min={0} max={90} onSave={(n) => save({ codexReservePct: n })} />
              <NumField label="Re-route after" unit=" s" hint="How long a ready card waits for a halted pool before it moves to the next best agent." value={settings.rerouteAfterSec} def={D.rerouteAfterSec} min={0} onSave={(n) => save({ rerouteAfterSec: n })} />
              <NumField label="Stalled after" unit=" min" hint="A turn with no activity this long is ended and the card goes back to Ready." value={settings.stallMinutes} def={D.stallMinutes} min={0} onSave={(n) => save({ stallMinutes: n })} />
            </div>
            <h3>Pools</h3>
            <div className="table-scroll surface-box">
              <table className="pools-table">
                <thead>
                  <tr><th>Pool</th><th title="Sessions that may work at once, shared by all agents on the pool">Slots</th><th title="Multiplier in the routing score; lower means use only when others are busy">Scarcity</th></tr>
                </thead>
                <tbody>
                  {props.pools.map((p) => (
                    <tr key={p.id}>
                      <td>{p.label}<div className="muted small">default slots {D.poolSlots[p.id] ?? 1}, scarcity {D.scarcity[p.id] ?? 1}</div></td>
                      <td><input type="number" min={0} max={20} value={settings.poolSlots[p.id] ?? 1} onChange={(e) => e.target.value !== '' && save({ poolSlots: { [p.id]: Number(e.target.value) } })} aria-label={`${p.label} slots`} /></td>
                      <td><input type="number" min={0} max={2} step={0.05} value={settings.scarcity[p.id] ?? 1} onChange={(e) => e.target.value !== '' && save({ scarcity: { [p.id]: Number(e.target.value) } })} aria-label={`${p.label} scarcity`} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === 'refinery' && (
          <>
            <Toggle label="Land reviewed cards automatically" hint="Cards in Review go through the merge queue on their own." checked={settings.autoLand} def={D.autoLand} onChange={(v) => save({ autoLand: v })} />
            <div className="fields">
              <Field label="Test command" hint="Runs in the card's worktree before it lands; empty skips testing." def="none">
                <input defaultValue={settings.testCommand} key={settings.testCommand} placeholder="e.g. pnpm test" onBlur={(e) => e.target.value !== settings.testCommand && save({ testCommand: e.target.value })} />
              </Field>
              <Field label="Land as" hint="GitHub needs gh auth login and an origin remote." def="auto">
                <select value={settings.landMode} onChange={(e) => save({ landMode: e.target.value as Settings['landMode'] })}>
                  <option value="auto">Auto: a PR when the repo has a GitHub remote</option>
                  <option value="pr">GitHub PR (push, open, merge)</option>
                  <option value="local">Local merge onto the default branch</option>
                </select>
              </Field>
              <Field label="Worktree setup command" hint="Runs once in each new card worktree before its agent starts, and again if you change it. Install dependencies, copy .env. MH_REPO_PATH is the main checkout. If it fails the agent is told." def="none">
                <input defaultValue={settings.worktreeSetup} key={settings.worktreeSetup} placeholder={'e.g. pnpm install --frozen-lockfile --prefer-offline && cp "$MH_REPO_PATH/.env" .env'} onBlur={(e) => e.target.value !== settings.worktreeSetup && save({ worktreeSetup: e.target.value })} />
              </Field>
              <NumField label="Setup timeout" unit=" s" value={settings.worktreeSetupTimeoutSec} def={D.worktreeSetupTimeoutSec} min={10} onSave={(n) => save({ worktreeSetupTimeoutSec: n })} />
              <NumField label="Test timeout" unit=" s" value={settings.testTimeoutSec} def={D.testTimeoutSec} min={10} onSave={(n) => save({ testTimeoutSec: n })} />
              <NumField label="Failed landings before you're asked" hint="Back to the author first, then another agent." value={settings.mergeAttempts} def={D.mergeAttempts} min={1} max={10} onSave={(n) => save({ mergeAttempts: n })} />
              <NumField label="Failed runs reassigned before you're asked" value={settings.maxRetries} def={D.maxRetries} min={0} max={10} onSave={(n) => save({ maxRetries: n })} />
            </div>
            <Toggle label="Cross-provider review before landing" hint="An agent on a different provider reads risky changes first." checked={settings.crossReview} def={D.crossReview} onChange={(v) => save({ crossReview: v })} />
            <div className="fields">
              <NumField label="Review when needs-review is at least" hint="Kev's 0–1 score for how much a card needs a second look." value={settings.reviewThreshold} def={D.reviewThreshold} min={0} max={1} step={0.05} onSave={(n) => save({ reviewThreshold: n })} />
              <NumField label="Review rounds at most" hint="After the last round the card lands anyway; tests still gate it." value={settings.maxReviewRounds} def={D.maxReviewRounds} min={1} max={5} onSave={(n) => save({ maxReviewRounds: n })} />
            </div>
          </>
        )}

        {tab === 'learning' && (
          <>
            <Toggle label="Blend recorded outcomes into routing" hint="Off: routing uses the priors only." checked={settings.learnFromOutcomes} def={D.learnFromOutcomes} onChange={(v) => save({ learnFromOutcomes: v })} />
            <Toggle label="Kev scores landed work" hint="Against the card's acceptance criteria, and whether it stayed in scope." checked={settings.kevOutcomeScoring} def={D.kevOutcomeScoring} onChange={(v) => save({ kevOutcomeScoring: v })} />
            <h3>Expected success per agent</h3>
            <PriorsEditor boardId={props.boardId} settings={settings} save={save} onError={props.onError} />
          </>
        )}

        {tab === 'fastlane' && (
          <>
            <p className="hint">Small utility jobs on Groq, falling back to NIM, then the local model.</p>
            <Toggle label="Live narrator" hint="A one-line status for each running card." checked={settings.narrator} def={D.narrator} onChange={(v) => save({ narrator: v })} />
            <Toggle label="Spec lint" hint="Vague agent-written cards go back to their author before they're assigned." checked={settings.specLint} def={D.specLint} onChange={(v) => save({ specLint: v })} />
            <Toggle label="Query rewrite" hint="Extra keywords and a hypothetical answer widen search_context." checked={settings.queryRewrite} def={D.queryRewrite} onChange={(v) => save({ queryRewrite: v })} />
            <Toggle label="Tag and summarize notes" hint="Saved notes get tags and a short summary." checked={settings.artifactTagging} def={D.artifactTagging} onChange={(v) => save({ artifactTagging: v })} />
            <Toggle label="Quick answers" hint="ask_agent to a busy agent is answered from its notes instead of waiting." checked={settings.quickAnswers} def={D.quickAnswers} onChange={(v) => save({ quickAnswers: v })} />
          </>
        )}

        {tab === 'guardrails' && (
          <>
            <p className="hint">Limits on how far planning agents can grow the card tree.</p>
            <div className="fields">
              <NumField label="Max depth" hint="Levels below the goal." value={settings.maxDepth} def={D.maxDepth} min={1} max={10} onSave={(n) => save({ maxDepth: n })} />
              <NumField label="Max children per card" value={settings.maxChildren} def={D.maxChildren} min={1} max={50} onSave={(n) => save({ maxChildren: n })} />
              <NumField label="Cards per agent turn" value={settings.maxCardsPerTurn} def={D.maxCardsPerTurn} min={1} max={100} onSave={(n) => save({ maxCardsPerTurn: n })} />
              <NumField label="Council verification rounds" hint="Cross-check rounds before a council goal closes anyway." value={settings.councilVerifyRounds} def={D.councilVerifyRounds} min={1} max={5} onSave={(n) => save({ councilVerifyRounds: n })} />
            </div>
            <h3>Agent tool access</h3>
            <p className="hint">Each agent works in its own worktree. These are the places outside it that its tools may still use. Everything else (other projects, the main checkout, the rest of your home folder) is refused, and refusals are sent to you as messages.</p>
            <Toggle
              label="Share toolchains and scratch space"
              hint="/tmp, every folder on PATH, and toolchain folders in your home such as ~/.local, ~/.cache, ~/.cargo, ~/.platformio, ~/.nvm and ~/.pyenv. Off: the worktree and the repo's git folder only."
              checked={settings.shareToolchains}
              def={D.shareToolchains}
              onChange={(v) => save({ shareToolchains: v })}
            />
            <PathListField
              label="More tool paths"
              hint="One folder per line, e.g. an SDK installed somewhere unusual. Applies to new sessions."
              value={settings.toolPaths}
              onSave={(v) => save({ toolPaths: v })}
            />
            <h3>Direct boards</h3>
            <div className="fields">
              <NumField
                label="Workers at once"
                hint="Boards in direct mode share one folder. Kimi and Codex edit without asking, so file reservations can't keep them apart; raise this only for cards that touch separate files."
                value={settings.directParallel}
                def={D.directParallel}
                min={1}
                max={10}
                onSave={(n) => save({ directParallel: n })}
              />
            </div>
          </>
        )}
        {tab === 'budgets' && <BudgetsTab settings={settings} pools={props.pools} save={save} />}
        {tab === 'tools' && <ToolsTab boardId={props.boardId} settings={settings} save={save} onError={props.onError} />}
      </div>

      <div className="settings-foot">
        <button className="ghost small-btn" onClick={resetSection} title={`Reset ${TABS.find((t) => t.id === tab)!.label} to the defaults`}>
          Reset {TABS.find((t) => t.id === tab)!.label} to defaults
        </button>
      </div>
    </aside>
  );
}
