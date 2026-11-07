import * as vscode from 'vscode';
import type { ReviewComment } from './client.ts';
import { SCHEME } from './changes.ts';
import type { HarnessModel } from './state.ts';

// Reviewing a card in VS Code's diff editor (master plan Phase 6.1, stage 2). Comment on lines of a card's diff
// (Comments API); Approve or Request Changes sends your verdict to the refinery, standing in for the agent reviewer.
// While the card is still being worked a comment goes to its agent at once; once it is in Review, comments are collected
// into your review and go with Request Changes.

/** What a comment thread on a card's file version refers to. */
export function threadTarget(uri: { scheme: string; path: string; query: string }, range: { start: { line: number }; end: { line: number } }): { cardId: string; side: string; comment: Omit<ReviewComment, 'body'> } | null {
  if (uri.scheme !== SCHEME) return null;
  const q = new URLSearchParams(uri.query);
  const cardId = q.get('card');
  if (!cardId) return null;
  const line = range.start.line + 1;
  const endLine = range.end.line + 1;
  return { cardId, side: q.get('side') ?? 'to', comment: { path: uri.path.replace(/^\//, ''), line, ...(endLine > line ? { endLine } : {}) } };
}

class ReviewComment_ implements vscode.Comment {
  body: string | vscode.MarkdownString;
  mode = vscode.CommentMode.Preview;
  author: vscode.CommentAuthorInformation = { name: 'You' };
  label?: string;
  constructor(body: string, label?: string) {
    this.body = body;
    this.label = label;
  }
}

export class ReviewComments implements vscode.Disposable {
  private controller: vscode.CommentController;
  private model: HarnessModel;
  /** Your comments on a card's diff, waiting for Request Changes. */
  private drafts = new Map<string, { comment: ReviewComment; thread: vscode.CommentThread }[]>();

  constructor(model: HarnessModel) {
    this.model = model;
    this.controller = vscode.comments.createCommentController('infinityHarness.review', 'Infinity Harness review');
    this.controller.options = { placeHolder: 'Comment on this change for the agent…', prompt: 'Add comment' };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (doc) => {
        // Only the "after" side of a card's diff takes comments.
        const t = threadTarget(doc.uri, { start: { line: 0 }, end: { line: 0 } });
        return t?.side === 'to' ? [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)] : undefined;
      },
    };
  }

  /** The comment box's submit: send it now, or keep it for the review. */
  async submit(reply: vscode.CommentReply): Promise<void> {
    const target = threadTarget(reply.thread.uri, reply.thread.range ?? new vscode.Range(0, 0, 0, 0));
    const body = reply.text.trim();
    if (!target || !body) return;
    const comment: ReviewComment = { ...target.comment, body };
    const card = this.model.card(target.cardId);
    const reviewing = card?.status === 'review' || card?.status === 'merging';
    if (!reviewing) {
      await this.model.client.comment(target.cardId, comment);
      reply.thread.comments = [...reply.thread.comments, new ReviewComment_(body, 'Sent to the agent')];
      return;
    }
    const list = this.drafts.get(target.cardId) ?? [];
    list.push({ comment, thread: reply.thread });
    this.drafts.set(target.cardId, list);
    reply.thread.comments = [...reply.thread.comments, new ReviewComment_(body, 'Pending review')];
    void vscode.window.setStatusBarMessage(`$(comment) ${list.length} comment${list.length === 1 ? '' : 's'} in your review of ${card?.title ?? target.cardId}`, 4000);
  }

  pending(cardId: string): ReviewComment[] {
    return (this.drafts.get(cardId) ?? []).map((d) => d.comment);
  }

  /** Your verdict: approve (comments are dropped), or request changes with notes and the collected comments. */
  async verdict(cardId: string, verdict: 'approve' | 'changes'): Promise<void> {
    const card = this.model.card(cardId);
    if (verdict === 'approve') {
      await this.model.client.review(cardId, 'approve', '');
      this.discard(cardId);
      void vscode.window.showInformationMessage(`Approved: ${card?.title ?? cardId}. It goes to the merge queue.`);
      return;
    }
    const comments = this.pending(cardId);
    const notes = await vscode.window.showInputBox({
      title: `Request changes: ${card?.title ?? cardId}`,
      prompt: comments.length ? `What should change? Your ${comments.length} line comment${comments.length === 1 ? '' : 's'} go along.` : 'What should change?',
      ignoreFocusOut: true,
    });
    if (notes === undefined) return;
    if (!notes.trim() && !comments.length) {
      void vscode.window.showInformationMessage('Say what should change, or comment on lines of the diff first.');
      return;
    }
    await this.model.client.review(cardId, 'changes', notes.trim(), comments);
    this.discard(cardId);
    void vscode.window.showInformationMessage(`Sent back to ${card?.agentId ?? 'the agent'}: ${card?.title ?? cardId}.`);
  }

  private discard(cardId: string) {
    for (const d of this.drafts.get(cardId) ?? []) d.thread.dispose();
    this.drafts.delete(cardId);
  }

  dispose() {
    for (const id of [...this.drafts.keys()]) this.discard(id);
    this.controller.dispose();
  }
}
