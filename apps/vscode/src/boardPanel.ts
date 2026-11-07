import * as vscode from 'vscode';
import type { HarnessModel } from './state.ts';

let panel: vscode.WebviewPanel | null = null;
let icon: vscode.Uri | undefined;

/** Called once on activation: where the extension's own files are. */
export function initBoardPanel(extensionUri: vscode.Uri) {
  icon = vscode.Uri.joinPath(extensionUri, 'media', 'infinity.svg');
}

/**
 * The daemon's full web UI (tree, card panel with Activity / Changes / Context / Terminal, Agents, Pools, Settings)
 * in an editor tab, opened on this workspace's board and optionally a card. The UI is served by the daemon; the
 * webview only frames it, like VS Code's Simple Browser.
 */
export async function openBoard(model: HarnessModel, opts: { cardId?: string; view?: string; settings?: string } = {}): Promise<void> {
  const base = await vscode.env.asExternalUri(vscode.Uri.parse(model.daemonUrl()));
  const url = new URL(base.toString(true));
  if (model.board) url.searchParams.set('board', model.board.id);
  if (opts.cardId) url.searchParams.set('card', opts.cardId);
  if (opts.view) url.searchParams.set('view', opts.view);
  if (opts.settings) url.searchParams.set('settings', opts.settings);
  // The web UI keeps the token from the address (see apps/web/src/token.ts) and drops it from the bar.
  if (model.apiToken()) url.hash = `token=${encodeURIComponent(model.apiToken())}`;
  const title = model.board ? `Board: ${model.board.name}` : 'Infinity Harness';

  if (!panel) {
    panel = vscode.window.createWebviewPanel('infinityHarness.board', title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    if (icon) panel.iconPath = icon;
    panel.onDidDispose(() => (panel = null));
  } else {
    panel.title = title;
    panel.reveal();
  }
  panel.webview.html = html(url.toString(), url.origin);
}

function html(src: string, origin: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${esc(origin)}; style-src 'unsafe-inline';">
<style>
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: var(--vscode-editor-background); }
  iframe { border: 0; width: 100%; height: 100%; display: block; }
</style>
</head>
<body>
<iframe src="${esc(src)}" allow="clipboard-read; clipboard-write" title="Infinity Harness board"></iframe>
</body>
</html>`;
}

export function disposeBoard() {
  panel?.dispose();
  panel = null;
}
