import * as vscode from 'vscode';

const MAX_SELECTION = 6_000;

/** A workspace-relative path for the active document, or null when it isn't a file in the workspace. */
function relPath(doc: vscode.TextDocument): string | null {
  if (doc.uri.scheme !== 'file') return null;
  const rel = vscode.workspace.asRelativePath(doc.uri, false);
  return rel === doc.uri.fsPath ? null : rel;
}

/**
 * What the user is looking at, as text for a card description or a message: the file, the selected lines and
 * (optionally) the selection itself. Agents work in their own worktree of the same repository, so the path is enough
 * for them to open the file; the selection pins down which part is meant.
 */
export function selectionContext(editor = vscode.window.activeTextEditor, includeText = true): string {
  if (!editor) return '';
  const path = relPath(editor.document);
  if (!path) return '';
  const sel = editor.selection;
  if (sel.isEmpty) return `The user is looking at \`${path}\`.`;
  const lines = sel.start.line === sel.end.line ? `line ${sel.start.line + 1}` : `lines ${sel.start.line + 1}–${sel.end.line + 1}`;
  const text = editor.document.getText(sel);
  const lang = editor.document.languageId;
  if (!includeText) return `See \`${path}\`, ${lines}.`;
  const body = text.length > MAX_SELECTION ? `${text.slice(0, MAX_SELECTION)}\n… (truncated)` : text;
  return `See \`${path}\`, ${lines}:\n\n\`\`\`${lang}\n${body}\n\`\`\``;
}

/** The active file's errors and warnings as a goal description, or null when it has none. */
export function problemsContext(editor = vscode.window.activeTextEditor): { path: string; count: number; text: string } | null {
  if (!editor) return null;
  const path = relPath(editor.document);
  if (!path) return null;
  const diags = vscode.languages
    .getDiagnostics(editor.document.uri)
    .filter((d) => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning)
    .slice(0, 50);
  if (!diags.length) return null;
  const sev = (d: vscode.Diagnostic) => (d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning');
  const lines = diags.map((d) => `- ${path}:${d.range.start.line + 1}:${d.range.start.character + 1} ${sev(d)}${d.source ? ` (${d.source})` : ''}: ${d.message.split('\n')[0]}`);
  return {
    path,
    count: diags.length,
    text: [`VS Code reports these problems in \`${path}\`:`, ...lines, '', 'Fix them without changing behaviour, and run the checks that report them.'].join('\n'),
  };
}
