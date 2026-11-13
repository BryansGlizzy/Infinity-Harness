import { EventStream, isLive, loadNeeds, type StreamMessage } from '@ih/client';
import { CARD_STATUSES, type Board, type Card, type CardStatus } from '@ih/core';
import { attachTerminal, DETACH_HINT } from '@ih/client/node';
import { runTui } from '@ih/tui';
import { connect, resolveBoard, resolveCard, splitRef, type Flags, type Target } from './context.ts';
import { ago, pct, table } from './format.ts';
import { UsageError, type Io } from './io.ts';

export interface Ctx {
  io: Io;
  /** Positional arguments after the command name. */
  args: string[];
  values: Record<string, string | boolean | undefined>;
  flags: Flags;
  json: boolean;
  /** Prints `data` as JSON, or `human()` for a person at a terminal. */
  print(data: unknown, human: () => string): void;
}

export interface Command {
  name: string;
  usage: string;
  summary: string;
  options?: Record<string, { type: 'string' | 'boolean'; short?: string; hint?: string }>;
  run(ctx: Ctx): Promise<void>;
}

/** Whether a pool's model is answering, in a word. */
const healthText = (p: { health?: { reachable: string; latencyMs: number | null; ejected: unknown } }) =>
  !p.health ? '' : p.health.ejected ? 'OUT of rotation' : p.health.reachable === 'online' ? `online${p.health.latencyMs !== null ? ` ${p.health.latencyMs}ms` : ''}` : p.health.reachable === 'offline' ? 'no response' : '-';

const str = (v: string | boolean | undefined) => (typeof v === 'string' ? v : undefined);
const need = (ctx: Ctx, n: number, what: string) => {
  if (ctx.args.length < n) throw new UsageError(`missing ${what}`);
};

/** Connects for a command that names a card or other id, honouring `machine:id`. */
async function open(ctx: Ctx, ref?: string): Promise<{ t: Target; id: string }> {
  const { machine, id } = ref ? splitRef(ref) : { machine: undefined, id: '' };
  return { t: await connect(ctx.io, ctx.flags, machine), id };
}

async function withTarget<T>(ctx: Ctx, fn: (t: Target) => Promise<T>): Promise<T> {
  const t = await connect(ctx.io, ctx.flags);
  try {
    return await fn(t);
  } finally {
    t.close();
  }
}

async function withCard<T>(ctx: Ctx, ref: string, fn: (t: Target, card: Card, board: Board) => Promise<T>): Promise<T> {
  const { t, id } = await open(ctx, ref);
  try {
    const { card, board } = await resolveCard(t.api, id, ctx.flags, ctx.io);
    return await fn(t, card, board);
  } finally {
    t.close();
  }
}

const cardRow = (c: Card) => [c.id, c.status, c.role, c.agentId ?? '-', c.title];

export const COMMANDS: Command[] = [
  {
    name: 'tui',
    usage: 'ih tui [--no-mouse]',
    summary: 'Full-screen view of everything waiting for you, the board and the pools; click or use the keys',
    options: { 'no-mouse': { type: 'boolean' } },
    async run(ctx) {
      await runTui({ env: ctx.io.env, mouse: ctx.values['no-mouse'] ? false : undefined, machine: ctx.flags.machine, board: ctx.flags.board, connection: ctx.io.connection });
    },
  },
  {
    name: 'status',
    usage: 'ih status',
    summary: 'Is the daemon up, who may call it, which boards and pools it has',
    async run(ctx) {
      await withTarget(ctx, async (t) => {
        const [health, boards, pools] = await Promise.all([t.api.health(), t.api.boards(), t.api.pools()]);
        ctx.print({ machine: t.label, url: t.api.baseUrl, ...health, boards, pools: pools.map((p) => ({ id: p.id, label: p.label, state: p.status.state, health: p.health, running: p.running, windows: p.status.windows })) }, () =>
          [
            `${t.label}: ${t.api.baseUrl} (api access: ${health.auth === 'token' ? 'token required' : 'local callers need none'})`,
            '',
            table(boards.map((b) => [b.id, b.name, b.mode, b.repoPath]), ['BOARD', 'NAME', 'MODE', 'REPO']),
            table(pools.map((p) => [p.id, p.status.state, healthText(p), `${p.running} running`, p.status.windows.map((w) => `${w.window} ${pct(w.pct)}`).join(' ')]), ['POOL', 'STATE', 'MODEL', 'SESSIONS', 'WINDOWS']),
          ].join('\n'),
        );
      });
    },
  },
  {
    name: 'boards',
    usage: 'ih boards',
    summary: 'List boards',
    async run(ctx) {
      await withTarget(ctx, async (t) => {
        const boards = await t.api.boards();
        ctx.print(boards, () => table(boards.map((b) => [b.id, b.name, b.mode, b.repoPath]), ['ID', 'NAME', 'MODE', 'REPO']));
      });
    },
  },
  {
    name: 'cards',
    usage: 'ih cards [--board B] [--status S]',
    summary: 'List a board\'s cards',
    options: { status: { type: 'string', hint: CARD_STATUSES.join('|') } },
    async run(ctx) {
      await withTarget(ctx, async (t) => {
        const board = await resolveBoard(t.api, ctx.flags.board, ctx.io);
        const status = str(ctx.values.status);
        if (status && !(CARD_STATUSES as readonly string[]).includes(status)) throw new UsageError(`status is one of ${CARD_STATUSES.join(', ')}`);
        const cards = (await t.api.cards(board.id)).filter((c) => !status || c.status === status);
        ctx.print(cards, () => table(cards.map(cardRow), ['ID', 'STATUS', 'ROLE', 'AGENT', 'TITLE']));
      });
    },
  },
  {
    name: 'card',
    usage: 'ih card <id>',
    summary: 'Show one card (an id prefix is enough; machine:id for a saved machine)',
    async run(ctx) {
      need(ctx, 1, 'a card id');
      await withCard(ctx, ctx.args[0]!, async (t, card) => {
        const [sessions, changes] = await Promise.all([t.api.sessions(card.id).catch(() => []), t.api.changes(card.id).catch(() => null)]);
        ctx.print({ card, sessions, changes }, () =>
          [
            `${card.id}  ${card.title}`,
            `status ${card.status} · role ${card.role} · agent ${card.agentId ?? '-'} · pool ${card.poolId ?? '-'} · branch ${card.branch ?? '-'}`,
            card.narration ? `now: ${card.narration}` : '',
            changes ? `changes: ${changes.files.length} files, ${changes.commits.length} commits` : '',
            '',
            card.description,
          ].filter((l, i) => l || i > 3).join('\n') + '\n',
        );
      });
    },
  },
  {
    name: 'plan',
    usage: 'ih plan <goal…> [--description TEXT]',
    summary: 'Type a goal: the orchestrator breaks it into cards that route themselves',
    options: { description: { type: 'string', short: 'd' } },
    async run(ctx) {
      need(ctx, 1, 'a goal');
      await withTarget(ctx, async (t) => {
        const board = await resolveBoard(t.api, ctx.flags.board, ctx.io);
        const card = await t.api.goal(board.id, ctx.args.join(' '), str(ctx.values.description) ?? '');
        ctx.print(card, () => `planning started: ${card.id}  ${card.title}\n`);
      });
    },
  },
  {
    name: 'add',
    usage: 'ih add <title…> [--description TEXT] [--status ready|backlog]',
    summary: 'Add a card by hand',
    options: { description: { type: 'string', short: 'd' }, status: { type: 'string' } },
    async run(ctx) {
      need(ctx, 1, 'a title');
      await withTarget(ctx, async (t) => {
        const board = await resolveBoard(t.api, ctx.flags.board, ctx.io);
        const status = str(ctx.values.status) as CardStatus | undefined;
        const card = await t.api.createCard(board.id, ctx.args.join(' '), str(ctx.values.description) ?? '', status);
        ctx.print(card, () => `added ${card.id}  ${card.title} (${card.status})\n`);
      });
    },
  },
  {
    name: 'needs',
    usage: 'ih needs',
    summary: 'Everything waiting for you: approvals, reviews, blocked cards, messages',
    async run(ctx) {
      await withTarget(ctx, async (t) => {
        const board = await resolveBoard(t.api, ctx.flags.board, ctx.io);
        const needs = await loadNeeds(t.api, board.id);
        ctx.print(needs, () => (needs.length ? table(needs.map((n) => [n.kind, n.id, n.title, ago(n.at)]), ['KIND', 'ID', 'WHAT', 'WHEN'], 90) : 'Nothing is waiting for you.\n'));
      });
    },
  },
  {
    name: 'approvals',
    usage: 'ih approvals [--status pending|approved|denied]',
    summary: 'List approval requests (new agents, installs, grants, escalations)',
    options: { status: { type: 'string' } },
    async run(ctx) {
      await withTarget(ctx, async (t) => {
        const board = await resolveBoard(t.api, ctx.flags.board, ctx.io);
        const list = await t.api.approvals(board.id, (str(ctx.values.status) as 'pending' | undefined) ?? 'pending');
        ctx.print(list, () => (list.length ? table(list.map((a) => [a.id, a.kind, a.summary, ago(a.createdAt)]), ['ID', 'KIND', 'WHAT', 'WHEN'], 90) : 'No approvals.\n'));
      });
    },
  },
  ...(['approve', 'deny'] as const).map(
    (decision): Command => ({
      name: decision,
      usage: `ih ${decision} <approval id> [--note TEXT]`,
      summary: decision === 'approve' ? 'Approve a request (an escalation needs --note: your answer)' : 'Deny a request',
      options: { note: { type: 'string', short: 'n' } },
      async run(ctx) {
        need(ctx, 1, 'an approval id');
        const { t, id } = await open(ctx, ctx.args[0]);
        try {
          const board = await resolveBoard(t.api, ctx.flags.board, ctx.io);
          const pending = await t.api.approvals(board.id);
          const hits = pending.filter((a) => a.id === id || a.id.startsWith(id));
          if (hits.length !== 1) throw new UsageError(hits.length ? `"${id}" matches ${hits.length} approvals; type more of the id` : `no pending approval "${id}"`);
          const a = hits[0]!;
          if (decision === 'approve' && a.kind === 'escalation' && !str(ctx.values.note)) throw new UsageError('this is a question from an agent: give your answer with --note "…"');
          const done = await t.api.decide(a.id, decision, str(ctx.values.note));
          ctx.print(done, () => `${decision === 'approve' ? 'approved' : 'denied'}: ${a.summary}\n`);
        } finally {
          t.close();
        }
      },
    }),
  ),
  {
    name: 'message',
    usage: 'ih message <card> <text…> [--urgent]',
    summary: 'Send a message to a card\'s agent (arrives at its next turn; --urgent interrupts)',
    options: { urgent: { type: 'boolean' } },
    async run(ctx) {
      need(ctx, 2, 'a card and a message');
      await withCard(ctx, ctx.args[0]!, async (t, card) => {
        const m = await t.api.sendMessage(card.id, ctx.args.slice(1).join(' '), Boolean(ctx.values.urgent));
        ctx.print(m, () => `sent to ${card.id}${m.urgent ? ' (urgent)' : ''}\n`);
      });
    },
  },
  {
    name: 'review',
    usage: 'ih review <card> approve|changes [--notes TEXT]',
    summary: 'Give your verdict on a finished card',
    options: { notes: { type: 'string', short: 'n' } },
    async run(ctx) {
      need(ctx, 2, 'a card and a verdict');
      const verdict = ctx.args[1];
      if (verdict !== 'approve' && verdict !== 'changes') throw new UsageError('the verdict is approve or changes');
      if (verdict === 'changes' && !str(ctx.values.notes)) throw new UsageError('say what to change with --notes "…"');
      await withCard(ctx, ctx.args[0]!, async (t, card) => {
        const done = await t.api.review(card.id, verdict, str(ctx.values.notes) ?? '');
        ctx.print(done, () => `${verdict === 'approve' ? 'approved' : 'sent back'}: ${card.title}\n`);
      });
    },
  },
  {
    name: 'land',
    usage: 'ih land <card>',
    summary: 'Land a card now (skips the wait in the merge queue; tests still run)',
    async run(ctx) {
      need(ctx, 1, 'a card');
      await withCard(ctx, ctx.args[0]!, async (t, card) => {
        const done = await t.api.land(card.id);
        ctx.print(done, () => `landing: ${card.title}\n`);
      });
    },
  },
  {
    name: 'move',
    usage: `ih move <card> <${CARD_STATUSES.join('|')}>`,
    summary: 'Move a card to another column',
    async run(ctx) {
      need(ctx, 2, 'a card and a status');
      const status = ctx.args[1] as CardStatus;
      if (!(CARD_STATUSES as readonly string[]).includes(status)) throw new UsageError(`status is one of ${CARD_STATUSES.join(', ')}`);
      await withCard(ctx, ctx.args[0]!, async (t, card) => {
        const done = await t.api.moveCard(card.id, status);
        ctx.print(done, () => `${card.title} → ${done.status}\n`);
      });
    },
  },
  {
    name: 'cancel',
    usage: 'ih cancel <card>',
    summary: 'Stop a card\'s running session',
    async run(ctx) {
      need(ctx, 1, 'a card');
      await withCard(ctx, ctx.args[0]!, async (t, card) => {
        const done = await t.api.cancel(card.id);
        ctx.print(done, () => `cancelled: ${card.title}\n`);
      });
    },
  },
  {
    name: 'worktree',
    usage: 'ih worktree remove <card> [--force]',
    summary: 'Delete a card\'s worktree folder (its branch stays); refuses uncommitted changes unless --force',
    options: { force: { type: 'boolean' } },
    async run(ctx) {
      if (ctx.args[0] !== 'remove') throw new UsageError('the only worktree command is: ih worktree remove <card> [--force]');
      need(ctx, 2, 'a card');
      await withCard(ctx, ctx.args[1]!, async (t, card) => {
        const r = await t.api.removeWorktree(card.id, Boolean(ctx.values.force));
        ctx.print(r, () => `removed the worktree of ${card.title}${r.discarded.length ? ` (discarded ${r.discarded.length} uncommitted file${r.discarded.length === 1 ? '' : 's'})` : ''}; branch ${r.branch ?? '-'} kept\n`);
      });
    },
  },
  {
    name: 'changes',
    usage: 'ih changes <card>',
    summary: 'Files and commits a card changed',
    async run(ctx) {
      need(ctx, 1, 'a card');
      await withCard(ctx, ctx.args[0]!, async (t, card) => {
        const c = await t.api.changes(card.id);
        ctx.print(c, () => table(c.files.map((f) => [f.status, f.path, f.additions === null ? '' : `+${f.additions} -${f.deletions}`]), ['', 'FILE', 'LINES']) + (c.landed ? '(landed)\n' : ''));
      });
    },
  },
  {
    name: 'diff',
    usage: 'ih diff <card> [--path FILE]',
    summary: 'A card\'s diff against the board\'s base',
    options: { path: { type: 'string' } },
    async run(ctx) {
      need(ctx, 1, 'a card');
      await withCard(ctx, ctx.args[0]!, async (t, card) => {
        const d = await t.api.diff(card.id, str(ctx.values.path));
        ctx.print(d, () => d.diff);
      });
    },
  },
  {
    name: 'events',
    usage: 'ih events <card> [--tail N]',
    summary: 'A card\'s event log',
    options: { tail: { type: 'string' } },
    async run(ctx) {
      need(ctx, 1, 'a card');
      await withCard(ctx, ctx.args[0]!, async (t, card) => {
        const all = await t.api.events(card.id);
        const events = all.slice(-(Number(str(ctx.values.tail)) || 50));
        ctx.print(events, () => table(events.map((e) => [String(e.seq), e.type, e.actor, ago(e.ts)]), ['SEQ', 'TYPE', 'ACTOR', 'WHEN']));
      });
    },
  },
  {
    name: 'pools',
    usage: 'ih pools',
    summary: 'Pools with their quota windows',
    async run(ctx) {
      await withTarget(ctx, async (t) => {
        const pools = await t.api.pools();
        ctx.print(pools, () => table(pools.map((p) => [p.id, p.status.state, healthText(p), `${p.running} running`, p.status.windows.map((w) => `${w.window} ${pct(w.pct)}`).join('  ')]), ['POOL', 'STATE', 'MODEL', 'SESSIONS', 'WINDOWS']));
      });
    },
  },
  {
    name: 'pool',
    usage: 'ih pool test <pool> | ih pool restore <pool>',
    summary: "Check now whether a pool's model answers, or put a pool that was taken out of rotation (its endpoint stopped answering) back in",
    async run(ctx) {
      const [sub, id] = ctx.args;
      if ((sub !== 'test' && sub !== 'restore') || !id) throw new UsageError('ih pool test <pool> | ih pool restore <pool>');
      await withTarget(ctx, async (t) => {
        const view = await (sub === 'test' ? t.api.testPool(id) : t.api.restorePool(id));
        ctx.print(view, () =>
          sub === 'restore'
            ? `${id} is back in rotation (${view.reachable === 'online' ? 'answering' : view.reachable === 'offline' ? `but not answering right now: ${view.detail ?? 'no response'}` : 'not checked yet'}).\n`
            : `${id}: ${view.reachable === 'online' ? `online${view.latencyMs !== null ? ` in ${view.latencyMs} ms` : ''}${view.detail ? ` (${view.detail})` : ''}` : `no response${view.detail ? ` (${view.detail})` : ''}`}${view.ejected ? `\nout of rotation since ${view.ejected.since}: ${view.ejected.reason}\nput it back with: ih pool restore ${id}` : ''}\n`,
        );
      });
    },
  },
  {
    name: 'messages',
    usage: 'ih messages [clear [MESSAGE ID...]]',
    summary: 'Messages agents left for you; clear some (or all) once you have read them. They stay in the card\'s log',
    async run(ctx) {
      const [sub, ...ids] = ctx.args;
      if (sub !== undefined && sub !== 'clear') throw new UsageError('ih messages [clear [MESSAGE ID...]]');
      await withTarget(ctx, async (t) => {
        const board = await resolveBoard(t.api, ctx.flags.board, ctx.io);
        if (sub === 'clear') {
          const r = await t.api.dismissMessages(board.id, ids.length ? ids : undefined);
          return ctx.print(r, () => `cleared ${r.dismissed.length} message${r.dismissed.length === 1 ? '' : 's'}\n`);
        }
        const open = (await t.api.messages(board.id)).filter((m) => m.toCard === null && !m.fromActor.startsWith('user:') && !m.dismissedAt);
        ctx.print(open, () => (open.length ? table(open.map((m) => [m.id, m.fromActor.replace(/^card:/, 'card '), m.body.split('\n')[0]!, ago(m.createdAt)]), ['ID', 'FROM', 'MESSAGE', 'WHEN'], 90) : 'No messages for you.\n'));
      });
    },
  },
  {
    name: 'weight',
    usage: 'ih weight [AGENT [N | reset]]',
    summary: 'Tilt automatic routing: show the weights, or set one (1 is neutral, above favours, below holds back, 0 keeps cards off the agent)',
    async run(ctx) {
      await withTarget(ctx, async (t) => {
        const board = await resolveBoard(t.api, ctx.flags.board, ctx.io);
        const settings = await t.api.settings(board.id);
        const weights = settings.agentWeights ?? {};
        const [agent, value] = ctx.args;
        if (agent && value !== undefined) {
          if (!settings.agents.some((a) => a.id === agent) && !(await t.api.priors(board.id)).some((a) => a.agentId === agent)) throw new UsageError(`no agent called ${agent} (see: ih weight)`);
          const { [agent]: _, ...rest } = weights;
          const n = value === 'reset' ? 1 : Number(value);
          if (!Number.isFinite(n) || n < 0 || n > 10) throw new UsageError('the weight is a number from 0 to 10, or "reset"');
          const next = (await t.api.updateSettings(board.id, { agentWeights: n === 1 ? rest : { ...rest, [agent]: n } })).agentWeights ?? {};
          ctx.print(next, () => `${agent}: weight ${next[agent] ?? 1}`);
          return;
        }
        const rows = (await t.api.priors(board.id)).filter((a) => a.role !== 'orchestrator');
        const shown = agent ? rows.filter((a) => a.agentId === agent) : rows;
        ctx.print(Object.fromEntries(shown.map((a) => [a.agentId, weights[a.agentId] ?? 1])), () =>
          table(shown.map((a) => [a.agentId, `${a.poolId}/${a.model || '-'}`, String(weights[a.agentId] ?? 1)]), ['AGENT', 'MODEL', 'WEIGHT']),
        );
      });
    },
  },
  {
    name: 'metrics',
    usage: 'ih metrics [--hours N]',
    summary: 'Tokens, cost and budgets for the board',
    options: { hours: { type: 'string' } },
    async run(ctx) {
      await withTarget(ctx, async (t) => {
        const board = await resolveBoard(t.api, ctx.flags.board, ctx.io);
        const m = await t.api.metrics(board.id, Number(str(ctx.values.hours)) || 24);
        ctx.print(m, () =>
          [
            `last ${m.hours}h: ${m.totals.tokens} tokens, $${m.totals.costUsd.toFixed(2)}, ${m.totals.requests} requests`,
            table(m.byAgent.map((a) => [a.agentId, a.poolId, String(a.tokens), `$${a.costUsd.toFixed(2)}`]), ['AGENT', 'POOL', 'TOKENS', 'COST']),
            m.budgets.length ? table(m.budgets.map((b) => [b.scope, b.state, pct(b.pct)]), ['BUDGET', 'STATE', 'USED']) : '',
          ].join('\n'),
        );
      });
    },
  },
  {
    name: 'watch',
    usage: 'ih watch [--count N] [--card ID]',
    summary: 'Follow the live event stream (one JSON line per event) until Ctrl+C',
    options: { count: { type: 'string' }, card: { type: 'string' } },
    async run(ctx) {
      const { t, id } = await open(ctx, str(ctx.values.card));
      const limit = Number(str(ctx.values.count)) || Infinity;
      let seen = 0;
      await new Promise<void>((resolve) => {
        const stream = new EventStream(
          () => t.api.wsUrl('/ws'),
          (m: StreamMessage) => {
            if (isLive(m) || (id && m.subject !== id)) return;
            ctx.io.out(JSON.stringify(m) + '\n');
            if (++seen >= limit) done();
          },
        );
        const done = () => {
          stream.dispose();
          t.close();
          resolve();
        };
        ctx.io.signal?.addEventListener('abort', done, { once: true });
        if (ctx.io.signal?.aborted) done();
      });
    },
  },
  {
    name: 'terminal',
    usage: 'ih terminal <card>',
    summary: `Attach to a Claude session's live terminal (${DETACH_HINT})`,
    async run(ctx) {
      need(ctx, 1, 'a card');
      if (!ctx.io.stdin || !ctx.io.stdout) throw new UsageError('attaching needs a terminal');
      await withCard(ctx, ctx.args[0]!, async (t, card) => {
        ctx.io.err(`attached to ${card.title}; ${DETACH_HINT}\r\n`);
        const result = await attachTerminal(t.api, card.id, { stdin: ctx.io.stdin!, stdout: ctx.io.stdout! });
        if (result === 'unavailable') throw new Error('this card has no live terminal (only Claude sessions have one)');
        ctx.io.err(`\r\n[${result}]\r\n`);
      });
    },
  },
];
