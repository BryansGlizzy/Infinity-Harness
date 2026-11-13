import { useEffect, useMemo, useRef, useState } from 'react';
import type { Board, FileContent } from '@ih/core';
import { api } from './api.ts';
import type { OpenFile } from './FileTree.tsx';

const SHOWN_LINES = 4000;

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1_048_576).toFixed(1)} MB`);

/** A file of the project (or of a card's worktree), read-only, with line numbers. */
export function FileViewer({ board, file, onClose, onError }: { board: Board; file: OpenFile; onClose: () => void; onError: (m: string) => void }) {
  const [data, setData] = useState<FileContent | null>(null);
  const [all, setAll] = useState(false);
  // The app passes fresh callbacks on every render; loading must not start over each time.
  const cb = useRef({ onClose, onError });
  cb.current = { onClose, onError };

  useEffect(() => {
    setData(null);
    setAll(false);
    let live = true;
    api.readFile(board.id, file.path, file.cardId).then(
      (d) => live && setData(d),
      (e: Error) => {
        cb.current.onError(e.message);
        cb.current.onClose();
      },
    );
    return () => {
      live = false;
    };
  }, [board.id, file.path, file.cardId]);

  const lines = useMemo(() => {
    if (!data || data.binary) return [];
    const l = data.content.split('\n');
    if (l.length > 1 && l[l.length - 1] === '') l.pop(); // the newline that ends the last line is not another line
    return l;
  }, [data]);
  const shown = all ? lines : lines.slice(0, SHOWN_LINES);

  return (
    <section className="panel file-viewer" aria-label={`File ${file.path}`}>
      <div className="panel-head">
        <div>
          <h2 className="ellipsis" title={file.path}>{file.path.split('/').pop()}</h2>
          <div className="muted small">{file.path}{file.cardId ? ' · in the card’s worktree' : ''}{data ? ` · ${size(data.size)}${lines.length ? ` · ${lines.length} line${lines.length === 1 ? '' : 's'}` : ''}` : ''}</div>
        </div>
        <button className="ghost" onClick={onClose} aria-label="Close the file">✕</button>
      </div>
      {!data && <p className="muted">Loading…</p>}
      {data?.binary && <p className="muted">This is a binary file ({size(data.size)}); it is not shown.</p>}
      {data?.truncated && <p className="muted small">Only the first megabyte is shown.</p>}
      {data && !data.binary && (
        <div className="code">
          <pre className="gutter" aria-hidden="true">{shown.map((_, i) => i + 1).join('\n')}</pre>
          <pre className="text">{shown.join('\n')}</pre>
        </div>
      )}
      {!all && lines.length > SHOWN_LINES && <button className="ghost" onClick={() => setAll(true)}>Show all {lines.length} lines</button>}
    </section>
  );
}
