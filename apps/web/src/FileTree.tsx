import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Board, Card, FileEntry } from '@ih/core';
import { api } from './api.ts';
import { remember, saved } from './storage.ts';

interface Dir {
  entries: FileEntry[] | null;
  error?: string;
  truncated?: boolean;
}

export interface OpenFile {
  path: string;
  /** Set when the file is in a card's worktree rather than the project folder. */
  cardId?: string;
}

const STATUS: Record<string, { label: string; title: string }> = {
  M: { label: 'M', title: 'modified' },
  A: { label: 'A', title: 'added' },
  D: { label: 'D', title: 'deleted' },
  U: { label: 'U', title: 'new, not tracked yet' },
};

/** A row of the visible tree: an entry and how deep it is. */
interface Row {
  entry: FileEntry;
  depth: number;
}

/**
 * The project's files down the left side: folders open in place (loaded as you open them), a click opens a file in the
 * viewer, and git's changes are marked. With a card selected you can switch to that card's worktree. Read-only: the
 * agents and your editor do the writing.
 */
export function FileTree({ board, card, open, onOpen, refreshKey }: { board: Board; card: Card | null; open: OpenFile | null; onOpen: (f: OpenFile) => void; refreshKey: number }) {
  const [collapsed, setCollapsed] = useState(() => saved('ih.tree.collapsed') === '1');
  const [useCard, setUseCard] = useState(false);
  const cardId = useCard && card?.worktree ? card.id : undefined;
  const [dirs, setDirs] = useState<Record<string, Dir>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState('');
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  // Leaving the card (or choosing another) goes back to the project folder.
  useEffect(() => setUseCard(false), [card?.id]);

  const load = useCallback(
    async (path: string, quiet = false) => {
      try {
        const listing = await api.listFiles(board.id, path, cardId);
        setDirs((d) => ({ ...d, [path]: { entries: listing.entries, truncated: listing.truncated } }));
      } catch (err) {
        if (!quiet) setDirs((d) => ({ ...d, [path]: { entries: null, error: (err as Error).message } }));
      }
    },
    [board.id, cardId],
  );

  // A different board or root: start from the top again.
  useEffect(() => {
    setDirs({});
    setExpanded(new Set());
    setFocus('');
    if (!collapsed) void load('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.id, cardId, collapsed]);

  // Keep what is open current: agents change files while you look.
  useEffect(() => {
    if (collapsed) return;
    const refresh = () => {
      void load('', true);
      for (const p of expandedRef.current) void load(p, true);
    };
    const t = setInterval(refresh, 8000);
    if (refreshKey) refresh();
    return () => clearInterval(t);
  }, [collapsed, load, refreshKey]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (path: string, depth: number) => {
      for (const entry of dirs[path]?.entries ?? []) {
        out.push({ entry, depth });
        if (entry.type === 'dir' && expanded.has(entry.path)) walk(entry.path, depth + 1);
      }
    };
    walk('', 0);
    return out;
  }, [dirs, expanded]);

  function toggle(path: string, to?: boolean) {
    const isOpen = expanded.has(path);
    const next = to ?? !isOpen;
    if (next === isOpen) return;
    setExpanded((s) => {
      const n = new Set(s);
      if (next) n.add(path);
      else n.delete(path);
      return n;
    });
    if (next && !dirs[path]) void load(path);
  }

  function activate(entry: FileEntry) {
    setFocus(entry.path);
    if (entry.type === 'dir') toggle(entry.path);
    else if (entry.type === 'file') onOpen({ path: entry.path, cardId });
  }

  function onKeyDown(e: KeyboardEvent) {
    const i = rows.findIndex((r) => r.entry.path === focus);
    const cur = rows[i]?.entry;
    const go = (to: number) => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, to))];
      if (r) {
        setFocus(r.entry.path);
        document.getElementById(`ft-${board.id}-${r.entry.path}`)?.focus();
      }
    };
    if (e.key === 'ArrowDown') (e.preventDefault(), go(i + 1));
    else if (e.key === 'ArrowUp') (e.preventDefault(), go(i - 1));
    else if (e.key === 'Home') (e.preventDefault(), go(0));
    else if (e.key === 'End') (e.preventDefault(), go(rows.length - 1));
    else if (e.key === 'ArrowRight' && cur?.type === 'dir') {
      e.preventDefault();
      if (!expanded.has(cur.path)) toggle(cur.path, true);
      else go(i + 1);
    } else if (e.key === 'ArrowLeft' && cur) {
      e.preventDefault();
      if (cur.type === 'dir' && expanded.has(cur.path)) toggle(cur.path, false);
      else {
        const parent = cur.path.includes('/') ? cur.path.slice(0, cur.path.lastIndexOf('/')) : '';
        const at = rows.findIndex((r) => r.entry.path === parent);
        if (at >= 0) go(at);
      }
    } else if ((e.key === 'Enter' || e.key === ' ') && cur) (e.preventDefault(), activate(cur));
  }

  if (collapsed) {
    return (
      <aside className="filetree collapsed" aria-label="Files">
        <button className="ghost" title="Show the file tree" aria-label="Show the file tree" onClick={() => (remember('ih.tree.collapsed', '0'), setCollapsed(false))}>
          ▸
        </button>
      </aside>
    );
  }

  const root = dirs[''];
  return (
    <aside className="filetree" aria-label="Files">
      <div className="filetree-head">
        <strong className="ellipsis" title={cardId ? card?.worktree ?? '' : board.repoPath}>{cardId ? 'Card worktree' : board.name}</strong>
        <span className="spacer" />
        <button className="ghost small-btn" title="Reload" aria-label="Reload the file tree" onClick={() => { void load(''); for (const p of expanded) void load(p); }}>↻</button>
        <button className="ghost small-btn" title="Hide the file tree" aria-label="Hide the file tree" onClick={() => (remember('ih.tree.collapsed', '1'), setCollapsed(true))}>◂</button>
      </div>
      {card?.worktree && (
        <div className="filetree-root small">
          <label>
            <input type="radio" name="tree-root" checked={!useCard} onChange={() => setUseCard(false)} /> Project
          </label>
          <label title={card.title}>
            <input type="radio" name="tree-root" checked={useCard} onChange={() => setUseCard(true)} /> This card’s worktree
          </label>
        </div>
      )}
      <div className="filetree-body" role="tree" aria-label="Project files" onKeyDown={onKeyDown}>
        {!root && <div className="muted small pad">Loading…</div>}
        {root?.error && <div className="error-text small pad">{root.error}</div>}
        {root?.entries && rows.length === 0 && <div className="muted small pad">This folder is empty.</div>}
        {rows.map(({ entry, depth }) => {
          const isOpen = expanded.has(entry.path);
          const child = dirs[entry.path];
          const selected = open?.path === entry.path && open.cardId === cardId;
          return (
            <div key={entry.path}>
              <div
                id={`ft-${board.id}-${entry.path}`}
                role="treeitem"
                aria-level={depth + 1}
                aria-expanded={entry.type === 'dir' ? isOpen : undefined}
                aria-selected={selected}
                tabIndex={focus === entry.path || (!focus && rows[0]?.entry.path === entry.path) ? 0 : -1}
                className={`ft-row ${selected ? 'on' : ''} ${entry.type}`}
                style={{ paddingLeft: 8 + depth * 14 }}
                onClick={() => activate(entry)}
                title={entry.type === 'link' ? `${entry.path} (a link that leaves the project)` : entry.path}
              >
                <span className="ft-caret" aria-hidden="true">{entry.type === 'dir' ? (isOpen ? '▾' : '▸') : ''}</span>
                <span className="ft-name">{entry.name}{entry.type === 'dir' ? '/' : ''}</span>
                {entry.status && <span className={`ft-status s-${entry.status}`} title={STATUS[entry.status]?.title}>{entry.type === 'dir' ? '•' : STATUS[entry.status]?.label}</span>}
              </div>
              {entry.type === 'dir' && isOpen && child?.error && <div className="error-text small" style={{ paddingLeft: 22 + depth * 14 }}>{child.error}</div>}
              {entry.type === 'dir' && isOpen && !child && <div className="muted small" style={{ paddingLeft: 22 + depth * 14 }}>Loading…</div>}
              {entry.type === 'dir' && isOpen && child?.entries?.length === 0 && <div className="muted small" style={{ paddingLeft: 22 + depth * 14 }}>(empty)</div>}
              {entry.type === 'dir' && isOpen && child?.truncated && <div className="muted small" style={{ paddingLeft: 22 + depth * 14 }}>(more files than are listed)</div>}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
