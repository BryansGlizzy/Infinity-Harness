import { useEffect, useState } from 'react';
import { api, type PoolHistoryData } from './api.ts';
import { Bars, compact } from './MetricsView.tsx';

/** A pool's last day: its fullest window over time, the stretches it was halted or locked, and its requests and tokens per hour. */
export function PoolHistory({ poolId }: { poolId: string }) {
  const [open, setOpen] = useState(true);
  const [data, setData] = useState<PoolHistoryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = () => api.poolHistory(poolId, 24).then((d) => !cancelled && setData(d), (e: Error) => !cancelled && setError(e.message));
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [open, poolId]);

  const now = Date.now();
  const start = now - 24 * 3_600_000;
  const x = (ts: string) => Math.max(0, Math.min(100, ((Date.parse(ts) - start) / (now - start)) * 100));
  const points = data?.samples.map((s) => `${x(s.ts).toFixed(2)},${(100 - Math.min(100, s.topPct)).toFixed(1)}`).join(' ');
  const totalRequests = data?.usage.reduce((a, u) => a + u.requests, 0) ?? 0;
  const totalTokens = data?.usage.reduce((a, u) => a + u.inputTokens + u.outputTokens, 0) ?? 0;
  const errors = data?.usage.reduce((a, u) => a + u.errors, 0) ?? 0;

  return (
    <div className="pool-section pool-history">
      <button className="link small" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? 'Hide' : 'Show'} the last 24 hours</button>
      {open && error && <p className="small error">{error}</p>}
      {open && !data && !error && <p className="muted small">Loading…</p>}
      {open && data && (
        <>
          {data.samples.length === 0 ? (
            <p className="muted small">No samples yet. The daemon records each pool's state every minute, when something changes.</p>
          ) : (
            <svg className="history-chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={`${poolId} usage over the last 24 hours`}>
              <line x1="0" x2="100" y1="20" y2="20" className="limit warn" />
              <line x1="0" x2="100" y1="5" y2="5" className="limit bad" />
              {data.outages.map((o) => <rect key={o.from} x={x(o.from)} width={Math.max(0.6, x(o.to) - x(o.from))} y="0" height="100" className={`outage ${o.state}`}><title>{`${o.state} ${new Date(o.from).toLocaleTimeString()} to ${new Date(o.to).toLocaleTimeString()}`}</title></rect>)}
              <polyline points={points} fill="none" vectorEffect="non-scaling-stroke" className="line" />
            </svg>
          )}
          {data.samples.length > 0 && (
            <p className="muted small">
              Fullest window: the line (dashed: 80% and 95%). Shaded: halted or locked{data.outages.length ? ` (${data.outages.length} time${data.outages.length === 1 ? '' : 's'})` : ''}.
            </p>
          )}
          {data.usage.length > 0 && <Bars label="Tokens per hour" values={data.usage.map((u) => ({ key: u.bucket.replace('T', ' '), value: u.inputTokens + u.outputTokens }))} />}
          <p className="small">
            {totalRequests} request{totalRequests === 1 ? '' : 's'} · {compact(totalTokens)} tokens
            {errors ? <span className="error"> · {errors} rate-limited (429)</span> : null}
            <span className="muted"> · gateway-counted pools only (API pools); subscription pools show their windows above</span>
          </p>
        </>
      )}
    </div>
  );
}
