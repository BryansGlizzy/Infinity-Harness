// Council planning: a goal on a board with 2+ enabled orchestrators is planned by all of them together.
//   proposing → each member reads the repo and proposes a split (one share per member) with propose_split
//   (Kev scores the proposals; the best one is the council's decision)
//   planning  → each member creates the cards for its share under its own card
//   working   → the cards run and land as usual
//   verifying → each member cross-checks another member's share against the goal; it may add fix-up cards
//   fixing    → fix-up cards land, then another verification round (up to councilVerifyRounds)
//   done
import type { Card, Council, CouncilShare, DaemonEvent } from '@ih/core';
import type { Store } from '@ih/db';
import type { KevClient } from '@ih/router';
import type { ContextService } from '@ih/context';
import { lastAgentMessage } from './context.ts';
import { git } from './git.ts';
import { parseVerdict } from './refinery.ts';
import type { Runner } from './runner.ts';
import type { Scheduler } from './scheduler.ts';

const TICK_MS = 2000;
const FINISHED = new Set(['review', 'merging', 'done']);

export interface CouncilDeps {
  store: Store;
  runner: Runner;
  scheduler: Scheduler;
  kev: KevClient | null;
  context: ContextService | null;
  tickMs?: number;
}

/** A proposal as saved by propose_split: markdown for people, the shares as JSON for the daemon. */
export function renderProposal(member: string, shares: CouncilShare[], rationale: string): string {
  return [
    `Proposed by ${member}.`,
    '',
    ...shares.flatMap((s) => [`## ${s.member}`, s.scope, ...s.cards.map((c) => `- ${c}`), '']),
    rationale ? `## Why\n${rationale}` : '',
    '',
    '```json',
    JSON.stringify({ shares }),
    '```',
  ].join('\n');
}

export function readProposal(body: string): CouncilShare[] | null {
  const m = /```json\n([\s\S]*?)\n```\s*$/.exec(body);
  try {
    const parsed = m ? (JSON.parse(m[1]!) as { shares?: CouncilShare[] }) : null;
    return Array.isArray(parsed?.shares) ? parsed!.shares : null;
  } catch {
    return null;
  }
}

/** The council a card takes part in: as the goal card, or as a member card under it. */
export function councilOf(store: Store, card: Card): { goal: Card; council: Council; member?: Council['members'][number] } | null {
  if (card.pipeline.council) return { goal: card, council: card.pipeline.council };
  const goal = card.parentId ? store.getCard(card.parentId) : undefined;
  const member = goal?.pipeline.council?.members.find((m) => m.cardId === card.id);
  return goal && member ? { goal, council: goal.pipeline.council!, member } : null;
}

function membersText(store: Store, runner: Runner, council: Council): string {
  return council.members
    .map((m) => {
      const card = store.getCard(m.cardId)!;
      const team = runner.team(card).map((t) => `${t.agent.id} (${t.agent.model || t.pool.model}${t.agent.role === 'lead' ? ', lead' : ''})`);
      return `- ${m.agentId} (${m.model}), card ${m.cardId}; its team: ${team.join(', ') || 'none'}`;
    })
    .join('\n');
}

export function proposalPrompt(goal: Card, me: Council['members'][number], members: string, n: number): string {
  return [
    `You are ${me.agentId}, one of ${n} orchestrators planning a goal together as a council. Your card id is ${me.cardId}.`,
    '',
    `Goal: ${goal.title}`,
    goal.description ? `\n${goal.description}\n` : '',
    'The council members and the agents each can hand cards to:',
    members,
    '',
    'Read the repository (read-only; do not edit files or write code). Then propose how to split the goal into one share per council member, playing to each member\'s team: what each share covers (features, files, modules) and the cards it would create. Shares should not overlap; say where they meet.',
    '',
    'Call propose_split once with a share for every member and your rationale. Do not create cards yet: Kev compares the members\' proposals and the council follows the best one. Then end your turn with a one-paragraph summary.',
  ].join('\n');
}

export function planningPrompt(goal: Card, council: Council, shares: CouncilShare[], me: Council['members'][number]): string {
  const mine = shares.find((s) => s.member === me.agentId);
  const others = shares.filter((s) => s.member !== me.agentId);
  const card = (agentId: string) => council.members.find((m) => m.agentId === agentId)?.cardId ?? '?';
  return [
    `The council chose ${council.winner}'s proposal for "${goal.title}" (Kev scores: ${Object.entries(council.scores ?? {}).map(([k, v]) => `${k} ${v}`).join(', ') || 'n/a'}).`,
    '',
    mine ? `Your share:\n${mine.scope}\nExpected cards:\n${mine.cards.map((c) => `- ${c}`).join('\n')}` : 'Your share is empty in the chosen split: create no cards unless something in the goal is clearly left out.',
    '',
    others.length ? `The other shares (do not plan these):\n${others.map((s) => `- ${s.member} (card ${card(s.member)}): ${s.scope}`).join('\n')}` : '',
    '',
    `Create the cards for your share with create_subtask under your card ${me.cardId}: clear titles, context, acceptance criteria. Cut your share so its cards can run side by side (own files each, agreed interfaces instead of waiting): blocked_by only where a card cannot start without another's code or output. Where your share meets another, agree on the interface: record it with put_artifact (kind contract) and tell that member's card with post_message.`,
    'When your cards are on the board, end your turn with a short summary of them.',
  ].join('\n');
}

export function verifyPrompt(goal: Card, shares: CouncilShare[], reviewer: Council['members'][number], target: Council['members'][number], cards: Card[], base: string, round: number): string {
  const share = shares.find((s) => s.member === target.agentId);
  return [
    `Verification round ${round} for the council goal "${goal.title}". You are ${reviewer.agentId}; you check ${target.agentId}'s share.`,
    '',
    `Goal:\n${goal.description || goal.title}`,
    '',
    `${target.agentId}'s share: ${share?.scope ?? '(not in the split)'}`,
    `Its cards:\n${cards.map((c) => `- ${c.id} "${c.title}" — ${c.status}${c.pipeline.landedSha ? `, landed ${c.pipeline.landedSha.slice(0, 8)}` : ''}`).join('\n') || '- (none)'}`,
    '',
    `Your working directory now holds the latest ${base}, with all landed work. Read the code and run the tests if useful; do not edit files.`,
    'Check that the share is complete and correct against the goal and the split, and that it fits with the rest of the goal.',
    `If something is missing or broken, create fix-up cards with create_subtask under your own card ${reviewer.cardId} (clear acceptance criteria). Do not recreate work that is already done.`,
    'End your reply with one line, VERDICT: APPROVE or VERDICT: CHANGES, followed by what is wrong (if anything).',
  ].join('\n');
}

/** Runs councils: starts them from a goal, and moves each through its phases on a tick. */
export class CouncilRunner {
  private deps: CouncilDeps;
  private timer: NodeJS.Timeout | null = null;
  private off: (() => void)[] = [];
  /** Member cards whose current council turn hasn't ended yet. */
  private awaiting = new Set<string>();
  private busy = new Set<string>();

  constructor(deps: CouncilDeps) {
    this.deps = deps;
  }

  start() {
    this.off.push(
      this.deps.store.onEvent((e: DaemonEvent) => {
        if (e.type !== 'card.updated' || e.actor !== 'daemon') return;
        const { patch, card } = e.payload as { patch: Partial<Card>; card: Card };
        if ((patch.status === 'review' || patch.status === 'blocked') && this.awaiting.has(card.id)) {
          this.awaiting.delete(card.id);
          this.kick();
        }
      }),
    );
    this.timer = setInterval(() => this.tick(), this.deps.tickMs ?? TICK_MS);
    this.timer.unref?.();
  }

  stop() {
    for (const off of this.off) off();
    if (this.timer) clearInterval(this.timer);
  }

  private kick() {
    setTimeout(() => this.tick(), 50).unref?.();
  }

  private log(goal: Card, step: string, detail: Record<string, unknown> = {}) {
    this.deps.store.append('card.council', goal.id, { step, ...detail }, 'council');
  }

  /** The enabled orchestrators whose pools can take work now; a council needs two. */
  members(boardId: string) {
    // Direct boards plan with one orchestrator: verification resets checkouts, and there the checkout is the user's folder.
    if (this.deps.store.getBoard(boardId)?.mode === 'direct') return [];
    const settings = this.deps.store.getSettings(boardId);
    return this.deps.scheduler
      .agentViews(settings, boardId)
      .filter((v) => v.agent?.role === 'orchestrator' && v.state !== 'halted' && v.state !== 'locked' && v.budget?.state !== 'halted')
      .map((v) => ({ agent: v.agent!, pool: v.pool }));
  }

  /** Creates the goal card and one planning card per member, and asks each member for a proposal. */
  async startGoal(boardId: string, title: string, description: string): Promise<Card> {
    const { store } = this.deps;
    const members = this.members(boardId);
    if (members.length < 2) throw new Error('a council needs at least two enabled orchestrators with open pools');
    const goal = store.createCard({ boardId, title, description, role: 'orchestrator', status: 'in_progress' });
    const council: Council = {
      phase: 'proposing',
      members: members.map(({ agent, pool }) => {
        const card = store.createCard({
          boardId,
          parentId: goal.id,
          title: `${agent.id}: plan "${title.slice(0, 80)}"`,
          description: `Council member ${agent.id}'s planning card for the goal.`,
          role: 'orchestrator',
          status: 'ready',
          createdBy: `card:${goal.id}`,
        });
        return { agentId: agent.id, poolId: pool.id, model: agent.model || pool.model, cardId: card.id };
      }),
      since: new Date().toISOString(),
    };
    store.updateCard(goal.id, { pipeline: { council } }, 'council');
    this.log(goal, 'proposing', { members: council.members.map((m) => m.agentId) });
    const text = membersText(store, this.deps.runner, council);
    for (const m of council.members) await this.wake(m, proposalPrompt(goal, m, text, council.members.length));
    return store.getCard(goal.id)!;
  }

  /** Gives a member its next prompt: as a message to its idle session, or as a new run. */
  private async wake(m: Council['members'][number], prompt: string) {
    const { store, runner } = this.deps;
    this.awaiting.add(m.cardId);
    const card = store.getCard(m.cardId)!;
    try {
      if (runner.sessionState(m.cardId) === 'idle') {
        store.postMessage({ boardId: card.boardId, fromActor: 'daemon:council', toCard: m.cardId, body: prompt, urgent: false });
        runner.deliver(m.cardId);
      } else {
        await runner.run(m.cardId, m.poolId, { model: m.model, agentId: m.agentId, prompt });
      }
    } catch (err) {
      this.awaiting.delete(m.cardId);
      store.append('session.event', m.cardId, { sessionId: null, event: { type: 'error', message: `council: ${(err as Error).message}` } }, 'council');
    }
  }

  private turnsDone(council: Council): boolean {
    return council.members.every((m) => !this.awaiting.has(m.cardId) && !this.deps.runner.isActive(m.cardId));
  }

  private setCouncil(goal: Card, patch: Partial<Council>, status?: Card['status']): Card {
    const now = this.deps.store.getCard(goal.id)!;
    return this.deps.store.updateCard(goal.id, { pipeline: { ...now.pipeline, council: { ...now.pipeline.council!, ...patch } }, status }, 'council');
  }

  tick() {
    const { store } = this.deps;
    for (const board of store.listBoards()) {
      for (const goal of store.listCards(board.id)) {
        const c = goal.pipeline.council;
        if (!c || c.phase === 'done' || c.phase === 'failed' || this.busy.has(goal.id)) continue;
        this.busy.add(goal.id);
        void this.advance(goal, c)
          .catch((err: Error) => this.log(goal, 'error', { message: err.message }))
          .finally(() => this.busy.delete(goal.id));
      }
    }
  }

  private shares(goal: Card, council: Council): CouncilShare[] {
    const decision = this.deps.store.listArtifacts(goal.boardId, { cardIds: [goal.id], kinds: ['decision'] }).find((a) => a.title.startsWith('Council split'));
    return (decision && readProposal(decision.body)) ?? [];
  }

  private async advance(goal: Card, council: Council) {
    const { store, runner } = this.deps;
    if (!this.turnsDone(council)) return;
    const cards = store.listCards(goal.boardId);
    const kids = (id: string) => cards.filter((c) => c.parentId === id);

    if (council.phase === 'proposing') return this.decide(goal, council);

    if (council.phase === 'planning') {
      this.log(goal, 'working', { cards: council.members.map((m) => `${m.agentId}: ${kids(m.cardId).length}`).join(', ') });
      this.setCouncil(goal, { phase: 'working', since: new Date().toISOString() });
      return;
    }

    if (council.phase === 'working' || council.phase === 'fixing') {
      // Members' cards are planning cards: done once everything under them has landed.
      const open = council.members.flatMap((m) => kids(m.cardId)).filter((k) => !this.settled(k, cards));
      if (open.length) return;
      for (const m of council.members) if (store.getCard(m.cardId)!.status !== 'done') store.updateCard(m.cardId, { status: 'done' }, 'council');
      const round = (council.round ?? 0) + 1;
      if (council.phase === 'fixing' && round > store.getSettings(goal.boardId).councilVerifyRounds) return this.finish(goal, 'the last verification round\'s fix-ups have landed');
      return this.verify(goal, council, round);
    }

    if (council.phase === 'verifying') {
      const verdicts: Record<string, 'approve' | 'changes' | 'none'> = {};
      for (const m of council.members) {
        const v = parseVerdict(lastAgentMessage(store, m.cardId) ?? '').verdict;
        verdicts[m.agentId] = v ?? 'none';
      }
      const fixups = council.members.flatMap((m) => kids(m.cardId)).filter((k) => k.createdAt >= council.since);
      this.log(goal, 'verified', { round: council.round, verdicts, fixups: fixups.length });
      if (!fixups.length) {
        const changes = Object.entries(verdicts).filter(([, v]) => v === 'changes');
        if (changes.length) {
          store.postMessage({
            boardId: goal.boardId,
            fromActor: 'daemon:council',
            toCard: null,
            body: `Council goal "${goal.title}": ${changes.map(([k]) => k).join(', ')} asked for changes but created no fix-up cards. See the members' cards.`,
            urgent: false,
          });
        }
        const approved = Object.values(verdicts).every((v) => v === 'approve');
        return this.finish(goal, changes.length ? 'verification asked for changes without fix-up cards' : approved ? 'every member approved' : 'no fix-up cards were needed');
      }
      this.setCouncil(goal, { phase: 'fixing', verdicts, since: new Date().toISOString() });
    }
  }

  private settled(card: Card, cards: Card[]): boolean {
    if (card.role === 'worker') return card.status === 'done';
    if (!FINISHED.has(card.status) && card.status !== 'done') return false;
    return cards.filter((c) => c.parentId === card.id).every((c) => this.settled(c, cards));
  }

  /** Kev scores every proposal; the best one becomes the council's split, and members plan their shares. */
  private async decide(goal: Card, council: Council) {
    const { store, kev, runner, context } = this.deps;
    const proposals = council.members
      .map((m) => ({ m, a: store.listArtifacts(goal.boardId, { cardIds: [m.cardId], kinds: ['proposal'] })[0] }))
      .filter((p) => p.a && readProposal(p.a.body));
    if (!proposals.length) {
      this.setCouncil(goal, { phase: 'failed' }, 'blocked');
      this.log(goal, 'failed', { reason: 'no member made a proposal' });
      store.postMessage({ boardId: goal.boardId, fromActor: 'daemon:council', toCard: null, body: `Council goal "${goal.title}": no member proposed a split. See the members' cards.`, urgent: false });
      return;
    }
    let scores: Record<string, number> = {};
    let via = 'kev';
    if (kev && proposals.length > 1) {
      try {
        scores = await kev.scoreProposals(`${goal.title}\n\n${goal.description}`, membersText(store, runner, council), proposals.map((p) => ({ id: p.m.agentId, text: p.a!.body })));
      } catch (err) {
        via = `first proposal (Kev failed: ${(err as Error).message.slice(0, 120)})`;
      }
    } else {
      via = proposals.length > 1 ? 'first proposal (Kev not configured)' : 'the only proposal';
    }
    const best = [...proposals].sort((a, b) => (scores[b.m.agentId] ?? 0) - (scores[a.m.agentId] ?? 0))[0]!;
    const shares = readProposal(best.a!.body)!;
    const decision = {
      boardId: goal.boardId,
      cardId: goal.id,
      kind: 'decision' as const,
      title: `Council split: ${best.m.agentId}'s proposal`,
      body: `Chosen by ${via}. Scores: ${Object.entries(scores).map(([k, v]) => `${k} ${v}`).join(', ') || 'n/a'}.\n\n${best.a!.body}`,
      author: 'daemon:council',
    };
    if (context) context.put(decision);
    else store.putArtifact(decision);
    const next = this.setCouncil(goal, { phase: 'planning', winner: best.m.agentId, scores, since: new Date().toISOString() });
    this.log(goal, 'decided', { winner: best.m.agentId, scores, via });
    for (const m of council.members) {
      const card = store.getCard(m.cardId)!;
      if (card.status === 'blocked') continue; // a member that failed proposing sits this one out
      await this.wake(m, planningPrompt(goal, next.pipeline.council!, shares, m));
    }
  }

  /** Each member checks the next member's share on the latest default branch. */
  private async verify(goal: Card, council: Council, round: number) {
    const { store } = this.deps;
    const board = store.getBoard(goal.boardId)!;
    const shares = this.shares(goal, council);
    this.setCouncil(goal, { phase: 'verifying', round, since: new Date().toISOString() });
    this.log(goal, 'verifying', { round });
    const members = council.members;
    for (let i = 0; i < members.length; i++) {
      const reviewer = members[i]!;
      const target = members[(i + 1) % members.length]!;
      const card = store.getCard(reviewer.cardId)!;
      // Planning cards never code, so their worktree can simply jump to the latest default branch.
      if (card.worktree && board.mode !== 'direct') await git(card.worktree, ['reset', '-q', '--hard', board.defaultBranch]).catch(() => {});
      const cards = store.listCards(goal.boardId).filter((c) => c.parentId === target.cardId);
      await this.wake(reviewer, verifyPrompt(goal, shares, reviewer, target, cards, board.defaultBranch, round));
    }
  }

  private finish(goal: Card, reason: string) {
    const { store } = this.deps;
    this.setCouncil(goal, { phase: 'done' }, 'done');
    for (const m of goal.pipeline.council!.members) if (store.getCard(m.cardId)!.status !== 'done') store.updateCard(m.cardId, { status: 'done' }, 'council');
    this.log(goal, 'done', { reason });
  }
}
