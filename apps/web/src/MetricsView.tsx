import { useCallback, useEffect, useState } from 'react';
import type { EfficiencyReport } from '@ih/core';
import { api, type BudgetStatus, type MetricsReport, type UsageSum } from './api.ts';

/** Where each card's effort went: steps, failed MCP calls, restarts, refused calls, tokens. A flag says what looks wasteful. */
function Efficiency({ boardId, onSelect, onError }: { boardId: string; onSelect: (id: string) => void; onError: (m: string) => void }) {
  const [data, setData] = useState<EfficiencyReport | null>(null);
  useEffect(() => {
    const load = () => void api.efficiency(boardId).then(setData, (e: Error) => onError(e.message));
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [boardId]);
  if (!data || !data.cards.length) return null;
  const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  return (
    <section>
      <h3>Where the effort went</h3>
      <p className="muted small">Per card, from its event log. Steps are tool calls; <em>probing</em> are calls that only ask whether the other side is there; <em>diagnosing</em> are shell commands that read the machine; <em>refused</em> are calls the path policy stopped. Counts are approximate.</p>
      <div className="table-scroll surface-box">
        <table className="pools-table">
          <thead><tr><th>Card</th><th>Agent</th><th>Min</th><th>Steps</th><th>Starts</th><th>MCP failed/calls</th><th>Probing</th><th>Diagnosing</th><th>Refused</th><th>Tokens in/out (cache)</th></tr></thead>
          <tbody>
            {data.cards.map((c) => (
              <tr key={c.id} className={c.flags.length ? 'has-flags' : ''}>
                <td><button className="link" onClick={() => onSelect(c.id)}>{c.title.slice(0, 46)}</button>{c.flags.length > 0 && <div className="error-text small">{c.flags.join('; ')}</div>}</td>
                <td>{c.agent ?? '-'}</td><td>{c.minutes}</td><td>{c.steps}</td><td>{c.sessions}{c.cancels.length ? ` (cancelled by ${c.cancels.map((x) => `${x.by.replace('user:', '')}×${x.n}`).join(', ')})` : ''}</td>
                <td>{c.mcp.failed}/{c.mcp.calls}</td><td>{c.mcp.probes}</td><td>{c.diagnosticShell}</td><td>{c.refused}</td>
                <td>{k(c.tokens.input)} / {k(c.tokens.output)} ({k(c.tokens.cache)})</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const RANGES = [
  { hours: 1, label: '1 hour' },
  { hours: 24, label: '24 hours' },
  { hours: 24 * 7, label: '7 days' },
  { hours: 24 * 30, label: '30 days' },
] as const;

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}
const usd = (n: number) => (n ? `$${n.toFixed(n < 1 ? 3 : 2)}` : '–');
const short = (model: string) => model.split('/').pop() ?? model;

/** Bars for tokens per hour or day. Plain SVG, no chart library. */
export function Bars({ values, label }: { values: { key: string; value: number }[]; label: string }) {
  const max = Math.max(1, ...values.map((v) => v.value));
  const w = 6;
  const gap = 2;
  const h = 56;
  // At least 24 slots, so one or two buckets don't stretch into slabs.
  return (
    <svg className="bars" role="img" aria-label={label} viewBox={`0 0 ${Math.max(24, values.length) * (w + gap)} ${h}`} preserveAspectRatio="none">
      {values.map((v, i) => (
        <rect key={v.key} x={i * (w + gap)} y={h - Math.max(1, (v.value / max) * h)} width={w} height={Math.max(1, (v.value / max) * h)} rx={1}>
          <title>{`${v.key}: ${compact(v.value)} tokens`}</title>
        </rect>
      ))}
    </svg>
  );
}

export function BudgetBar({ b }: { b: BudgetStatus }) {
  const amount = (n: number) => (b.budget.unit === 'usd' ? `$${n.toFixed(2)}` : `${compact(n)} tokens`);
  return (
    <div className={`budget ${b.state}`}>
      <div className="row">
        <strong>{b.scope === 'board' ? 'Board' : b.scope}</strong>
        <span className="spacer" />
        <span className="small">{amount(b.used)} of {amount(b.budget.limit)} {b.budget.period === 'total' ? 'in total' : `per ${b.budget.period}`}</span>
      </div>
      <span className="gauge wide"><span className={b.pct >= 95 ? 'bad' : b.pct >= 80 ? 'warn' : ''} style={{ width: `${Math.min(100, b.pct)}%` }} /></span>
      <span className="muted small">
        {Math.round(b.pct)}%
        {b.state === 'halted' ? (b.scope === 'board' ? ' · no new cards start on this board' : ' · this agent gets no new cards') : b.state === 'warn' ? ' · warning' : ''}
      </span>
    </div>
  );
}

function Row({ label, sub, u, max }: { label: string; sub?: string; u: UsageSum; max: number }) {
  return (
    <tr>
      <td>{label}{sub && <div className="muted small">{sub}</div>}</td>
      <td className="num">{compact(u.tokens)}<span className="gauge wide inline"><span style={{ width: `${max ? (u.tokens / max) * 100 : 0}%` }} /></span></td>
      <td className="num muted">{compact(u.inputTokens)} / {compact(u.outputTokens)}</td>
      <td className="num muted">{u.cacheTokens ? compact(u.cacheTokens) : '–'}</td>
      <td className="num">{usd(u.costUsd)}</td>
      <td className="num muted">{u.requests}</td>
    </tr>
  );
}

function Head({ first }: { first: string }) {
  return (
    <thead>
      <tr><th>{first}</th><th className="num">Tokens</th><th className="num" title="Input / output">In / out</th><th className="num" title="Cache reads and writes, not counted in budgets">Cache</th><th className="num" title="Only where the harness reports a cost (Claude Code's telemetry)">Cost</th><th className="num">Records</th></tr>
    </thead>
  );
}

/** Tokens, cost and budgets for a board: by agent, model and pool, and per card rolled up its sub-agent tree. */
export function MetricsView(props: { boardId: string; onSelect: (cardId: string) => void; onError: (m: string) => void }) {
  const [hours, setHours] = useState<number>(24);
  const [data, setData] = useState<MetricsReport | null>(null);
  const { boardId, onError } = props;
  const load = useCallback(() => api.metrics(boardId, hours).then(setData, (e: Error) => onError(e.message)), [boardId, hours, onError]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const depth = (id: string, seen = 0): number => {
    const c = data?.cards.find((x) => x.id === id);
    return c?.parentId && seen < 8 && data?.cards.some((x) => x.id === c.parentId) ? 1 + depth(c.parentId, seen + 1) : 0;
  };
  // Cards in tree order: each parent, then its children.
  const ordered = (() => {
    if (!data) return [];
    const ids = new Set(data.cards.map((c) => c.id));
    const out: MetricsReport['cards'] = [];
    const visit = (parent: string | null) => {
      for (const c of data.cards.filter((x) => (parent === null ? !x.parentId || !ids.has(x.parentId) : x.parentId === parent)).sort((a, b) => b.subtree.tokens - a.subtree.tokens)) {
        out.push(c);
        visit(c.id);
      }
    };
    visit(null);
    return out;
  })();

  const maxAgent = Math.max(0, ...(data?.byAgent.map((a) => a.tokens) ?? [0]));
  const maxModel = Math.max(0, ...(data?.byModel.map((a) => a.tokens) ?? [0]));
  const maxPool = Math.max(0, ...(data?.byPool.map((a) => a.tokens) ?? [0]));
  const maxCard = Math.max(0, ...ordered.map((c) => c.subtree.tokens));

  return (
    <div className="page metrics-page">
      <div className="page-head">
        <div>
          <h2>Metrics</h2>
          <p className="muted small">
            What this board's agents used. Claude Code reports tokens and cost through its telemetry; harnesses that publish a turn's usage are counted too; API pools are counted at the gateway
            and credited to a card when only one session was working on the pool. Cache tokens are shown apart and don't count against budgets.
          </p>
        </div>
        <nav className="seg" aria-label="Time range">
          {RANGES.map((r) => <button key={r.hours} className={hours === r.hours ? 'on' : ''} aria-current={hours === r.hours ? 'true' : undefined} onClick={() => setHours(r.hours)}>{r.label}</button>)}
        </nav>
      </div>

      <Efficiency boardId={boardId} onSelect={props.onSelect} onError={onError} />

      {!data && <p className="muted">Loading…</p>}
      {data && (
        <>
          <div className="stat-row">
            <div className="stat surface-box"><span className="muted small">Tokens</span><strong>{compact(data.totals.tokens)}</strong><span className="muted small">{compact(data.totals.inputTokens)} in · {compact(data.totals.outputTokens)} out</span></div>
            <div className="stat surface-box"><span className="muted small">Cost reported</span><strong>{usd(data.totals.costUsd)}</strong><span className="muted small">where harnesses say</span></div>
            <div className="stat surface-box"><span className="muted small">Records</span><strong>{data.totals.requests}</strong><span className="muted small">{data.unattributed.tokens ? `${compact(data.unattributed.tokens)} tokens on no card` : 'all on cards'}</span></div>
            <div className="stat surface-box wide"><span className="muted small">Tokens over time</span><Bars label="Tokens over time" values={data.series.map((s) => ({ key: s.bucket.replace('T', ' '), value: s.tokens }))} /></div>
          </div>

          {data.budgets.length > 0 && (
            <section className="metrics-section">
              <h3>Budgets</h3>
              <div className="budgets">{data.budgets.map((b) => <BudgetBar key={b.scope} b={b} />)}</div>
            </section>
          )}

          {data.totals.tokens === 0 && data.totals.costUsd === 0 ? (
            <div className="empty-state">
              <h3>No usage recorded yet</h3>
              <p className="muted">Usage appears as agents work. Claude Code sessions report through telemetry; API pools through the gateway. Set budgets under Settings → Budgets.</p>
            </div>
          ) : (
            <div className="metrics-grid">
              <section className="metrics-section">
                <h3>By agent</h3>
                <div className="table-scroll surface-box"><table className="pools-table"><Head first="Agent" /><tbody>{data.byAgent.map((a) => <Row key={`${a.agentId}|${a.poolId}`} label={a.agentId} sub={a.poolId} u={a} max={maxAgent} />)}</tbody></table></div>
              </section>
              <section className="metrics-section">
                <h3>By model</h3>
                <div className="table-scroll surface-box"><table className="pools-table"><Head first="Model" /><tbody>{data.byModel.map((m) => <Row key={`${m.model}|${m.poolId}`} label={short(m.model)} sub={m.poolId} u={m} max={maxModel} />)}</tbody></table></div>
              </section>
              <section className="metrics-section">
                <h3>By pool</h3>
                <div className="table-scroll surface-box"><table className="pools-table"><Head first="Pool" /><tbody>{data.byPool.map((p) => <Row key={p.poolId} label={p.poolId} u={p} max={maxPool} />)}</tbody></table></div>
              </section>
              <section className="metrics-section wide">
                <h3>By card, with everything under it</h3>
                <p className="muted small">A goal or lead shows what its whole sub-agent tree used; the second figure is the card's own sessions.</p>
                <div className="table-scroll surface-box">
                  <table className="pools-table">
                    <thead><tr><th>Card</th><th className="num">Tree tokens</th><th className="num">Own</th><th className="num">Cost (tree)</th></tr></thead>
                    <tbody>
                      {ordered.map((c) => (
                        <tr key={c.id}>
                          <td style={{ paddingLeft: 8 + depth(c.id) * 16 }}><button className="link" onClick={() => props.onSelect(c.id)}>{c.title}</button> <span className="muted small">{c.role !== 'worker' ? c.role : ''}{c.agentId ? ` ${c.agentId}` : ''}</span></td>
                          <td className="num">{compact(c.subtree.tokens)}<span className="gauge wide inline"><span style={{ width: `${maxCard ? (c.subtree.tokens / maxCard) * 100 : 0}%` }} /></span></td>
                          <td className="num muted">{c.own.tokens ? compact(c.own.tokens) : '–'}</td>
                          <td className="num">{usd(c.subtree.costUsd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          )}
        </>
      )}
    </div>
  );
}
