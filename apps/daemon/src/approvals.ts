import { effectiveAgents, validateAgents, type AgentProfile, type Approval, type ApprovalKind, type BoardMcp, type BoardSkill, type Card } from '@mh/core';
import { activeGrants } from './tools.ts';
import type { Store } from '@mh/db';
import { notificationJob, readNotification, type FastLane } from '@mh/fast-lane';
import type { Runner } from './runner.ts';

// The approval queue (master plan Phase 6.4). Things an agent may not do on its own wait here for a human, who decides
// from the web UI or VS Code's Needs-you view: an escalation (answer it and the card resumes), a new agent profile
// (`spawn_agent`), an MCP server or skill for the board (`propose_mcp`, `propose_skill`), and a tool grant for a card.

/** What installing a granted tool needs from the machine: is a command there, and run the grant's install command. */
export interface ToolInstaller {
  isInstalled(command: string): boolean;
  run(installCommand: string): Promise<{ ok: boolean; output: string }>;
}

export interface ApprovalDeps {
  store: Store;
  runner: Runner;
  fastLane?: FastLane | null;
  /** Without it, granted tools that aren't installed are only reported, never offered for install. */
  installer?: ToolInstaller | null;
}

export interface ApprovalRequest {
  boardId: string;
  cardId: string | null;
  kind: ApprovalKind;
  payload: Record<string, unknown>;
  requestedBy: string;
  /** Used when the fast lane can't word it. */
  summary: string;
  /** Facts for the fast lane's notification text. */
  facts?: string[];
  /** Post a message to the humans too (not needed when the caller already did, as escalations do). */
  announce?: boolean;
}

const LABEL: Record<ApprovalKind, string> = {
  escalation: 'needs a decision',
  spawn_agent: 'wants a new agent',
  install_mcp: 'proposes an MCP server',
  install_skill: 'proposes a skill',
  grant: 'asks for a tool grant',
  install_tool: 'asks to install a tool',
};

export class Approvals {
  private deps: ApprovalDeps;
  /** Installs running now (`board:grant`), and requests being worded (so a busy scheduler asks once). */
  private installing = new Map<string, Promise<{ ok: boolean; output: string; installed: boolean }>>();
  private asked = new Set<string>();
  constructor(deps: ApprovalDeps) {
    this.deps = deps;
  }

  /**
   * True while a card must wait for a tool to be installed. The first time a card holding a grant meets a missing
   * command, the humans are asked (an `install_tool` approval, once per board and grant); a pending request or a
   * running install holds the card. Once decided, the card goes on: with the tool if it was installed, without it
   * (and with a message) if not.
   */
  installGate(card: Card): boolean {
    const { store, installer } = this.deps;
    if (!installer) return false;
    const settings = store.getSettings(card.boardId);
    for (const [name, g] of activeGrants(settings, card)) {
      if (installer.isInstalled(g.command) || !g.install) continue;
      const key = `${card.boardId}:${name}`;
      if (this.installing.has(key) || this.asked.has(key)) return true;
      const existing = store.listApprovals(card.boardId).find((a) => a.kind === 'install_tool' && a.payload.grant === name);
      if (existing) {
        if (existing.status === 'pending') return true;
        continue;
      }
      this.asked.add(key);
      void this.request({
        boardId: card.boardId,
        cardId: card.id,
        kind: 'install_tool',
        payload: { grant: name },
        requestedBy: `card:${card.id}`,
        summary: `"${card.title}" was granted ${g.label}, but \`${g.command}\` isn't installed on this machine. Approving runs: ${g.install}`,
        facts: [`Tool: ${g.label}, command ${g.command}`, `Approving runs: ${g.install}`],
      })
        .catch(() => {})
        .finally(() => this.asked.delete(key));
      return true;
    }
    return false;
  }

  /** Grants (by name) among `names` whose command isn't installed. */
  missingTools(boardId: string, names: string[]): string[] {
    const { store, installer } = this.deps;
    if (!installer) return [];
    const grants = store.getSettings(boardId).grants;
    return names.filter((n) => grants[n]?.command && !installer.isInstalled(grants[n]!.command));
  }

  /**
   * Runs a grant's install command (the operator's own text from Settings, never anything an agent sent). Concurrent
   * calls for the same grant share one run. Tells the humans how it went.
   */
  installTool(boardId: string, grant: string): Promise<{ ok: boolean; output: string; installed: boolean }> {
    const { store, installer } = this.deps;
    const g = store.getSettings(boardId).grants[grant];
    if (!installer) return Promise.reject(new Error('installing is not available on this daemon'));
    if (!g?.install?.trim()) return Promise.reject(new Error(`grant "${grant}" has no install command`));
    const key = `${boardId}:${grant}`;
    const running = this.installing.get(key);
    if (running) return running;
    const job = installer
      .run(g.install)
      .then((r) => {
        const installed = installer.isInstalled(g.command);
        const ok = r.ok && installed;
        store.postMessage({
          boardId,
          fromActor: 'daemon:approvals',
          toCard: null,
          body: ok
            ? `Installed ${g.label}: \`${g.command}\` is ready. Cards waiting for it start now.`
            : r.ok
              ? `The install of ${g.label} finished, but \`${g.command}\` is still not on the daemon's PATH. Open a new shell or add its folder to PATH, then restart the daemon.`
              : `Installing ${g.label} failed. Command: ${g.install}\n${r.output.trim().split('\n').slice(-12).join('\n')}`,
          urgent: false,
        });
        return { ok, output: r.output, installed };
      })
      .finally(() => this.installing.delete(key));
    this.installing.set(key, job);
    return job;
  }

  /** Queues a request. Asking again for the same thing while it is pending returns the pending one. */
  async request(req: ApprovalRequest): Promise<Approval> {
    const { store, fastLane } = this.deps;
    const same = store.listApprovals(req.boardId, { status: 'pending' }).find((a) => a.kind === req.kind && a.cardId === req.cardId && JSON.stringify(a.payload) === JSON.stringify(req.payload));
    if (same) return same;
    let summary = req.summary;
    if (fastLane?.available && store.getSettings(req.boardId).notificationText) {
      const card = req.cardId ? store.getCard(req.cardId) : undefined;
      const written = await fastLane.run(notificationJob(req.kind, [card ? `Card: ${card.title}` : '', `Asked by: ${req.requestedBy}`, ...(req.facts ?? [req.summary])].filter(Boolean)));
      summary = (written && readNotification(written.text)) || summary;
    }
    const approval = store.createApproval({ boardId: req.boardId, cardId: req.cardId, kind: req.kind, summary, payload: req.payload, requestedBy: req.requestedBy });
    if (req.announce !== false) {
      store.postMessage({
        boardId: req.boardId,
        fromActor: 'daemon:approvals',
        toCard: null,
        body: `Approval needed (${LABEL[req.kind]}): ${summary}${req.cardId ? ` (${req.cardId})` : ''}`,
        urgent: false,
      });
    }
    return approval;
  }

  /** Records the decision and applies it. An approval that can't be applied stays pending and the error is thrown. */
  decide(id: string, status: 'approved' | 'denied', by: string, note?: string): Approval {
    const { store } = this.deps;
    const before = store.getApproval(id);
    if (!before) throw new Error(`approval ${id} not found`);
    if (before.status !== 'pending') throw new Error(`approval ${id} was already ${before.status}`);
    const answered = { ...before, note: note?.trim() || null };
    // An escalated card resumes on approval; its answer must be waiting in the inbox before the new session reads it.
    if (status === 'approved' && before.kind === 'escalation') this.tell(answered, this.approvedText(answered));
    if (status === 'approved') this.apply(before, by);
    const decided = store.decideApproval(id, status, by, note);
    if (status === 'denied') this.tell(decided, `Denied${decided.note ? `: ${decided.note}` : '.'}`);
    else if (before.kind !== 'escalation') this.tell(decided, this.approvedText(decided));
    return decided;
  }

  private approvedText(a: Approval): string {
    const note = a.note ? ` The human says: ${a.note}` : '';
    switch (a.kind) {
      case 'spawn_agent':
        return `Approved: agent "${(a.payload.agent as AgentProfile).id}" now exists on the board.${note}`;
      case 'install_mcp':
        return `Approved: MCP server "${(a.payload.mcp as BoardMcp).name}" is on the board. New sessions get it; this one does not.${note}`;
      case 'install_skill':
        return `Approved: skill "${(a.payload.skill as BoardSkill).name}" is on the board. New worker prompts carry it.${note}`;
      case 'grant':
        return `Approved: tool grant "${String(a.payload.grant)}" for this card. It takes effect the next time the card runs; if you cannot finish without it, finish your turn and say so.${note}`;
      case 'install_tool':
        return `Approved: installing ${String(a.payload.grant)}. Your card starts when it finishes.${note}`;
      case 'escalation':
        return `A human answered your escalation${a.note ? `: ${a.note}` : '. Carry on.'}`;
    }
  }

  /** Tells the asking card's agent what was decided. */
  private tell(a: Approval, body: string) {
    const { store, runner } = this.deps;
    if (!a.cardId || !store.getCard(a.cardId)) return;
    store.postMessage({ boardId: a.boardId, fromActor: 'daemon:approvals', toCard: a.cardId, body, urgent: false });
    runner.deliver(a.cardId);
  }

  private apply(a: Approval, by: string) {
    const { store, runner } = this.deps;
    const settings = store.getSettings(a.boardId);
    switch (a.kind) {
      case 'spawn_agent': {
        const agent = a.payload.agent as AgentProfile;
        const next = [...settings.agents.filter((x) => x.id !== agent.id), agent];
        const problem = validateAgents([...next, ...effectiveAgents({ agents: next }, runner.pools()).filter((x) => x.implicit)]);
        if (problem) throw new Error(problem);
        if (!runner.pools().some((p) => p.id === agent.poolId)) throw new Error(`unknown pool ${agent.poolId}`);
        store.updateSettings(a.boardId, { agents: next }, by);
        return;
      }
      case 'install_mcp': {
        const mcp = a.payload.mcp as BoardMcp;
        store.updateSettings(a.boardId, { mcpServers: [...settings.mcpServers.filter((m) => m.name !== mcp.name), mcp] }, by);
        return;
      }
      case 'install_skill': {
        const skill = a.payload.skill as BoardSkill;
        store.updateSettings(a.boardId, { skills: [...settings.skills.filter((s) => s.name !== skill.name), skill] }, by);
        return;
      }
      case 'grant': {
        const card = a.cardId ? store.getCard(a.cardId) : undefined;
        const name = String(a.payload.grant);
        if (card && !card.grants.includes(name)) store.updateCard(card.id, { grants: [...card.grants, name] }, by);
        return;
      }
      case 'install_tool': {
        // Runs in the background; the outcome is posted to the humans when it ends.
        void this.installTool(a.boardId, String(a.payload.grant)).catch((err: Error) =>
          store.postMessage({ boardId: a.boardId, fromActor: 'daemon:approvals', toCard: null, body: `Could not install ${String(a.payload.grant)}: ${err.message}`, urgent: false }),
        );
        return;
      }
      case 'escalation': {
        const card = a.cardId ? store.getCard(a.cardId) : undefined;
        if (!card || card.status !== 'blocked') return;
        // The human dealt with it: automatic retries and landing attempts start over, as when a blocked card is moved by hand.
        store.updateCard(card.id, { status: 'ready', pipeline: { ...card.pipeline, escalated: false, mergeAttempts: 0, retries: 0, reviewRounds: 0 } }, by);
        return;
      }
    }
  }
}

/** Cards in a board that wait for a human (blocked and escalated), for views that list what needs you. */
export function escalatedCards(cards: Card[]): Card[] {
  return cards.filter((c) => c.status === 'blocked' && c.pipeline.escalated);
}
