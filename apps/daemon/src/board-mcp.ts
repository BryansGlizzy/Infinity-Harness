import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { WORK_TYPES, effectiveAgents, renderHandoff, validateAgents, type AgentProfile, type Artifact, type DaemonEvent, type Message } from '@mh/core';
import type { Store } from '@mh/db';
import type { ContextService, SearchHit } from '@mh/context';
import { quickAnswerJob, readQuickAnswer, type FastLane } from '@mh/fast-lane';
import { currentArtifact, lastAgentMessage } from './context.ts';
import { councilOf, renderProposal } from './council.ts';
import type { Approvals } from './approvals.ts';
import type { IdeBridge } from './ide.ts';
import { revParse } from './git.ts';
import { LeaseConflict, normalizeGlob, overlaps, reservePaths } from './leases.ts';
import type { RunIdentity, Runner } from './runner.ts';

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const error = (message: string) => ({ ...text(message), isError: true });

export interface BoardMcpExtras {
  context?: ContextService | null;
  fastLane?: FastLane | null;
  /** Requests that wait for a human (Phase 6.4); without it the tools that need it are not offered. */
  approvals?: Approvals | null;
  /** Attached VS Code windows (Phase 6.1); the `ide_*` tools appear while one is attached to the board. */
  bridge?: IdeBridge | null;
  /** Folder with the agent-facing docs (`get_docs`). */
  docsDir?: string;
}

/** Kinds agents write with put_artifact; specs and summaries are captured by the daemon, handoffs via write_handoff. */
const AGENT_KINDS = ['decision', 'contract', 'finding', 'note'] as const;
const ASK_TIMEOUT_DEFAULT = 120;
const ASK_TIMEOUT_MAX = 600;

const excerpt = (a: Artifact, n = 400) => (a.summary ? a.summary : a.body.length > n ? `${a.body.slice(0, n)}…` : a.body);
const hitView = (h: SearchHit, me: string) => ({
  id: h.artifact.id,
  kind: h.artifact.kind,
  title: h.artifact.title,
  card: h.artifact.cardId,
  yours: h.artifact.cardId === me || undefined,
  excerpt: excerpt(h.artifact),
  tags: h.artifact.tags.length ? h.artifact.tags : undefined,
  version: h.artifact.version > 1 ? h.artifact.version : undefined,
  written_at_commit: h.artifact.commitSha ?? undefined,
  match: h.via.join('+'),
});

/** Waits for a message from one card to another, posted after `afterSeq`. */
function waitForReply(store: Store, from: string, to: string, ms: number): Promise<Message | null> {
  return new Promise((resolve) => {
    const done = (m: Message | null) => {
      clearTimeout(timer);
      off();
      resolve(m);
    };
    const off = store.onEvent((e: DaemonEvent) => {
      if (e.type !== 'message.posted') return;
      const m = e.payload as Message;
      if (m.fromActor === `card:${from}` && m.toCard === to) done(m);
    });
    const timer = setTimeout(() => done(null), ms);
  });
}

/** The "board" MCP server every agent session gets (master plan §5.3). Tools act as the calling card. */
function boardServer(me: RunIdentity, store: Store, runner: Runner, extras: BoardMcpExtras = {}): McpServer {
  const { context, fastLane, approvals, bridge } = extras;
  const server = new McpServer({ name: 'board', version: '0.1.0' });
  const boardId = me.board.id;

  server.registerTool(
    'whoami',
    { description: 'Your card, board, branch and worktree.' },
    async () => {
      const card = store.getCard(me.card.id)!;
      return text({
        card: { id: card.id, title: card.title, role: card.role, status: card.status, branch: card.branch, worktree: card.worktree },
        board: me.board.name,
        pool: me.pool.id,
        agent: card.agentId,
        model: me.pool.model,
      });
    },
  );

  server.registerTool(
    'list_cards',
    { description: 'All cards on the board: status, role, parent, what they wait for, work type, complexity, agent, pool and branch.' },
    async () => {
      const deps = store.dependencies(boardId);
      return text(
        store.listCards(boardId).map((c) => ({
          id: c.id,
          title: c.title,
          status: c.status,
          role: c.role,
          parent: c.parentId,
          blocked_by: deps.filter((d) => d.cardId === c.id).map((d) => d.blockedBy),
          work_type: c.workType,
          complexity: c.classification ? Math.round(c.classification.complexity * 10) / 10 : undefined,
          pool: c.poolId,
          agent_id: c.agentId,
          branch: c.branch,
          agent: runner.sessionState(c.id),
          you: c.id === me.card.id || undefined,
        })),
      );
    },
  );

  // --- tree tools (master plan §5.3 "Tree"), gated by role permissions and guardrails (§5.9)

  const settings = () => store.getSettings(boardId);
  const myRole = () => store.getCard(me.card.id)?.role ?? 'worker';
  /** True when `id` is the caller's card or below it: agents act on their own subtree only. */
  const inMySubtree = (id: string) => {
    for (let c = store.getCard(id); c; c = c.parentId ? store.getCard(c.parentId) : undefined) if (c.id === me.card.id) return true;
    return false;
  };
  const withCriteria = (description: string, criteria?: string[]) =>
    criteria?.length ? `${description.trim()}\n\nAcceptance criteria:\n${criteria.map((c) => `- ${c}`).join('\n')}` : description.trim();

  /** Splits requested grants into those given outright and those that wait for a human; refuses unknown or switched-off ones. */
  const checkGrants = (names: string[]): { auto: string[]; needsApproval: string[] } | { error: string } => {
    const s = settings();
    if (!s.permissions[myRole()].canRequestGrants) return { error: `Your role (${myRole()}) may not request tool grants.` };
    const auto: string[] = [];
    const needsApproval: string[] = [];
    for (const name of names) {
      const g = s.grants[name];
      if (!g || g.mode === 'off' || !g.command.trim()) return { error: `No tool grant "${name}" is available. Available: ${Object.entries(s.grants).filter(([, x]) => x.mode !== 'off' && x.command.trim()).map(([n]) => n).join(', ') || 'none'}.` };
      (g.mode === 'auto' ? auto : needsApproval).push(name);
    }
    return { auto, needsApproval };
  };
  const requestGrant = async (cardId: string, name: string, why: string) => {
    if (!approvals) return null;
    const g = settings().grants[name]!;
    return approvals.request({
      boardId,
      cardId,
      kind: 'grant',
      payload: { grant: name },
      requestedBy: `card:${me.card.id}`,
      summary: `${store.getCard(cardId)?.title ?? cardId} asks for the ${g.label} tool grant (${why}).`,
      facts: [`Grant: ${g.label} — ${g.description}`, `Why: ${why}`],
    });
  };

  server.registerTool(
    'create_subtask',
    {
      description:
        'Create a card under your card (or under one of its descendants with parent_id). It starts automatically on the best available agent once the cards in blocked_by have finished. Give a clear title, the context and files involved, and acceptance criteria. delegate=true makes it a lead card: a lead agent breaks it down into its own cards instead of coding it.',
      inputSchema: {
        title: z.string().min(3).max(140),
        description: z.string().describe('Context: what to change and where, constraints, relevant files'),
        acceptance_criteria: z.array(z.string()).min(1).describe('Checks a reviewer can verify'),
        work_type: z.enum(WORK_TYPES).optional(),
        blocked_by: z.array(z.string()).optional().describe('Ids of cards that must finish first'),
        parent_id: z.string().optional().describe('Defaults to your card'),
        delegate: z.boolean().optional().describe('A large chunk for a lead agent to plan further (only when lead agents are on your team)'),
        needs_network: z.boolean().optional().describe('The card installs packages or downloads things from its shell. Agents whose shell has no network (Codex) are skipped.'),
        grants: z.array(z.string()).optional().describe('Tool grants for the card, e.g. "browser" to check a UI in a headless browser. Some wait for a human to approve first.'),
      },
    },
    async ({ title, description, acceptance_criteria, work_type, blocked_by, parent_id, delegate, needs_network, grants }) => {
      const s = settings();
      if (!s.permissions[myRole()].canCreateCards) return error(`Your role (${myRole()}) may not create cards. Ask the human or the orchestrator.`);
      const council = councilOf(store, store.getCard(me.card.id)!);
      if (council?.member && council.council.phase === 'proposing') {
        return error('The council is still choosing a split: call propose_split and end your turn. You will be asked to plan your share next.');
      }
      const role = delegate ? 'lead' : 'worker';
      const caller = store.getCard(me.card.id)!;
      const team = runner.team(caller);
      if (!team.some((t) => t.agent.role === role)) {
        const names = team.map((t) => `${t.agent.id} (${t.agent.role})`).join(', ') || 'none';
        return error(
          delegate
            ? `No lead agent is on your team (${names}). Create worker cards instead.`
            : `No worker agent is on your team (${names}). Pass delegate=true so a lead plans it.`,
        );
      }
      const parentId = parent_id ?? me.card.id;
      const parent = store.getCard(parentId);
      if (!parent || parent.boardId !== boardId) return error(`No card ${parentId} on this board.`);
      if (!inMySubtree(parentId)) return error('You may only add cards under your own card or its descendants.');
      if (parent.depth + 1 > s.maxDepth) return error(`Too deep: the tree is limited to ${s.maxDepth} levels.`);
      if (store.children(parentId).length >= s.maxChildren) return error(`Card ${parentId} already has ${s.maxChildren} children (the limit).`);
      const since = runner.turnStartedAt(me.card.id) ?? new Date(0).toISOString();
      if (store.countCreatedBy(`card:${me.card.id}`, since) >= s.maxCardsPerTurn) {
        return error(`You created ${s.maxCardsPerTurn} cards this turn (the limit). Finish the turn; the human can raise the cap.`);
      }
      for (const id of blocked_by ?? []) {
        const b = store.getCard(id);
        if (!b || b.boardId !== boardId) return error(`blocked_by: no card ${id} on this board. Use list_cards.`);
      }
      // Grants: `auto` ones are given; `approval` ones wait for a human (the card does not start until decided).
      const wanted = [...new Set(grants ?? [])];
      const gate = wanted.length ? checkGrants(wanted) : null;
      if (gate && 'error' in gate) return error(gate.error);
      // Children go only to the caller's delegation targets (master plan Phase 3.5); their own children inherit this.
      // A card with its own rules doesn't inherit its parent's, so needs_network carries them along.
      const rules = runner.childRouting(caller);
      const routing = needs_network ? { ...(rules ?? store.effectiveRouting(parentId) ?? {}), needsNetwork: true } : rules;
      // Created in Backlog and moved to Ready only once its dependencies exist, so it can't start too early.
      const card = store.createCard({
        boardId,
        parentId,
        title,
        description: withCriteria(description, acceptance_criteria),
        workType: work_type ?? null,
        role,
        routing,
        status: 'backlog',
        createdBy: `card:${me.card.id}`,
        grants: gate?.auto ?? [],
      });
      for (const name of gate?.needsApproval ?? []) await requestGrant(card.id, name, `${store.getCard(me.card.id)?.title ?? me.card.id} asked for it when creating the card`);
      try {
        for (const id of blocked_by ?? []) store.addDependency(card.id, id, `card:${me.card.id}`);
      } catch (err) {
        return error(`Card ${card.id} created but left in Backlog: ${(err as Error).message}`);
      }
      store.updateCard(card.id, { status: 'ready' }, `card:${me.card.id}`);
      const notInstalled = approvals?.missingTools(boardId, wanted) ?? [];
      return text({
        created: card.id,
        title,
        role,
        parent: parentId,
        blocked_by: blocked_by ?? [],
        ...(notInstalled.length ? { note: `Not installed on this machine: ${notInstalled.join(', ')}. The human will be asked to install it before the card starts.` } : {}),
      });
    },
  );

  server.registerTool(
    'update_subtask',
    {
      description: 'Revise a card you created (for example after its spec was sent back). It returns to Ready unless it is already running.',
      inputSchema: {
        card_id: z.string(),
        title: z.string().min(3).max(140).optional(),
        description: z.string().optional(),
        acceptance_criteria: z.array(z.string()).optional(),
        work_type: z.enum(WORK_TYPES).optional(),
      },
    },
    async ({ card_id, title, description, acceptance_criteria, work_type }) => {
      const card = store.getCard(card_id);
      if (!card || card.boardId !== boardId) return error(`No card ${card_id} on this board.`);
      if (card.id === me.card.id || !inMySubtree(card.id)) return error('You may only update cards below your own.');
      if (runner.isActive(card.id)) return error('That card is being worked on; message it instead.');
      const updated = store.updateCard(
        card.id,
        {
          title,
          description: description !== undefined || acceptance_criteria ? withCriteria(description ?? card.description, acceptance_criteria) : undefined,
          workType: work_type,
          // Re-classify a changed spec.
          classification: description !== undefined || title !== undefined || work_type ? null : undefined,
          status: ['backlog', 'blocked', 'ready'].includes(card.status) ? 'ready' : undefined,
        },
        `card:${me.card.id}`,
      );
      return text({ updated: updated.id, status: updated.status });
    },
  );

  server.registerTool(
    'add_dependency',
    {
      description: 'Make card_id wait until blocked_by has finished. Cycles are refused.',
      inputSchema: { card_id: z.string(), blocked_by: z.string() },
    },
    async ({ card_id, blocked_by }) => {
      if (!settings().permissions[myRole()].canAddDependencies) return error(`Your role (${myRole()}) may not add dependencies.`);
      if (!inMySubtree(card_id)) return error('You may only add dependencies to cards below your own.');
      try {
        store.addDependency(card_id, blocked_by, `card:${me.card.id}`);
        return text(`${card_id} now waits for ${blocked_by}.`);
      } catch (err) {
        return error((err as Error).message);
      }
    },
  );

  server.registerTool(
    'post_message',
    {
      description:
        'Send a message to another card\'s agent, or to="human" for the people watching the board. Delivered at the recipient\'s next turn; urgent=true interrupts its current turn (use sparingly).',
      inputSchema: { to: z.string().describe('Recipient card id, or "human"'), body: z.string().min(1), urgent: z.boolean().optional() },
    },
    async ({ to, body, urgent }) => {
      const toCard = to === 'human' ? null : to;
      if (toCard === me.card.id) return error('You cannot message your own card.');
      if (toCard) {
        const target = store.getCard(toCard);
        if (!target || target.boardId !== boardId) return error(`No card ${toCard} on this board. Use list_cards.`);
      }
      const message = store.postMessage({ boardId, fromActor: `card:${me.card.id}`, toCard, body, urgent: !!urgent });
      if (toCard) runner.deliver(toCard);
      return text(`Sent (${message.id}).`);
    },
  );

  server.registerTool(
    'read_inbox',
    { description: 'Messages for your card that have not been delivered yet, plus the last few already delivered.' },
    async () => {
      const pending = store.pendingMessages(me.card.id);
      store.markDelivered(pending.map((m) => m.id));
      const recent = store
        .boardMessages(boardId)
        .filter((m) => m.toCard === me.card.id && !pending.some((p) => p.id === m.id))
        .slice(-10);
      return text({ new: pending.map(({ id, fromActor, body, urgent }) => ({ id, from: fromActor, body, urgent })), recent: recent.map(({ fromActor, body }) => ({ from: fromActor, body })) });
    },
  );

  server.registerTool(
    'reserve_paths',
    {
      description:
        'Reserve repo-relative files, directories or globs (e.g. "src/auth/**") before editing them, so other agents do not edit them at the same time. All or nothing: if any is held by another card, nothing is reserved and the holders are named. Leases expire after ttl_minutes (default 30) and are released when your turn\'s work is committed.',
      inputSchema: { paths: z.array(z.string().min(1)).min(1), ttl_minutes: z.number().int().min(1).max(240).optional() },
    },
    async ({ paths, ttl_minutes }) => {
      try {
        const leases = reservePaths(store, boardId, me.card.id, paths, (ttl_minutes ?? 30) * 60_000);
        return text({ reserved: leases.map((l) => l.glob), expiresAt: leases[0]?.expiresAt });
      } catch (err) {
        if (err instanceof LeaseConflict) {
          return error(`Not reserved. ${err.message}. Message the holder with post_message, or work on other files.`);
        }
        throw err;
      }
    },
  );

  server.registerTool(
    'release_paths',
    {
      description: 'Release your reservations (all of them, or only the given paths).',
      inputSchema: { paths: z.array(z.string()).optional() },
    },
    async ({ paths }) => text({ released: store.releaseLeases(me.card.id, paths?.map(normalizeGlob)).map((l) => l.glob) }),
  );

  server.registerTool(
    'who_holds',
    { description: 'Current reservations on the board, optionally only those covering a path.', inputSchema: { path: z.string().optional() } },
    async ({ path }) => {
      const leases = store.activeLeases(boardId).filter((l) => !path || overlaps(normalizeGlob(path), l.glob));
      return text(leases.map((l) => ({ glob: l.glob, card: l.cardId, you: l.cardId === me.card.id || undefined, expiresAt: l.expiresAt })));
    },
  );

  server.registerTool(
    'report_blocked',
    {
      description: 'Say you cannot finish this card and why. The card is moved to Blocked when your turn ends.',
      inputSchema: { reason: z.string().min(1) },
    },
    async ({ reason }) => {
      runner.reportBlocked(me.card.id, reason);
      store.postMessage({ boardId, fromActor: `card:${me.card.id}`, toCard: null, body: `Blocked: ${reason}`, urgent: false });
      const started = runner.turnStartedAt(me.card.id);
      const handoff = context ? currentArtifact(store, store.getCard(me.card.id)!, 'handoff') : undefined;
      const wrote = handoff && handoff.author === `card:${me.card.id}` && (!started || handoff.createdAt >= started);
      return text(
        context && !wrote
          ? 'Noted. The card will go to another agent: call write_handoff now (state, decisions, blockers, files, next steps), then finish your turn with a summary.'
          : 'Noted. Finish your turn with a summary of what is done and what is needed.',
      );
    },
  );

  server.registerTool(
    'escalate_to_human',
    {
      description:
        'Ask a human to step in: the card needs a decision, access or information no agent on the board can provide. The card is moved to Blocked when your turn ends and is not retried automatically.',
      inputSchema: { reason: z.string().min(1).describe('What you need from the human, specifically') },
    },
    async ({ reason }) => {
      const card = store.getCard(me.card.id)!;
      store.updateCard(card.id, { pipeline: { ...card.pipeline, escalated: true } }, `card:${me.card.id}`);
      runner.reportBlocked(me.card.id, `escalated: ${reason}`);
      store.postMessage({ boardId, fromActor: `card:${me.card.id}`, toCard: null, body: `Needs a human: ${reason}`, urgent: false });
      // The question waits in the approval queue; answering it resumes the card with the human's note.
      await approvals?.request({ boardId, cardId: card.id, kind: 'escalation', payload: { reason }, requestedBy: `card:${card.id}`, summary: `${card.title} needs a human: ${reason}`, facts: [`Reason: ${reason}`], announce: false });
      return text('A human has been asked. Finish your turn with a summary of where things stand.');
    },
  );

  // --- context (master plan §5.3 "Context", §5.7)

  if (context) {
    server.registerTool(
      'search_context',
      {
        description:
          "Search the board's shared notes: decisions, interface contracts, handoffs, findings, card specs and agents' summaries. Hybrid keyword + semantic search. Use it before designing something another card may share, and when you pick up a card someone else started.",
        inputSchema: {
          query: z.string().min(2).describe('What you want to know, in plain words'),
          scope: z.enum(['card', 'subtree', 'board']).optional().describe('card: your card only; subtree: your parent card and everything under it (your sibling cards); board: everything (default)'),
          kinds: z.array(z.enum(['spec', 'decision', 'contract', 'handoff', 'finding', 'summary', 'note'])).optional(),
          limit: z.number().int().min(1).max(20).optional(),
        },
      },
      async ({ query, scope, kinds, limit }) => {
        const hits = await context.search({ boardId, query, cardId: me.card.id, scope: scope ?? 'board', kinds, limit: limit ?? 8 });
        if (!hits.length) return text('No matching notes. Try other words, or scope "board".');
        return text({ results: hits.map((h) => hitView(h, me.card.id)), hint: 'get_artifact returns the full text.' });
      },
    );

    server.registerTool(
      'get_artifact',
      { description: 'The full text of a note found with search_context (or listed in your prompt).', inputSchema: { id: z.string() } },
      async ({ id }) => {
        const a = store.getArtifact(id);
        if (!a || a.boardId !== boardId) return error(`No artifact ${id} on this board.`);
        const newer = a.supersededBy ? ` (superseded by ${a.supersededBy}; that one is current)` : '';
        return text({ ...a, note: newer || undefined });
      },
    );

    server.registerTool(
      'put_artifact',
      {
        description:
          'Save a note other agents can find with search_context: a decision (a choice and why), a contract (an interface other cards rely on: function signatures, file formats, endpoints), a finding (a gotcha or fact you learned), or a note. Pass supersedes to replace an older version.',
        inputSchema: {
          kind: z.enum(AGENT_KINDS),
          title: z.string().min(3).max(160),
          body: z.string().min(1).max(20_000),
          supersedes: z.string().optional().describe('Id of the artifact this replaces'),
        },
      },
      async ({ kind, title, body, supersedes }) => {
        const card = store.getCard(me.card.id)!;
        if (supersedes) {
          const old = store.getArtifact(supersedes);
          if (!old || old.boardId !== boardId) return error(`No artifact ${supersedes} on this board.`);
          if (old.supersededBy) return error(`${supersedes} was already replaced by ${old.supersededBy}; supersede that one.`);
        }
        const sha = card.branch ? await revParse(me.board.repoPath, card.branch).catch(() => null) : null;
        const a = context.put({ boardId, cardId: me.card.id, kind, title, body, author: `card:${me.card.id}`, commitSha: sha, supersedes: supersedes ?? null });
        return text({ saved: a.id, version: a.version });
      },
    );

    server.registerTool(
      'write_handoff',
      {
        description:
          'Write a handoff note for whoever continues your card: where it stands, decisions made, blockers, files that matter and next steps. Required before report_blocked; also useful before a long turn ends unfinished. Replaces your card\'s previous handoff.',
        inputSchema: {
          state: z.string().min(1).describe('Where the work stands'),
          decisions: z.array(z.string()).optional(),
          blockers: z.array(z.string()).optional(),
          files: z.array(z.string()).optional().describe('Repo-relative paths that matter'),
          next_steps: z.array(z.string()).optional(),
        },
      },
      async ({ state, decisions, blockers, files, next_steps }) => {
        const card = store.getCard(me.card.id)!;
        const body = renderHandoff({ state, decisions: decisions ?? [], blockers: blockers ?? [], files: files ?? [], nextSteps: next_steps ?? [] });
        const sha = card.branch ? await revParse(me.board.repoPath, card.branch).catch(() => null) : null;
        const a = context.put({
          boardId,
          cardId: card.id,
          kind: 'handoff',
          title: `Handoff: ${card.title}`,
          body,
          author: `card:${card.id}`,
          commitSha: sha,
          supersedes: currentArtifact(store, card, 'handoff')?.id ?? null,
        });
        return text({ saved: a.id });
      },
    );
  }

  // --- council planning (2+ orchestrators)

  const council = councilOf(store, me.card);
  if (council?.member) {
    server.registerTool(
      'propose_split',
      {
        description: `Propose how the council splits the goal: one share per member (${council.council.members.map((m) => m.agentId).join(', ')}). Kev compares every member's proposal and the council follows the best one. Call it once; a second call replaces your proposal.`,
        inputSchema: {
          shares: z
            .array(
              z.object({
                member: z.string().describe('A council member agent id'),
                scope: z.string().min(3).describe('What this share covers: features, files, modules'),
                cards: z.array(z.string()).describe('Titles of the cards this share would create'),
              }),
            )
            .min(1),
          rationale: z.string().describe('Why this split: boundaries, and how it plays to each member\'s team'),
        },
      },
      async ({ shares, rationale }) => {
        const now = councilOf(store, store.getCard(me.card.id)!);
        if (!now || now.council.phase !== 'proposing') return error('The council has already chosen its split.');
        const ids = now.council.members.map((m) => m.agentId);
        const unknown = shares.filter((s) => !ids.includes(s.member)).map((s) => s.member);
        if (unknown.length) return error(`Not council members: ${unknown.join(', ')}. Members: ${ids.join(', ')}.`);
        const old = store.listArtifacts(boardId, { cardIds: [me.card.id], kinds: ['proposal'] })[0];
        const body = renderProposal(now.member!.agentId, shares, rationale);
        const input = { boardId, cardId: me.card.id, kind: 'proposal' as const, title: `Council proposal: ${now.member!.agentId}`, body, author: `card:${me.card.id}`, supersedes: old?.id ?? null };
        const a = context ? context.put(input) : store.putArtifact(input);
        const missing = ids.filter((id) => !shares.some((s) => s.member === id));
        return text({ saved: a.id, note: missing.length ? `No share for ${missing.join(', ')}: they will create no cards if this proposal wins.` : undefined });
      },
    );
  }

  server.registerTool(
    'ask_agent',
    {
      description:
        "Ask another card's agent a question and wait for the answer. An idle agent is asked directly. A busy one is not interrupted: the answer comes from its notes (spec, decisions, contracts, summaries) when they cover it; otherwise the question waits in its inbox and its reply reaches yours.",
      inputSchema: {
        card_id: z.string(),
        question: z.string().min(3),
        timeout_seconds: z.number().int().min(10).max(ASK_TIMEOUT_MAX).optional().describe(`How long to wait for an idle agent's reply (default ${ASK_TIMEOUT_DEFAULT})`),
      },
    },
    async ({ card_id, question, timeout_seconds }) => {
      const target = store.getCard(card_id);
      if (!target || target.boardId !== boardId) return error(`No card ${card_id} on this board. Use list_cards.`);
      if (target.id === me.card.id) return error('That is your own card.');
      const ask = () =>
        store.postMessage({
          boardId,
          fromActor: `card:${me.card.id}`,
          toCard: target.id,
          body: `Question from card ${me.card.id}: ${question}\n(Answer with post_message to "${me.card.id}".)`,
          urgent: false,
        });

      if (runner.sessionState(target.id) === 'idle') {
        const reply = waitForReply(store, target.id, me.card.id, (timeout_seconds ?? ASK_TIMEOUT_DEFAULT) * 1000);
        ask();
        runner.deliver(target.id);
        const m = await reply;
        if (!m) return text({ answered: false, note: `No reply within ${timeout_seconds ?? ASK_TIMEOUT_DEFAULT}s. It will arrive in your inbox (read_inbox).` });
        store.markDelivered([m.id]);
        return text({ answered: true, from: 'agent', answer: m.body });
      }

      // Busy, or no live session: answer from its notes (fast lane #2) rather than interrupting or waiting.
      if (context && fastLane?.available && store.getSettings(boardId).quickAnswers) {
        const hits = await context.search({ boardId, query: question, cardId: target.id, scope: 'card', limit: 6 });
        const summary = lastAgentMessage(store, target.id);
        const notes = [
          `Spec: ${target.title}\n${target.description}`,
          ...hits.filter((h) => h.artifact.kind !== 'spec').map((h) => `[${h.artifact.id}] ${h.artifact.kind}: ${h.artifact.title}\n${h.artifact.body.slice(0, 2500)}`),
          summary ? `Its latest message:\n${summary.slice(-2000)}` : '',
        ]
          .filter(Boolean)
          .join('\n\n---\n\n');
        const result = await fastLane.run(quickAnswerJob(question, target.title, notes));
        const answer = result ? readQuickAnswer(result.text) : null;
        if (answer) {
          store.append('session.event', target.id, { sessionId: null, event: { type: 'message', role: 'agent', text: `[quick answer from notes, to ${me.card.id}] ${answer}` } }, 'fast-lane');
          return text({
            answered: true,
            from: 'notes',
            answer,
            sources: hits.map((h) => h.artifact.id),
            note: 'Answered from the card\'s notes by the fast lane, not by the agent itself. Ask again with post_message if it matters and seems wrong.',
          });
        }
      }
      ask();
      runner.deliver(target.id);
      return text({ answered: false, note: `Its agent is ${runner.sessionState(target.id) ?? 'not running'} and its notes don't answer this. The question is in its inbox; the reply will arrive in yours.` });
    },
  );

  // --- docs for agents (Phase 6.4)

  server.registerTool(
    'get_docs',
    {
      description: 'The board\'s guide for agents: the board tools, conventions, tool access, and how to ask for an MCP server, a skill or a tool grant. Call without a topic for the list.',
      inputSchema: { topic: z.string().regex(/^[a-z0-9-]+$/).optional() },
    },
    async ({ topic }) => {
      const dir = extras.docsDir;
      if (!dir) return error('No agent docs are installed on this daemon.');
      try {
        if (!topic) return text({ topics: readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort(), hint: 'Call get_docs with a topic.' });
        return text(readFileSync(join(dir, `${topic}.md`), 'utf8'));
      } catch {
        return error(`No doc "${topic ?? ''}". Call get_docs without a topic for the list.`);
      }
    },
  );

  // --- governance: requests that wait for a human (Phase 6.4)

  if (approvals) {
    server.registerTool(
      'spawn_agent',
      {
        description:
          'Ask for a new agent on the board: a pool plus a model and a role. It joins the team once a human approves (or at once, if the board auto-approves). Use it when the work needs a model nobody on the team runs.',
        inputSchema: {
          id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/i).describe('A short unique name, e.g. "kimi-tests"'),
          pool: z.string().describe('The pool it runs on (see whoami / the team list)'),
          model: z.string().optional().describe('A model that pool offers; empty uses the pool default'),
          reasoning: z.string().optional(),
          role: z.enum(['worker', 'lead']).optional(),
          reason: z.string().min(3).describe('Why the team needs it'),
        },
      },
      async ({ id, pool, model, reasoning, role, reason }) => {
        if (!settings().permissions[myRole()].canSpawnAgents) return error(`Your role (${myRole()}) may not spawn agents. Ask the orchestrator or a human.`);
        if (!runner.pools().some((p) => p.id === pool)) return error(`No pool "${pool}". Pools: ${runner.pools().map((p) => p.id).join(', ')}.`);
        const agent: AgentProfile = { id, poolId: pool, model: model ?? '', ...(reasoning ? { reasoning } : {}), role: role ?? 'worker', delegatesTo: [], enabled: true };
        const next = [...settings().agents.filter((a) => a.id !== id), agent];
        const problem = validateAgents([...next, ...effectiveAgents({ agents: next }, runner.pools()).filter((a) => a.implicit)]);
        if (problem) return error(problem);
        const a = await approvals.request({
          boardId,
          cardId: me.card.id,
          kind: 'spawn_agent',
          payload: { agent },
          requestedBy: `card:${me.card.id}`,
          summary: `${store.getCard(me.card.id)?.title ?? me.card.id} asks for a new ${agent.role} agent "${id}" on ${pool}${agent.model ? ` (${agent.model})` : ''}: ${reason}`,
          facts: [`Agent: ${id}, ${agent.role} on ${pool}${agent.model ? `, model ${agent.model}` : ''}`, `Why: ${reason}`],
        });
        if (settings().autoApproveSpawn) {
          try {
            approvals.decide(a.id, 'approved', 'auto');
            return text({ approved: true, agent: id, note: 'The board auto-approves new agents. It can take cards now.' });
          } catch (err) {
            return error((err as Error).message);
          }
        }
        return text({ pending: a.id, note: 'A human has to approve this. You will get a message with the decision; carry on with what you can.' });
      },
    );

    server.registerTool(
      'propose_mcp',
      {
        description:
          'Propose an MCP server for the board (a local command or a remote URL). A human reviews it; if approved, every new agent session gets it. Say what it is for. Never put secrets in env: name the variables a human must set.',
        inputSchema: {
          name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
          command: z.string().optional().describe('Executable for a local (stdio) server, e.g. "npx"'),
          args: z.array(z.string()).optional(),
          env: z.record(z.string(), z.string()).optional(),
          url: z.string().url().optional().describe('Streamable HTTP endpoint for a remote server'),
          reason: z.string().min(3),
        },
      },
      async ({ name, command, args, env, url, reason }) => {
        if (!settings().permissions[myRole()].canInstallMcp) return error(`Your role (${myRole()}) may not propose MCP servers or skills. Ask the orchestrator or a human.`);
        if (name === 'board' || name.startsWith('grant-')) return error(`"${name}" is reserved.`);
        if (!!command === !!url) return error('Give either command (a local server) or url (a remote one).');
        const mcp = { name, ...(command ? { command, args: args ?? [], env: env ?? {} } : { url }) };
        const a = await approvals.request({
          boardId,
          cardId: me.card.id,
          kind: 'install_mcp',
          payload: { mcp },
          requestedBy: `card:${me.card.id}`,
          summary: `${store.getCard(me.card.id)?.title ?? me.card.id} proposes the MCP server "${name}" (${command ? [command, ...(args ?? [])].join(' ') : url}): ${reason}`,
          facts: [`MCP server ${name}: ${command ? [command, ...(args ?? [])].join(' ') : url}`, `Why: ${reason}`],
        });
        return text({ pending: a.id, note: 'A human has to approve this. If they do, new agent sessions get the server; yours does not.' });
      },
    );

    server.registerTool(
      'propose_skill',
      {
        description:
          'Propose a skill for the board: instructions every worker should follow in some situation (a testing recipe, a house style). A human reviews it; if approved, new worker prompts carry it.',
        inputSchema: {
          name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
          description: z.string().min(3).max(200).describe('When to use it, in one line'),
          body: z.string().min(10).max(4000).describe('The instructions'),
        },
      },
      async ({ name, description, body }) => {
        if (!settings().permissions[myRole()].canInstallMcp) return error(`Your role (${myRole()}) may not propose MCP servers or skills. Ask the orchestrator or a human.`);
        const a = await approvals.request({
          boardId,
          cardId: me.card.id,
          kind: 'install_skill',
          payload: { skill: { name, description, body } },
          requestedBy: `card:${me.card.id}`,
          summary: `${store.getCard(me.card.id)?.title ?? me.card.id} proposes the skill "${name}": ${description}`,
          facts: [`Skill ${name}: ${description}`, body.slice(0, 600)],
        });
        return text({ pending: a.id, note: 'A human has to approve this. If they do, new worker prompts carry the skill.' });
      },
    );

    server.registerTool(
      'request_grant',
      {
        description:
          'Ask for a tool grant for your card (for example "browser" to check a UI in a headless browser). Grants set to auto are given at once; others wait for a human. A grant takes effect the next time your card runs.',
        inputSchema: { grant: z.string(), reason: z.string().min(3) },
      },
      async ({ grant, reason }) => {
        const gate = checkGrants([grant]);
        if ('error' in gate) return error(gate.error);
        const card = store.getCard(me.card.id)!;
        if (card.grants.includes(grant)) return text(`Your card already has "${grant}".`);
        if (gate.auto.length) {
          store.updateCard(card.id, { grants: [...card.grants, grant] }, `card:${card.id}`);
          return text({ granted: grant, note: 'It takes effect the next time your card runs. If you cannot finish without it, say so in your summary and report_blocked.' });
        }
        const a = await requestGrant(card.id, grant, reason);
        return text({ pending: a?.id, note: 'A human has to approve this. It takes effect the next time your card runs.' });
      },
    );
  }

  // --- the IDE (Phase 6.1): only while a VS Code window is attached to this board

  if (bridge?.attached(boardId)) {
    const ask = async (type: 'ask' | 'diagnostics' | 'show_diff', params: Record<string, unknown>, seconds: number) => bridge.request(boardId, type, params, seconds * 1000);
    const inWorktree = (path: string): string | null => {
      const root = store.getCard(me.card.id)?.worktree ?? me.board.repoPath;
      const abs = isAbsolute(path) ? path : resolve(root, path);
      const rel = relative(root, abs);
      return rel.startsWith('..') || isAbsolute(rel) ? null : abs;
    };

    server.registerTool(
      'ide_ask',
      {
        description:
          "Ask the human a quick question in their editor: a pick list (options) or free text. Blocks until they answer or the timeout passes. Use it for a decision you cannot make yourself, not for status updates.",
        inputSchema: {
          question: z.string().min(3),
          options: z.array(z.string()).max(8).optional().describe('Choices to pick from; leave out for a free-text answer'),
          timeout_seconds: z.number().int().min(10).max(ASK_TIMEOUT_MAX).optional(),
        },
      },
      async ({ question, options, timeout_seconds }) => {
        const seconds = timeout_seconds ?? ASK_TIMEOUT_DEFAULT;
        const reply = (await ask('ask', { question, options: options ?? [], title: store.getCard(me.card.id)?.title }, seconds)) as { answer?: string; error?: string } | null;
        if (reply && 'answer' in reply && typeof reply.answer === 'string') return text({ answered: true, answer: reply.answer });
        // No window, or no answer in time: the question goes to the humans as a message instead.
        store.postMessage({ boardId, fromActor: `card:${me.card.id}`, toCard: null, body: `Question${options?.length ? ` (${options.join(' / ')})` : ''}: ${question}`, urgent: false });
        return text({ answered: false, note: reply?.error ?? "No answer came back (the editor closed, or nobody answered within " + seconds + "s). The question is in the humans' inbox; their reply will arrive in yours (read_inbox)." });
      },
    );

    server.registerTool(
      'ide_diagnostics',
      {
        description: "The editor's language-server problems (errors, warnings) for files in your worktree. Faster and more precise than guessing from a build. Paths are relative to your worktree.",
        inputSchema: { paths: z.array(z.string().min(1)).min(1).max(20) },
      },
      async ({ paths }) => {
        const abs = paths.map(inWorktree);
        if (abs.some((a) => a === null)) return error('Paths must be inside your worktree.');
        const reply = (await ask('diagnostics', { paths: abs }, 30)) as { files?: unknown; error?: string } | null;
        if (!reply) return error('No editor answered (it may have been closed). Use your own tools.');
        if ('error' in reply && reply.error) return error(reply.error);
        return text(reply.files ?? []);
      },
    );

    server.registerTool(
      'ide_show_diff',
      {
        description: 'Put a proposed change in front of the human: opens a diff of one of your worktree files against the proposed text in their editor. Does not change the file. Use it when you want a decision on a change before making it.',
        inputSchema: { path: z.string().min(1), proposed: z.string().max(200_000), title: z.string().optional() },
      },
      async ({ path, proposed, title }) => {
        const abs = inWorktree(path);
        if (!abs) return error('The path must be inside your worktree.');
        const reply = (await ask('show_diff', { path: abs, proposed, title: title ?? `Proposed change: ${path}` }, 15)) as { shown?: boolean; error?: string } | null;
        if (reply?.shown) return text({ shown: true });
        store.postMessage({ boardId, fromActor: `card:${me.card.id}`, toCard: null, body: `Proposed change to ${path} (no editor attached to show it):\n${proposed.slice(0, 1500)}`, urgent: false });
        return text({ shown: false, note: 'No editor could show it; it was sent to the humans as a message.' });
      },
    );
  }

  return server;
}

/** Mounts the board MCP server at /mcp (stateless Streamable HTTP; identity from the per-session bearer token). */
export function registerBoardMcp(app: FastifyInstance, store: Store, runner: Runner, extras: BoardMcpExtras = {}) {
  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
    const me = token ? runner.identify(token) : null;
    if (!me) return reply.status(401).send({ error: 'unknown or expired board session token' });
    if (req.method !== 'POST') return reply.status(405).header('allow', 'POST').send({ error: 'stateless server: POST only' });

    const server = boardServer(me, store, runner, extras);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };
  app.route({ method: ['GET', 'POST', 'DELETE'], url: '/mcp', handler });
}
