import { useEffect, useRef, useState } from 'react';
import type { Board, BoardRemovalInfo } from '@ih/core';
import { api } from './api.ts';

/** What removing the board touches, in the person's words. */
function Facts({ info }: { info: BoardRemovalInfo }) {
  const bits: string[] = [];
  bits.push(`${info.cards} card${info.cards === 1 ? '' : 's'}`);
  if (info.running) bits.push(`${info.running} agent${info.running === 1 ? '' : 's'} working (they are stopped)`);
  if (info.worktrees) bits.push(`${info.worktrees} card worktree${info.worktrees === 1 ? '' : 's'}`);
  return (
    <ul className="small">
      <li>The board has {bits.join(', ')}.</li>
      {info.dirtyWorktrees > 0 && <li className="error-text">{info.dirtyWorktrees} card worktree{info.dirtyWorktrees === 1 ? ' has' : 's have'} changes nobody committed.</li>}
      {info.folder.unlandedBranches ? <li className="error-text">{info.folder.unlandedBranches} branch{info.folder.unlandedBranches === 1 ? '' : 'es'} hold work that has not landed on {info.board.defaultBranch}.</li> : null}
      {info.folder.uncommitted ? <li className="error-text">The project folder has {info.folder.uncommitted} uncommitted change{info.folder.uncommitted === 1 ? '' : 's'}.</li> : null}
      {!info.folder.exists && <li>The project folder no longer exists.</li>}
      {(info.federation.sharing || info.federation.openIn > 0 || info.federation.openOut > 0) && (
        <li>
          {info.federation.sharing ? 'Its project card is withdrawn from your peers. ' : ''}
          {info.federation.openIn > 0 ? `${info.federation.openIn} open request${info.federation.openIn === 1 ? '' : 's'} from other swarms ${info.federation.openIn === 1 ? 'is' : 'are'} declined. ` : ''}
          {info.federation.openOut > 0 ? `${info.federation.openOut} of yours ${info.federation.openOut === 1 ? 'is' : 'are'} withdrawn.` : ''}
        </li>
      )}
    </ul>
  );
}

/**
 * Remove a board. Two ways: take it out of Infinity Harness (the project folder, its branches and history stay), or also
 * delete the project folder from the disk, which asks for the board's name to be typed back first.
 */
export function RemoveBoardDialog({ board, onClose, onRemoved, onError }: { board: Board; onClose: () => void; onRemoved: (note: string) => void; onError: (m: string) => void }) {
  const [info, setInfo] = useState<BoardRemovalInfo | null>(null);
  const [step, setStep] = useState<'choose' | 'confirm-delete'>('choose');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const cb = useRef({ onClose, onError });
  cb.current = { onClose, onError };

  useEffect(() => {
    api.boardRemoval(board.id).then(setInfo, (e: Error) => {
      cb.current.onError(e.message);
      cb.current.onClose();
    });
  }, [board.id]);

  async function go(mode: 'forget' | 'delete') {
    setBusy(true);
    try {
      const r = await api.removeBoard(board.id, mode, mode === 'delete' ? typed : undefined);
      onRemoved(
        mode === 'delete'
          ? `Deleted "${board.name}" and its folder ${r.deletedFolder ?? ''}.`
          : `Removed "${board.name}" from Infinity Harness. Its folder is untouched.${r.keptWorktrees.length ? ` ${r.keptWorktrees.length} card worktree(s) with unsaved changes were left on disk.` : ''}`,
      );
    } catch (err) {
      onError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={`Remove ${board.name}`} onClick={(e) => e.stopPropagation()}>
        <h3>Remove “{board.name}”</h3>
        <p className="muted small">{board.repoPath}</p>
        {!info && <p className="muted">Checking what it holds…</p>}
        {info && <Facts info={info} />}
        {info?.blocked && <p className="error-text">{info.blocked}</p>}

        {info && !info.blocked && step === 'choose' && (
          <>
            <div className="remove-choice">
              <button disabled={busy} onClick={() => void go('forget')}>Remove from Infinity Harness</button>
              <p className="muted small">Forgets the board, its cards, notes, settings and usage, and deletes the card worktrees it made. Your project folder, its branches and its history stay exactly as they are.</p>
            </div>
            <div className="remove-choice">
              <button className="danger" disabled={busy || !!info.deleteBlocked} onClick={() => setStep('confirm-delete')}>Delete on system…</button>
              <p className="muted small">{info.deleteBlocked ?? 'Also deletes the project folder and everything in it from the disk. You will be asked to confirm.'}</p>
            </div>
          </>
        )}

        {info && step === 'confirm-delete' && (
          <div className="remove-choice danger-zone">
            <p>
              <strong>This deletes {info.board.repoPath} from the disk, with everything in it{info.folder.unlandedBranches || info.folder.uncommitted ? ', including work that is not saved anywhere else' : ''}. It cannot be undone.</strong>
            </p>
            <label className="small">
              Type the board’s name, <code>{board.name}</code>, to confirm
              <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus aria-label="Board name" />
            </label>
            <div className="row">
              <button className="danger" disabled={busy || typed !== board.name} onClick={() => void go('delete')}>{busy ? 'Deleting…' : 'Delete the folder permanently'}</button>
              <button className="ghost" disabled={busy} onClick={() => { setStep('choose'); setTyped(''); }}>Back</button>
            </div>
          </div>
        )}

        <div className="row">
          <span className="spacer" />
          <button className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
