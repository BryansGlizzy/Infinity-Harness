import * as vscode from 'vscode';
import type { ChatItem } from '@ih/core';
import type { HarnessModel } from './state.ts';
import { goalsOf, subtreeOf } from './summary.ts';

// The chat view (master plan Phase 6.1, stage 2): one conversation per goal, like the vendor chat panels. What the agents
// say streams in from their session events; cards' questions to you appear inline with a reply box; what you type goes to
// the goal's planner or to a card you pick. The conversation itself is built by the daemon (`GET /api/cards/:id/chat`).

export class ChatView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'infinityHarness.chat';
  private model: HarnessModel;
  private view: vscode.WebviewView | null = null;
  private goalId: string | null = null;
  private timer: NodeJS.Timeout | undefined;
  private off: vscode.Disposable[] = [];
  private sending = 0;

  constructor(model: HarnessModel) {
    this.model = model;
    this.off.push(model.onDidChange(() => this.soon()), model.onEvent(() => this.soon()));
  }

  /** The goal being shown: the picked one, else the newest. */
  goal(): string | null {
    const goals = goalsOf(this.model.cards);
    if (this.goalId && goals.some((g) => g.id === this.goalId)) return this.goalId;
    return goals[0]?.id ?? null;
  }

  select(goalId: string) {
    this.goalId = goalId;
    void this.refresh();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html();
    view.webview.onDidReceiveMessage((m: { type: string; cardId?: string; text?: string }) => void this.onMessage(m));
    view.onDidDispose(() => (this.view = null));
    view.onDidChangeVisibility(() => view.visible && void this.refresh());
  }

  private async onMessage(m: { type: string; cardId?: string; text?: string }) {
    if (m.type === 'ready') return void this.refresh();
    if (m.type === 'goals') return void vscode.commands.executeCommand('infinityHarness.chat.selectGoal');
    if (m.type === 'plan') return void vscode.commands.executeCommand('infinityHarness.plan');
    if (m.type !== 'send' || !m.cardId || !m.text?.trim()) return;
    const urgent = m.text.trim().startsWith('!urgent');
    this.sending++;
    try {
      await this.model.client.sendMessage(m.cardId, urgent ? m.text.trim().slice(7).trim() : m.text.trim(), urgent);
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not send: ${(err as Error).message}`);
    } finally {
      this.sending--;
    }
    await this.refresh();
  }

  private soon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), 300);
  }

  /** Fetches the goal's conversation and hands it to the view. */
  async refresh(): Promise<void> {
    if (!this.view) return;
    const goalId = this.goal();
    const goals = goalsOf(this.model.cards).map((g) => ({ id: g.id, title: g.title }));
    if (this.model.state !== 'ready' || !goalId) {
      void this.view.webview.postMessage({ type: 'state', goal: null, goals, items: [], targets: [], empty: this.model.state === 'ready' ? 'No goals yet. Plan one, and the conversation appears here.' : 'Connect a board to chat with its agents.' });
      return;
    }
    let items: ChatItem[] = [];
    try {
      items = (await this.model.client.chat(goalId)).items;
    } catch {
      return; // the daemon is away; the next event refreshes
    }
    const targets = subtreeOf(this.model.cards, goalId).map((c) => ({ id: c.id, title: c.title, role: c.role, status: c.status, live: c.status === 'in_progress' }));
    void this.view.webview.postMessage({ type: 'state', goal: goals.find((g) => g.id === goalId) ?? null, goals, items, targets });
  }

  dispose() {
    clearTimeout(this.timer);
    for (const d of this.off) d.dispose();
  }
}

function html(): string {
  const nonce = Array.from({ length: 24 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  body { padding: 0; margin: 0; display: flex; flex-direction: column; height: 100vh; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); }
  header { display: flex; gap: 6px; align-items: center; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  header .goal { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 0; padding: 3px 8px; cursor: pointer; border-radius: 2px; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  #log { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; }
  .item { max-width: 100%; }
  .meta { opacity: .65; font-size: .85em; margin-bottom: 2px; }
  .text { white-space: pre-wrap; word-wrap: break-word; }
  .you .text { background: var(--vscode-input-background); padding: 6px 8px; border-radius: 6px; }
  .agent .text { padding: 0 2px; }
  .status { opacity: .7; font-size: .9em; text-align: center; }
  .note .text { border-left: 3px solid var(--vscode-editorInfo-foreground); padding-left: 8px; }
  .ask .text { border-left: 3px solid var(--vscode-editorWarning-foreground); padding-left: 8px; }
  .ask.answered { opacity: .6; }
  .reply { display: flex; gap: 4px; margin-top: 4px; }
  .reply input, footer textarea, footer select { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 4px; font: inherit; }
  footer { border-top: 1px solid var(--vscode-panel-border); padding: 6px 8px; display: flex; flex-direction: column; gap: 4px; }
  footer .row { display: flex; gap: 4px; }
  .empty { opacity: .7; padding: 16px 8px; }
</style>
</head>
<body>
<header><span class="goal" id="goal">Chat</span><button id="goals" title="Pick another goal">Goals</button><button id="plan" class="primary" title="Plan a new goal">New goal</button></header>
<div id="log"></div>
<footer>
  <div class="row"><select id="target" title="Who this goes to"></select></div>
  <div class="row"><textarea id="text" rows="2" placeholder="Message the agent. Start with !urgent to interrupt its turn."></textarea><button id="send" class="primary">Send</button></div>
</footer>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log'), target = document.getElementById('target'), text = document.getElementById('text');
  let atBottom = true;
  log.addEventListener('scroll', () => { atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40; });
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; };
  const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const send = (cardId, value) => { if (cardId && value.trim()) vscode.postMessage({ type: 'send', cardId, text: value }); };
  document.getElementById('goals').onclick = () => vscode.postMessage({ type: 'goals' });
  document.getElementById('plan').onclick = () => vscode.postMessage({ type: 'plan' });
  document.getElementById('send').onclick = () => { send(target.value, text.value); text.value = ''; };
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('send').click(); } });
  window.addEventListener('message', ({ data }) => {
    if (data.type !== 'state') return;
    document.getElementById('goal').textContent = data.goal ? data.goal.title : 'Chat';
    const keep = target.value;
    target.replaceChildren(...data.targets.map((t) => { const o = el('option', '', (t.role === 'worker' ? '' : t.role + ': ') + t.title + (t.live ? ' (working)' : '')); o.value = t.id; return o; }));
    if (data.targets.some((t) => t.id === keep)) target.value = keep;
    log.replaceChildren();
    if (!data.items.length) log.append(el('div', 'empty', data.empty || 'Nothing yet. The agents\\' messages and your replies show up here.'));
    for (const i of data.items) {
      if (i.kind === 'status') { log.append(el('div', 'item status', i.cardTitle + ' ' + i.text)); continue; }
      const box = el('div', 'item ' + i.kind + (i.answered ? ' answered' : ''));
      const who = i.kind === 'you' ? 'You to ' + i.cardTitle : i.kind === 'ask' ? i.cardTitle + ' asks you' : i.kind === 'note' ? 'Board · ' + i.cardTitle : i.cardTitle;
      box.append(el('div', 'meta', who + ' · ' + clock(i.ts)), el('div', 'text', i.text));
      if (i.kind === 'ask' && !i.answered) {
        const row = el('div', 'reply'), input = el('input'), btn = el('button', 'primary', 'Reply');
        input.placeholder = 'Your answer…';
        btn.onclick = () => { send(i.cardId, input.value); input.value = ''; };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
        row.append(input, btn); box.append(row);
      }
      log.append(box);
    }
    if (atBottom) log.scrollTop = log.scrollHeight;
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
