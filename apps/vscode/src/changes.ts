import * as vscode from 'vscode';
import type { HarnessModel } from './state.ts';

export const SCHEME = 'infinity-harness';

/** `infinity-harness:/<path>?card=<id>&side=from|to|none` → a file before or after a card's work, read-only. */
export function versionUri(cardId: string, path: string, side: 'from' | 'to' | 'none'): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: `/${path}`, query: new URLSearchParams({ card: cardId, side }).toString() });
}

/** Serves card file versions from the daemon, so diffs work without the worktree checked out. */
export class VersionProvider implements vscode.TextDocumentContentProvider {
  private model: HarnessModel;
  constructor(model: HarnessModel) {
    this.model = model;
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const q = new URLSearchParams(uri.query);
    const side = q.get('side');
    if (side !== 'from' && side !== 'to') return '';
    try {
      return (await this.model.client.file(q.get('card') ?? '', uri.path.replace(/^\//, ''), side)).content;
    } catch {
      return ''; // added or deleted on this side
    }
  }
}

/** Opens every file a card changed in VS Code's multi-file diff editor (before ↔ after). */
export async function showChanges(model: HarnessModel, cardId: string): Promise<void> {
  const card = model.card(cardId);
  const changes = await model.client.changes(cardId);
  if (!changes.files.length) {
    void vscode.window.showInformationMessage(`${card?.title ?? cardId}: no changes yet.`);
    return;
  }
  const root = model.board ? vscode.Uri.file(model.board.repoPath) : undefined;
  if (changes.direct && root) {
    // Direct mode: the edits are already in this folder, so open the files themselves (SCM shows the diff if it's a repo).
    const live = changes.files.filter((f) => f.status !== 'D');
    const picks = await vscode.window.showQuickPick(
      live.map((f) => ({ label: f.path, uri: vscode.Uri.joinPath(root, f.path), picked: live.length <= 5 })),
      { canPickMany: true, title: `${card?.title ?? cardId}: files its agent edited`, placeHolder: 'Open which files? (edits made through shell commands are not listed)' },
    );
    for (const p of picks ?? []) await vscode.window.showTextDocument(p.uri, { preview: false });
    return;
  }
  const resources = changes.files.map((f) => {
    const kind = f.status.charAt(0).toUpperCase();
    const before = versionUri(cardId, f.from ?? f.path, kind === 'A' ? 'none' : 'from');
    const after = versionUri(cardId, f.path, kind === 'D' ? 'none' : 'to');
    const resource = root ? vscode.Uri.joinPath(root, f.path) : after;
    return [resource, before, after] as [vscode.Uri, vscode.Uri, vscode.Uri];
  });
  const where = changes.landed ? `landed on ${changes.base}` : `${changes.branch ?? 'branch'} vs ${changes.base}`;
  await vscode.commands.executeCommand('vscode.changes', `${card?.title ?? cardId} (${where})`, resources);
}
