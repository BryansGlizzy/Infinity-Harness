import type { FastifyInstance } from 'fastify';
import type { Store, UsageInput } from '@ih/db';

// An OTLP/HTTP (JSON) receiver for the telemetry Claude Code exports (master plan §5.8, Phase 6.3). Claude Code counts
// tokens (`claude_code.token.usage`, by type and model) and cost (`claude_code.cost.usage`); the resource attributes
// the daemon set at session start (`ih.session`) say which card's agent they belong to.

type OtlpValue = { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean };
type OtlpAttr = { key: string; value?: OtlpValue };
interface OtlpPoint {
  attributes?: OtlpAttr[];
  asInt?: string | number;
  asDouble?: number;
  timeUnixNano?: string | number;
}
interface OtlpMetric {
  name: string;
  sum?: { dataPoints?: OtlpPoint[]; aggregationTemporality?: number | string };
  gauge?: { dataPoints?: OtlpPoint[] };
}
export interface OtlpMetricsBody {
  resourceMetrics?: { resource?: { attributes?: OtlpAttr[] }; scopeMetrics?: { metrics?: OtlpMetric[] }[] }[];
}

/** One data point, flattened: the metric, its value, its attributes and the resource it came from. */
export interface Datapoint {
  metric: string;
  value: number;
  attrs: Record<string, string>;
  resource: Record<string, string>;
  /** Cumulative series report totals; the receiver turns them into increments. */
  cumulative: boolean;
  ts: string;
}

const attrValue = (v?: OtlpValue): string => String(v?.stringValue ?? v?.intValue ?? v?.doubleValue ?? v?.boolValue ?? '');
const attrMap = (list?: OtlpAttr[]): Record<string, string> => Object.fromEntries((list ?? []).map((a) => [a.key, attrValue(a.value)]));

export function parseOtlpMetrics(body: OtlpMetricsBody): Datapoint[] {
  const out: Datapoint[] = [];
  for (const rm of body?.resourceMetrics ?? []) {
    const resource = attrMap(rm.resource?.attributes);
    for (const sm of rm.scopeMetrics ?? []) {
      for (const m of sm.metrics ?? []) {
        const block = m.sum ?? m.gauge;
        // aggregationTemporality: 1 = delta, 2 = cumulative (the JSON encoding may spell the enum out).
        const t = m.sum?.aggregationTemporality;
        const cumulative = t === 2 || t === 'AGGREGATION_TEMPORALITY_CUMULATIVE';
        for (const p of block?.dataPoints ?? []) {
          const value = Number(p.asDouble ?? p.asInt ?? 0);
          if (!Number.isFinite(value)) continue;
          const nano = Number(p.timeUnixNano);
          out.push({
            metric: m.name,
            value,
            attrs: attrMap(p.attributes),
            resource,
            cumulative,
            ts: Number.isFinite(nano) && nano > 0 ? new Date(nano / 1e6).toISOString() : new Date().toISOString(),
          });
        }
      }
    }
  }
  return out;
}

/** Claude's token types: `input` and `output` count for budgets; cache reads and writes are tracked apart. */
export function usageFromDatapoint(d: Datapoint): Pick<UsageInput, 'inputTokens' | 'outputTokens' | 'cacheTokens' | 'costUsd'> | null {
  if (d.metric === 'claude_code.token.usage') {
    const type = d.attrs.type ?? '';
    const n = Math.max(0, Math.round(d.value));
    if (!n) return null;
    if (type === 'input') return { inputTokens: n, outputTokens: 0 };
    if (type === 'output') return { inputTokens: 0, outputTokens: n };
    if (type.startsWith('cache')) return { inputTokens: 0, outputTokens: 0, cacheTokens: n };
    return null;
  }
  if (d.metric === 'claude_code.cost.usage') return d.value > 0 ? { inputTokens: 0, outputTokens: 0, costUsd: d.value } : null;
  return null;
}

/**
 * Turns Claude Code's exported metrics into usage records, attributed to the card whose session sent them. Metrics for
 * an unknown session are dropped. Cumulative series (if the exporter ignores the delta preference) become increments.
 */
export class TelemetryIngest {
  private store: Store;
  private last = new Map<string, number>();
  constructor(store: Store) {
    this.store = store;
  }

  ingest(body: OtlpMetricsBody): number {
    let stored = 0;
    for (const d of parseOtlpMetrics(body)) {
      const usage = this.increment(d);
      if (!usage) continue;
      const session = this.store.getSession(d.resource['ih.session'] ?? '');
      const card = session ? this.store.getCard(session.cardId) : undefined;
      if (!session || !card) continue;
      this.store.recordUsage({
        ts: d.ts,
        poolId: session.poolId,
        sessionId: session.id,
        source: 'otel',
        boardId: card.boardId,
        cardId: card.id,
        agentId: card.agentId,
        model: d.attrs.model || session.model,
        ...usage,
      });
      stored++;
    }
    return stored;
  }

  private increment(d: Datapoint): ReturnType<typeof usageFromDatapoint> {
    if (!d.cumulative) return usageFromDatapoint(d);
    const key = `${d.resource['ih.session']}|${d.metric}|${JSON.stringify(d.attrs)}`;
    const before = this.last.get(key) ?? 0;
    this.last.set(key, d.value);
    return usageFromDatapoint({ ...d, value: d.value >= before ? d.value - before : d.value });
  }
}

/** `POST /v1/metrics` (and quiet acceptance of logs and traces, which the exporter may also send). */
export function registerTelemetry(app: FastifyInstance, store: Store): TelemetryIngest {
  const ingest = new TelemetryIngest(store);
  app.post('/v1/metrics', async (req) => {
    ingest.ingest((req.body ?? {}) as OtlpMetricsBody);
    return {};
  });
  app.post('/v1/logs', async () => ({}));
  app.post('/v1/traces', async () => ({}));
  return ingest;
}
