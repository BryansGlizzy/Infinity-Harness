import type { CardEfficiency, EfficiencyReport } from '@ih/core';
import type { Store } from '@ih/db';

// Where a run's effort went, per card, from the event log and the usage records (master plan Phase 9, §3.7). Counts are
// approximate: shell calls are recognised by what the command looks like, since harnesses name their tool calls differently.

/** Commands that read the machine rather than the project: a worker running these is usually working out why something is broken. */
const DIAGNOSTIC = /(^|[\s;&|])(ps|ss|lsof|pgrep|netstat|strings|journalctl|dmesg|which|whereis|tail|top)(\s|$)|\/proc\/|\.var\/app|\.local\/share|\/\.cargo\/bin/;
/** Tools whose only job is to ask whether the other side is there. */
const PROBES = /^(connection_status|get_connected_instances|get_place_info|manage_instance|addon_status|get_request_status)$/;

export function buildEfficiency(store: Store, boardId: string): EfficiencyReport {
  const cards: CardEfficiency[] = [];
  for (const card of store.listCards(boardId)) {
    const events = store.eventsFor(card.id);
    const sessions = store.listSessions(card.id);
    const calls = events.filter((e) => e.type === 'mcp.call').map((e) => e.payload as { tool: string; ok: boolean; ms: number });
    const failed = calls.filter((c) => !c.ok);
    const toolCalls = events.filter((e) => e.type === 'session.event' && (e.payload as { event?: { type?: string } }).event?.type === 'tool_call');
    const diagnostic = toolCalls.filter((e) => DIAGNOSTIC.test(String((e.payload as { event: { title?: string } }).event.title ?? ''))).length;
    const refused = events.filter((e) => {
      const ev = (e.payload as { event?: { type?: string; decision?: string } }).event;
      return e.type === 'session.event' && ev?.type === 'permission' && ev.decision === 'rejected';
    }).length;
    const cancels = new Map<string, number>();
    for (const e of events.filter((x) => x.type === 'card.cancelled')) {
      const by = String((e.payload as { by?: string }).by ?? 'daemon');
      cancels.set(by, (cancels.get(by) ?? 0) + 1);
    }
    const usage = store.db.prepare('SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COALESCE(SUM(cache_tokens),0) c FROM usage_events WHERE card_id = ?').get(card.id) as { i: number; o: number; c: number };
    const started = sessions.map((s) => s.startedAt).sort()[0];
    const ended = [...sessions.map((s) => s.endedAt ?? ''), events.at(-1)?.ts ?? ''].filter(Boolean).sort().at(-1);
    const minutes = started && ended ? Math.max(0, Math.round((Date.parse(ended) - Date.parse(started)) / 60000)) : 0;
    const row: CardEfficiency = {
      id: card.id,
      title: card.title,
      agent: card.agentId,
      status: card.status,
      sessions: sessions.length,
      restarts: Math.max(0, sessions.length - 1),
      cancels: [...cancels].map(([by, n]) => ({ by, n })),
      steps: toolCalls.length,
      mcp: { calls: calls.length, failed: failed.length, failedSeconds: Math.round(failed.reduce((s, c) => s + c.ms, 0) / 1000), probes: calls.filter((c) => PROBES.test(c.tool)).length },
      diagnosticShell: diagnostic,
      refused,
      tokens: { input: usage.i, output: usage.o, cache: usage.c },
      minutes,
      flags: [],
    };
    const f = row.flags;
    if (row.restarts >= 2) f.push(`started over ${row.restarts} times`);
    if (row.mcp.failed >= 3) f.push(`${row.mcp.failed} MCP calls failed (${row.mcp.failedSeconds}s waiting)`);
    if (row.mcp.probes >= 8) f.push(`${row.mcp.probes} calls only asked whether the other side was there`);
    if (row.diagnosticShell >= 8) f.push(`${row.diagnosticShell} shell commands that look like diagnosing the machine`);
    if (row.refused >= 3) f.push(`${row.refused} calls refused by the path policy`);
    if (row.steps >= 100) f.push(`${row.steps} steps`);
    cards.push(row);
  }
  const sum = (pick: (c: CardEfficiency) => number) => cards.reduce((n, c) => n + pick(c), 0);
  return {
    cards,
    totals: {
      cards: cards.length,
      sessions: sum((c) => c.sessions),
      restarts: sum((c) => c.restarts),
      steps: sum((c) => c.steps),
      mcpCalls: sum((c) => c.mcp.calls),
      mcpFailed: sum((c) => c.mcp.failed),
      diagnosticShell: sum((c) => c.diagnosticShell),
      refused: sum((c) => c.refused),
      tokens: { input: sum((c) => c.tokens.input), output: sum((c) => c.tokens.output), cache: sum((c) => c.tokens.cache) },
    },
  };
}
