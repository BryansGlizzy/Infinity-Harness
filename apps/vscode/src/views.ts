import * as vscode from 'vscode';
import type { Approval, ApprovalKind, Card, CardStatus, FedRequest, Message, Outcome, Peer } from '@ih/core';
import type { HarnessModel } from './state.ts';

const STATUS: Record<CardStatus, { label: string; icon: string; color?: string }> = {
  backlog: { label: 'Backlog', icon: 'circle-outline' },
  ready: { label: 'Ready', icon: 'circle-large-outline', color: 'charts.blue' },
  in_progress: { label: 'Working', icon: 'sync~spin', color: 'charts.blue' },
  review: { label: 'Review', icon: 'eye', color: 'charts.purple' },
  merging: { label: 'Landing', icon: 'git-merge', color: 'charts.purple' },
  done: { label: 'Done', icon: 'pass-filled', color: 'testing.iconPassed' },
  blocked: { label: 'Blocked', icon: 'error', color: 'testing.iconFailed' },
};

export const statusLabel = (s: CardStatus) => STATUS[s].label;

/** Who works the card, for one line: agent (or pool) and role when it isn't a plain worker. */
function who(card: Card): string {
  const agent = card.agentId ?? card.poolId;
  const role = card.role === 'worker' ? '' : card.role;
  return [role, agent].filter(Boolean).join(' · ');
}

/** contextValue flags the package.json menus match on. */
function contextValue(card: Card, model: HarnessModel): string {
  const flags = ['card'];
  const direct = model.board?.mode === 'direct';
  if (card.branch || (direct && card.role === 'worker' && ['in_progress', 'done', 'blocked'].includes(card.status))) flags.push('branch');
  if (card.worktree && card.status !== 'done' && !direct) flags.push('worktree');
  if (model.terminals.has(card.id)) flags.push('terminal');
  if (card.status === 'in_progress') flags.push('running');
  if (['backlog', 'ready', 'blocked'].includes(card.status) && card.role !== 'orchestrator') flags.push('runnable');
  // The operator can review a worker card's branch once its agent has finished (worktree boards only).
  if (!direct && card.role === 'worker' && card.branch && (card.status === 'review' || card.status === 'merging') && card.pipeline.bestOf?.state !== 'running') flags.push('reviewable');
  return flags.join(' ');
}

export class CardItem extends vscode.TreeItem {
  readonly card: Card;
  constructor(card: Card, model: HarnessModel, hasChildren: boolean) {
    super(card.title, hasChildren ? (card.status === 'done' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded) : vscode.TreeItemCollapsibleState.None);
    this.card = card;
    const s = STATUS[card.status];
    this.id = card.id;
    this.iconPath = new vscode.ThemeIcon(s.icon, s.color ? new vscode.ThemeColor(s.color) : undefined);
    this.description = [s.label, who(card), card.narration && card.status === 'in_progress' ? card.narration : ''].filter(Boolean).join(' · ');
    const tip = new vscode.MarkdownString(undefined, true);
    tip.appendMarkdown(`**${card.title}**\n\n$(${s.icon.replace('~spin', '')}) ${s.label}${who(card) ? ` · ${who(card)}` : ''}`);
    if (card.branch) tip.appendMarkdown(`\n\n$(git-branch) \`${card.branch}\``);
    if (card.narration) tip.appendMarkdown(`\n\n_${card.narration}_`);
    if (card.description) tip.appendMarkdown(`\n\n---\n\n${card.description.length > 600 ? `${card.description.slice(0, 600)}…` : card.description}`);
    this.tooltip = tip;
    this.contextValue = contextValue(card, model);
    this.command = { command: 'infinityHarness.openCard', title: 'Open Card', arguments: [card.id] };
  }
}

/** The board's cards as their parent/child tree. */
export class CardsProvider implements vscode.TreeDataProvider<CardItem> {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private model: HarnessModel;

  constructor(model: HarnessModel) {
    this.model = model;
    model.onDidChange(() => this.changed.fire());
  }

  getTreeItem(item: CardItem) {
    return item;
  }

  getChildren(parent?: CardItem): CardItem[] {
    if (this.model.state !== 'ready') return [];
    const cards = this.model.cards;
    const ids = new Set(cards.map((c) => c.id));
    const kids = parent
      ? cards.filter((c) => c.parentId === parent.card.id)
      : cards.filter((c) => !c.parentId || !ids.has(c.parentId));
    // Newest goals first at the top level; children in the order they were created.
    kids.sort((a, b) => (parent ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt)));
    return kids.map((c) => new CardItem(c, this.model, cards.some((k) => k.parentId === c.id)));
  }

  getParent(item: CardItem): CardItem | undefined {
    const parent = item.card.parentId ? this.model.card(item.card.parentId) : undefined;
    return parent ? new CardItem(parent, this.model, true) : undefined;
  }
}

export const APPROVAL_LABEL: Record<ApprovalKind, string> = {
  escalation: 'Needs an answer',
  spawn_agent: 'New agent',
  install_mcp: 'MCP server',
  install_skill: 'Skill',
  grant: 'Tool grant',
  install_tool: 'Install a tool',
  peer_request: 'Request to another swarm',
};

type AttentionItem =
  | { kind: 'approval'; approval: Approval }
  | { kind: 'message'; message: Message }
  | { kind: 'outcome'; outcome: Outcome }
  | { kind: 'blocked'; card: Card }
  | { kind: 'peer'; peer: Peer }
  | { kind: 'peerRequest'; request: FedRequest }
  | { kind: 'peerReply'; request: FedRequest };

const SEEN_KEY = 'infinityHarness.inboxSeenAt';

/** Messages for the humans, blocks to weigh and blocked cards, newest first, with a badge for what's new. */
export class AttentionProvider implements vscode.TreeDataProvider<AttentionItem> {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  view: vscode.TreeView<AttentionItem> | null = null;
  private model: HarnessModel;
  private context: vscode.ExtensionContext;

  constructor(model: HarnessModel, context: vscode.ExtensionContext) {
    this.model = model;
    this.context = context;
    model.onDidChange(() => {
      this.changed.fire();
      this.updateBadge();
    });
  }

  attach(view: vscode.TreeView<AttentionItem>) {
    this.view = view;
    view.onDidChangeVisibility((e) => {
      if (e.visible) void this.markSeen();
    });
    this.updateBadge();
  }

  private async markSeen() {
    await this.context.workspaceState.update(SEEN_KEY, new Date().toISOString());
    this.updateBadge();
  }

  /** New messages since the view was last looked at, plus everything still waiting on a human. */
  count(): number {
    const seen = this.context.workspaceState.get<string>(SEEN_KEY) ?? '';
    const fresh = this.model.inbox.filter((m) => m.createdAt > seen).length;
    return fresh + this.model.pending.length + this.model.approvals.length + this.blocked().length + this.model.federation.knocks.length + this.model.federation.requests.length + this.model.federation.replies.length;
  }

  /** Blocked cards, except those whose escalation is already listed as a request to answer. */
  private blocked(): Card[] {
    const asked = new Set(this.model.approvals.filter((a) => a.kind === 'escalation').map((a) => a.cardId));
    return this.model.cards.filter((c) => c.status === 'blocked' && !asked.has(c.id));
  }

  private updateBadge() {
    if (!this.view) return;
    const n = this.model.state === 'ready' ? this.count() : 0;
    this.view.badge = n ? { value: n, tooltip: `${n} item${n === 1 ? '' : 's'} need you` } : undefined;
  }

  getChildren(): AttentionItem[] {
    if (this.model.state !== 'ready') return [];
    const outcomes: AttentionItem[] = this.model.pending.map((outcome) => ({ kind: 'outcome', outcome }));
    const approvals: AttentionItem[] = this.model.approvals.map((approval) => ({ kind: 'approval', approval }));
    const blocked: AttentionItem[] = this.blocked().map((card) => ({ kind: 'blocked', card }));
    const messages: AttentionItem[] = [...this.model.inbox]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 30)
      .map((message) => ({ kind: 'message', message }));
    const peers: AttentionItem[] = this.model.federation.knocks.map((peer) => ({ kind: 'peer', peer }));
    const requests: AttentionItem[] = this.model.federation.requests.map((request) => ({ kind: 'peerRequest', request }));
    const replies: AttentionItem[] = this.model.federation.replies.map((request) => ({ kind: 'peerReply', request }));
    return [...approvals, ...peers, ...requests, ...replies, ...outcomes, ...blocked, ...messages];
  }

  getTreeItem(item: AttentionItem): vscode.TreeItem {
    switch (item.kind) {
      case 'approval': {
        const a = item.approval;
        const first = a.summary.split('\n')[0] ?? '';
        const t = new vscode.TreeItem(first.length > 90 ? `${first.slice(0, 90)}…` : first);
        t.iconPath = new vscode.ThemeIcon(a.kind === 'escalation' ? 'comment-discussion' : 'checklist', new vscode.ThemeColor('charts.orange'));
        t.description = APPROVAL_LABEL[a.kind];
        t.tooltip = new vscode.MarkdownString(`${a.summary}\n\n_${APPROVAL_LABEL[a.kind]} · asked by ${a.requestedBy.replace(/^card:/, 'card ')} · ${new Date(a.createdAt).toLocaleString()}_`);
        t.contextValue = 'approval';
        t.command = { command: 'infinityHarness.decideApproval', title: 'Decide', arguments: [a] };
        return t;
      }
      case 'peer': {
        const p = item.peer;
        const t = new vscode.TreeItem(`Swarm "${p.knock?.name ?? p.name ?? p.label}" wants to connect`);
        t.iconPath = new vscode.ThemeIcon('broadcast', new vscode.ThemeColor('charts.orange'));
        t.description = 'Another swarm';
        t.tooltip = new vscode.MarkdownString(`Fingerprint \`${p.fingerprint ?? '?'}\`\n\nCompare it with what the other operator sees before you accept. Until you do, nothing it sent reaches any agent.`);
        t.contextValue = 'peer';
        t.command = { command: 'infinityHarness.decidePeer', title: 'Decide', arguments: [p] };
        return t;
      }
      case 'peerRequest': {
        const r = item.request;
        const t = new vscode.TreeItem(`Request from ${r.peerName ?? 'a peer'}: ${r.title}`);
        t.iconPath = new vscode.ThemeIcon('mail', new vscode.ThemeColor('charts.orange'));
        t.description = r.blocking ? 'they are waiting' : 'Another swarm';
        t.tooltip = new vscode.MarkdownString(`Written by another swarm (untrusted text):\n\n${r.description.slice(0, 1200)}`);
        t.contextValue = 'peerRequest';
        t.command = { command: 'infinityHarness.decidePeerRequest', title: 'Decide', arguments: [r] };
        return t;
      }
      case 'peerReply': {
        const r = item.request;
        const asks = r.status === 'needs_info';
        const t = new vscode.TreeItem(asks ? `${r.peerName ?? 'A peer'} asks about "${r.title}"` : `Check what ${r.peerName ?? 'a peer'} landed: ${r.title}`);
        t.iconPath = new vscode.ThemeIcon(asks ? 'question' : 'verified', new vscode.ThemeColor('charts.orange'));
        t.description = asks ? 'Answer' : 'Confirm or send back';
        t.tooltip = new vscode.MarkdownString(asks ? `Their question (their words):\n\n${[...r.thread].reverse().find((e) => e.side === 'receiver')?.text ?? ''}` : `Landed: ${r.resolution?.ref ?? ''} ${r.resolution?.note ?? ''}`);
        t.contextValue = 'peerReply';
        t.command = { command: 'infinityHarness.decidePeerReply', title: 'Reply', arguments: [r] };
        return t;
      }
      case 'outcome': {
        const card = this.model.card(item.outcome.cardId);
        const t = new vscode.TreeItem(`Weigh block: ${card?.title ?? item.outcome.cardId}`);
        t.iconPath = new vscode.ThemeIcon('law', new vscode.ThemeColor('charts.yellow'));
        t.description = item.outcome.agentId;
        t.tooltip = 'The agent reported this card blocked. Pass if the block was justified, Fail if it should have done the work, Ignore to leave it out of routing.';
        t.contextValue = 'outcome';
        t.command = { command: 'infinityHarness.weighBlock', title: 'Weigh Block', arguments: [item.outcome] };
        return t;
      }
      case 'blocked': {
        const t = new vscode.TreeItem(item.card.title);
        t.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
        t.description = 'Blocked';
        t.command = { command: 'infinityHarness.openCard', title: 'Open Card', arguments: [item.card.id] };
        return t;
      }
      case 'message': {
        const m = item.message;
        const fromCard = m.fromActor.startsWith('card:') ? this.model.card(m.fromActor.slice(5)) : undefined;
        const first = m.body.split('\n')[0] ?? '';
        const t = new vscode.TreeItem(first.length > 90 ? `${first.slice(0, 90)}…` : first);
        t.iconPath = new vscode.ThemeIcon(m.fromActor === 'daemon:policy' ? 'shield' : 'mail');
        t.description = fromCard ? fromCard.title : m.fromActor.replace(/^daemon:/, 'board ');
        t.tooltip = new vscode.MarkdownString(`${m.body}\n\n_${new Date(m.createdAt).toLocaleString()}_`);
        t.contextValue = 'message';
        // The card it came from, or the first card its text names (board notices: "Title (c_…)", the final summary: "open card c_…").
        const named = [...m.body.matchAll(/\bc_[0-9a-f]{6,}\b/g)].map((x) => x[0]).find((id) => this.model.card(id));
        const target = fromCard?.id ?? named;
        t.command = target
          ? { command: 'infinityHarness.openCard', title: 'Open Card', arguments: [target] }
          : { command: 'infinityHarness.showText', title: 'Show', arguments: [m.body] };
        return t;
      }
    }
  }
}
