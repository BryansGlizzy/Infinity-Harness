import { useState } from 'react';
import type { Card, Settings } from '@ih/core';
import { api } from './api.ts';

/**
 * The operator as reviewer (master plan Phase 6.1): approve a card's branch, send it back with notes, land it now, or
 * try it in the main checkout. Shown for worker cards that are in Review or the merge queue.
 */
export function ReviewControls({ card, settings, onError }: { card: Card; settings: Settings | null; onError: (m: string) => void }) {
  const [notes, setNotes] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  // Direct boards have no branch, so there is nothing to review or land.
  if (card.role !== 'worker' || !card.branch || !['review', 'merging'].includes(card.status)) return null;
  const racing = card.pipeline.bestOf?.state === 'running';
  const approved = card.pipeline.humanReview?.verdict === 'approve';

  async function act(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    try {
      await fn();
      if (done) setInfo(done);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="review-controls surface-box">
      <div className="row">
        <strong>Your review</strong>
        {approved && <span className="badge approve">approved</span>}
        {settings?.humanReview && !approved && card.status === 'review' && <span className="muted small">held for you (Settings → Tools)</span>}
        {racing && <span className="muted small">racing its best-of-N candidates; review the winner</span>}
      </div>
      {!racing && (
        <>
          <div className="row">
            <button disabled={busy || approved || card.status !== 'review'} onClick={() => act(() => api.review(card.id, 'approve'))} title="Send it to the merge queue without an agent review">Approve</button>
            <button className="ghost" disabled={busy} onClick={() => setOpen((o) => !o)} aria-expanded={open}>Request changes…</button>
            <button className="ghost" disabled={busy} onClick={() => act(() => api.land(card.id), 'Queued to land: it skips the review and goes first.')} title="Skip the review and go to the front of the queue; its tests still run">Land now</button>
            <span className="spacer" />
            <button className="ghost" disabled={busy} onClick={() => act(async () => setInfo((await api.tryLocally(card.id, 'checkout')).summary))} title="Detach your checkout at this branch's head">Check out here</button>
            <button className="ghost" disabled={busy} onClick={() => act(async () => setInfo((await api.tryLocally(card.id, 'apply')).summary))} title="Apply its diff to your working tree">Apply diff</button>
          </div>
          {open && (
            <div className="row">
              <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What should change? The author gets this as its next message." aria-label="Requested changes" />
              <button disabled={busy || !notes.trim()} onClick={() => act(async () => { await api.review(card.id, 'changes', notes.trim()); setNotes(''); setOpen(false); })}>Send back</button>
            </div>
          )}
        </>
      )}
      {info && <p className="small">{info}</p>}
      <p className="muted small">Check out and Apply need a clean checkout of your repository. Line comments are in VS Code's diff editor.</p>
    </div>
  );
}
