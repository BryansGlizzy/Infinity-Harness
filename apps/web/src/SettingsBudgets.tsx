import { useEffect, useState } from 'react';
import { effectiveAgents, type Budget, type Settings } from '@ih/core';
import type { PoolWithStatus } from './api.ts';

/** One budget: a limit (empty for none), what it counts, and over which window. */
function BudgetEditor(props: { label: string; value: Budget | null; onChange: (b: Budget | null) => void }) {
  const [text, setText] = useState(props.value ? String(props.value.limit) : '');
  useEffect(() => setText(props.value ? String(props.value.limit) : ''), [props.value]);
  const unit = props.value?.unit ?? 'tokens';
  const period = props.value?.period ?? 'day';
  const commit = (limitText: string, u: Budget['unit'], p: Budget['period']) => {
    const n = Number(limitText);
    props.onChange(limitText.trim() !== '' && Number.isFinite(n) && n > 0 ? { limit: n, unit: u, period: p } : null);
  };
  return (
    <tr>
      <td>{props.label}</td>
      <td>
        <input
          type="number"
          min={0}
          step={unit === 'usd' ? 0.5 : 10_000}
          value={text}
          placeholder="no limit"
          aria-label={`${props.label} limit`}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => commit(text, unit, period)}
        />
      </td>
      <td>
        <select value={unit} aria-label={`${props.label} unit`} onChange={(e) => commit(text, e.target.value as Budget['unit'], period)}>
          <option value="tokens">tokens</option>
          <option value="usd">US dollars</option>
        </select>
      </td>
      <td>
        <select value={period} aria-label={`${props.label} window`} onChange={(e) => commit(text, unit, e.target.value as Budget['period'])}>
          <option value="day">per day</option>
          <option value="week">per week</option>
          <option value="total">in total</option>
        </select>
      </td>
    </tr>
  );
}

/** Settings → Budgets (master plan Phase 6.3): caps per board and per agent. */
export function BudgetsTab(props: { settings: Settings; pools: PoolWithStatus[]; save: (patch: Partial<Settings>) => void }) {
  const { settings } = props;
  const agents = effectiveAgents(settings, props.pools).filter((a) => a.enabled);
  const setAgent = (id: string, b: Budget | null) => {
    const next = { ...settings.budgets.agents };
    if (b) next[id] = b;
    else delete next[id];
    props.save({ budgets: { ...settings.budgets, agents: next } });
  };
  return (
    <>
      <p className="hint">
        A budget warns at 80% and stops new work at 95%, the same way a pool does: a board past its budget starts no new cards and plans no new goals; an agent past its budget is skipped when cards are routed.
        Turns already running finish. Tokens are input plus output (cache reads aren't counted). Dollars count only where the harness reports a cost: Claude Code does, through its telemetry.
        Day and week are rolling windows.
      </p>
      <h3>Board</h3>
      <div className="table-scroll surface-box">
        <table className="pools-table">
          <thead><tr><th>Scope</th><th>Limit</th><th>Counts</th><th>Window</th></tr></thead>
          <tbody>
            <BudgetEditor label="Whole board" value={settings.budgets.board} onChange={(b) => props.save({ budgets: { ...settings.budgets, board: b } })} />
          </tbody>
        </table>
      </div>
      <h3>Agents</h3>
      <div className="table-scroll surface-box">
        <table className="pools-table">
          <thead><tr><th>Agent</th><th>Limit</th><th>Counts</th><th>Window</th></tr></thead>
          <tbody>
            {agents.map((a) => (
              <BudgetEditor key={a.id} label={a.id} value={settings.budgets.agents[a.id] ?? null} onChange={(b) => setAgent(a.id, b)} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">Current usage against each budget is in the Metrics view.</p>
    </>
  );
}
