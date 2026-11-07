import * as vscode from 'vscode';
import type { HarnessModel } from './state.ts';

// The IDE bridge (master plan Phase 6.1, stage 2): while this window is bound to a board, agents on it get ide_* tools.
// The daemon sends their requests over /ws/ide; this answers them with VS Code's own UI: a quick pick for ide_ask, the
// language server's problems for ide_diagnostics, a diff editor for ide_show_diff.

export const PROPOSAL_SCHEME = 'infinity-harness-proposal';

interface IdeRequest {
  id: string;
  type: 'ask' | 'diagnostics' | 'show_diff';
  [key: string]: unknown;
}

const SEVERITY = ['error', 'warning', 'info', 'hint'];
const MAX_PROBLEMS = 50;
/** How long to wait for a language server to report on a file it has just been shown. */
const SETTLE_MS = 1500;

/** Proposed file contents agents asked to show, served read-only to the diff editor. */
export class ProposalProvider implements vscode.TextDocumentContentProvider {
  private docs = new Map<string, string>();
  private n = 0;

  add(text: string, name: string): vscode.Uri {
    const id = String(++this.n);
    this.docs.set(id, text);
    if (this.docs.size > 50) this.docs.delete(this.docs.keys().next().value!);
    return vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path: `/${name}`, query: id });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.query) ?? '';
  }
}

export const proposals = new ProposalProvider();

/** A human answers an agent's question in a quick pick (when it came with options) or an input box. */
export async function answerAsk(req: { question?: string; options?: string[]; title?: string }): Promise<{ answer: string } | { error: string }> {
  const question = String(req.question ?? '');
  const title = req.title ? `${req.title}: the agent asks` : 'An agent asks';
  const answer = req.options?.length
    ? await vscode.window.showQuickPick(req.options, { title, placeHolder: question, ignoreFocusOut: true })
    : await vscode.window.showInputBox({ title, prompt: question, ignoreFocusOut: true });
  return answer === undefined ? { error: 'the human dismissed the question' } : { answer };
}

/** Language-server problems for files, waiting briefly for a file that was just opened to be analysed. */
export async function diagnosticsFor(paths: string[]): Promise<{ files: { path: string; problems?: object[]; error?: string }[] }> {
  const files: { path: string; problems?: object[]; error?: string }[] = [];
  for (const path of paths.slice(0, 20)) {
    const uri = vscode.Uri.file(path);
    try {
      await vscode.workspace.openTextDocument(uri);
    } catch {
      files.push({ path, error: 'file not found' });
      continue;
    }
    // Diagnostics for a file arrive some time after it opens; take what is there once they settle (or time out).
    if (!vscode.languages.getDiagnostics(uri).length) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, SETTLE_MS);
        const sub = vscode.languages.onDidChangeDiagnostics?.((e) => e.uris.some((u) => u.toString() === uri.toString()) && done());
        function done() {
          clearTimeout(timer);
          sub?.dispose();
          resolve();
        }
      });
    }
    const problems = vscode.languages
      .getDiagnostics(uri)
      .filter((d) => d.severity <= 1)
      .slice(0, MAX_PROBLEMS)
      .map((d) => ({
        severity: SEVERITY[d.severity] ?? 'info',
        line: d.range.start.line + 1,
        column: d.range.start.character + 1,
        message: d.message,
        ...(d.source ? { source: d.source } : {}),
        ...(d.code !== undefined ? { code: typeof d.code === 'object' ? d.code.value : d.code } : {}),
      }));
    files.push({ path, problems });
  }
  return { files };
}

/** Opens a diff of a file against the text an agent proposes (nothing is written). */
export async function showProposedDiff(req: { path?: string; proposed?: string; title?: string }): Promise<{ shown: boolean } | { error: string }> {
  const path = String(req.path ?? '');
  const right = proposals.add(String(req.proposed ?? ''), path.split('/').pop() || 'proposal');
  await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(path), right, req.title ?? `Proposed change: ${path}`);
  return { shown: true };
}

/** Answers one request from the daemon. */
export async function handleRequest(req: IdeRequest): Promise<unknown> {
  switch (req.type) {
    case 'ask':
      return answerAsk(req as never);
    case 'diagnostics':
      return diagnosticsFor((req.paths as string[]) ?? []);
    case 'show_diff':
      return showProposedDiff(req as never);
    default:
      return { error: `unknown request ${String((req as { type?: unknown }).type)}` };
  }
}

/**
 * Keeps this window attached to the bound board's bridge: connects when a board is bound, reconnects with backoff, and
 * lets go when the board changes or the window closes.
 */
export class IdeConnection implements vscode.Disposable {
  private model: HarnessModel;
  private socket: WebSocket | null = null;
  private url = '';
  private timer: NodeJS.Timeout | undefined;
  private retry = 1000;
  private disposed = false;
  private off: vscode.Disposable;

  constructor(model: HarnessModel) {
    this.model = model;
    this.off = model.onDidChange(() => this.sync());
    this.sync();
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private target(): string {
    const board = this.model.state === 'ready' ? this.model.board : null;
    if (!board || !vscode.workspace.getConfiguration('infinityHarness').get<boolean>('ideBridge', true)) return '';
    return this.model.client.wsUrl(`/ws/ide?${new URLSearchParams({ board: board.id, name: `VS Code (${vscode.workspace.name ?? 'window'})` })}`);
  }

  private sync() {
    const want = this.target();
    if (want === this.url && (this.socket || !want)) return;
    this.close();
    this.url = want;
    if (want) this.open();
  }

  private open() {
    if (this.disposed || !this.url) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.again();
      return;
    }
    this.socket = socket;
    socket.onopen = () => (this.retry = 1000);
    socket.onmessage = (msg) => {
      let req: IdeRequest;
      try {
        req = JSON.parse(String(msg.data)) as IdeRequest;
      } catch {
        return;
      }
      void handleRequest(req).then(
        (result) => socket.send(JSON.stringify({ id: req.id, result })),
        (err: Error) => socket.send(JSON.stringify({ id: req.id, result: { error: err.message } })),
      );
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.again();
    };
    socket.onerror = () => socket.close();
  }

  private again() {
    if (this.disposed || !this.url) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.open(), this.retry);
    this.retry = Math.min(this.retry * 2, 15_000);
  }

  private close() {
    clearTimeout(this.timer);
    const s = this.socket;
    this.socket = null;
    s?.close();
  }

  dispose() {
    this.disposed = true;
    this.off.dispose();
    this.close();
  }
}
