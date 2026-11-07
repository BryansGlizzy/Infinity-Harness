import { useEffect, useState, type FormEvent } from 'react';
import type { Board } from '@mh/core';
import { api, type FolderInfo, type RepoSetup } from './api.ts';

const join = (dir: string, name: string) => `${dir.replace(/\/+$/, '')}/${name}`;
const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;

/** What creating a board on this folder will do, in plain words, and whether setup is needed. */
function describe(f: FolderInfo | null): { text: string; tone: 'ok' | 'warn' | 'bad' | 'muted'; setup: boolean; blocked: boolean } {
  if (!f) return { text: 'Checking…', tone: 'muted', setup: false, blocked: true };
  if (f.notDirectory) return { text: 'This is a file, not a folder.', tone: 'bad', setup: false, blocked: true };
  if (!f.exists) return { text: 'This folder doesn’t exist yet. It will be created as a new project: git, a README, a .gitignore and a first commit.', tone: 'ok', setup: true, blocked: false };
  const g = f.git;
  if (g?.inside) return { text: `This folder is inside the repository at ${g.root}. Boards work on a whole repository: choose that folder.`, tone: 'bad', setup: false, blocked: true };
  if (g && g.commits > 0) {
    const where = g.github ? 'GitHub remote: cards land as pull requests' : g.origin ? `remote ${g.origin}: cards land locally` : 'no remote: cards land as local merge commits';
    return {
      text: `Git repository on ${g.branch}, ${g.commits} commit${g.commits === 1 ? '' : 's'}, ${where}.${g.dirty ? ` It has uncommitted changes: commit or stash them, or landing will wait for a clean ${g.branch}.` : ''}`,
      tone: g.dirty ? 'warn' : 'ok',
      setup: false,
      blocked: false,
    };
  }
  if (g) return { text: `Git repository with no commits yet. Its files (${f.itemCount}) will be committed as the first commit, with a README and .gitignore added if missing.`, tone: 'ok', setup: true, blocked: false };
  if (f.itemCount === 0) return { text: 'Empty folder. It will become a new project: git, a README, a .gitignore and a first commit.', tone: 'ok', setup: true, blocked: false };
  return {
    text: `A folder with ${f.itemCount} item${f.itemCount === 1 ? '' : 's'}, not a git repository yet. Git will be set up and the existing files committed as the first commit (build output like node_modules is left out).`,
    tone: 'warn',
    setup: true,
    blocked: false,
  };
}

/**
 * New board: pick (or create) the project folder with a browser, see what it is, and let the daemon set up the
 * repository when it isn't one yet: folder, git init, README, .gitignore, first commit, optionally a GitHub repo.
 */
export function NewBoardForm({ onCreated, onCancel }: { onCreated: (b: Board) => void; onCancel?: () => void }) {
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [path, setPath] = useState('');
  const [browse, setBrowse] = useState<FolderInfo | null>(null);
  const [target, setTarget] = useState<FolderInfo | null>(null);
  const [hidden, setHidden] = useState(false);
  const [newFolder, setNewFolder] = useState('');
  const [setup, setSetup] = useState<Required<Omit<RepoSetup, 'create'>>>({ branch: 'main', gitignore: 'general', github: 'none' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** worktree for a git repository, direct otherwise (the operator's default); the user can switch either way. */
  const [mode, setMode] = useState<Board['mode']>('worktree');

  const open = (p: string) => api.folder(p, hidden).then(setBrowse, (e: Error) => setError(e.message));

  // Start in the home folder.
  useEffect(() => {
    void api.folder('~').then((f) => {
      setBrowse(f);
      setPath((p) => p || f.path);
    }, (e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    if (browse) void open(browse.path);
  }, [hidden]);

  // What the chosen path is, checked as it is typed or picked.
  useEffect(() => {
    if (!path.trim()) return setTarget(null);
    setTarget(null);
    const t = setTimeout(() => api.folder(path).then(setTarget, () => setTarget(null)), 250);
    return () => clearTimeout(t);
  }, [path]);
  useEffect(() => {
    if (!nameEdited && path.trim()) setName(baseName(path.trim()));
  }, [path, nameEdited]);

  // A git repository defaults to worktrees; any other folder to direct mode.
  useEffect(() => {
    if (target) setMode(target.git && !target.git.inside ? 'worktree' : 'direct');
  }, [target?.path, target?.git?.root]);
  const base = describe(target);
  const state =
    mode === 'direct' && target && !target.notDirectory && !target.git?.inside
      ? {
          text: target.exists
            ? `Agents will work directly in this folder (${target.itemCount} item${target.itemCount === 1 ? '' : 's'}), like an IDE assistant: no git setup, branches, reviews or landing. Workers run one at a time by default.`
            : 'This folder will be created, and agents will work directly in it: no git setup, branches, reviews or landing.',
          tone: 'ok' as const,
          setup: false,
          blocked: false,
        }
      : base;
  const choose = (p: string) => {
    setPath(p);
    void open(p);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const board =
        mode === 'direct'
          ? await api.createBoard(name, target?.path ?? path, target && !target.exists ? { create: true } : undefined, 'direct')
          : await api.createBoard(name, target?.path ?? path, state.setup || setup.github !== 'none' ? { create: true, ...setup } : undefined, 'worktree');
      onCreated(board);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const crumbs = browse ? browse.path.split('/').filter(Boolean) : [];
  // A GitHub repository can be created when gh is installed and the folder has no remote yet.
  const canGitHub = mode === 'worktree' && !!browse?.gh && !state.blocked && !!target && !target.git?.origin;

  return (
    <form className="sheet wide" onSubmit={submit}>
      <h2>New board</h2>
      <p className="muted">A board drives one git repository. Pick an existing project, or any folder (even a new one) and it will be set up as a repository for you.</p>

      <label>
        Project folder
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/code/my-project" required spellCheck={false} />
      </label>

      <div className="browser" aria-label="Folder browser">
        <div className="crumbs">
          <button type="button" className="link" onClick={() => open('/')}>/</button>
          {crumbs.map((c, i) => (
            <span key={i}>
              <button type="button" className="link" onClick={() => open(`/${crumbs.slice(0, i + 1).join('/')}`)}>{c}</button>
              {i < crumbs.length - 1 && <span className="muted">/</span>}
            </span>
          ))}
          <span className="spacer" />
          {browse && <button type="button" className="ghost small-btn" onClick={() => open(browse.home)}>Home</button>}
          <label className="check small"><input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> hidden</label>
        </div>
        <ul className="dirs">
          {browse?.parent && (
            <li><button type="button" className="link" onClick={() => open(browse.parent!)}>..</button></li>
          )}
          {browse && (
            <li className={target?.path === browse.path ? 'on' : ''}>
              <button type="button" className="link" onClick={() => choose(browse.path)}>· this folder</button>
              {browse.git && !browse.git.inside && <span className="badge git">git</span>}
            </li>
          )}
          {browse?.dirs.map((d) => {
            const full = join(browse.path, d.name);
            return (
              <li key={d.name} className={target?.path === full ? 'on' : ''}>
                <button type="button" className="link" onClick={() => setPath(full)} onDoubleClick={() => open(full)} title="Click to choose, double-click to open">
                  {d.name}/
                </button>
                {d.git && <span className="badge git">git</span>}
                <span className="spacer" />
                <button type="button" className="ghost small-btn" onClick={() => open(full)} aria-label={`Open ${d.name}`}>Open ›</button>
              </li>
            );
          })}
          {browse && browse.dirs.length === 0 && <li className="muted small">No subfolders.</li>}
        </ul>
        {browse && (
          <div className="row">
            <input value={newFolder} onChange={(e) => setNewFolder(e.target.value)} placeholder="new-project" aria-label="New folder name" spellCheck={false} />
            <button type="button" className="ghost" disabled={!/^[^/\0]+$/.test(newFolder.trim())} onClick={() => setPath(join(browse.path, newFolder.trim()))}>
              New folder here
            </button>
          </div>
        )}
      </div>

      <p className={`folder-state ${state.tone}`}>{state.text}</p>

      {target && !target.notDirectory && !target.git?.inside && (
        <fieldset className="mode-choice">
          <legend>How agents work</legend>
          <label>
            <input type="radio" name="mode" checked={mode === 'worktree'} onChange={() => setMode('worktree')} />
            <span><b>Worktrees</b>: each card on its own git branch, reviewed and landed through the merge queue{target.git ? '' : ' (sets up git first)'}.</span>
          </label>
          <label>
            <input type="radio" name="mode" checked={mode === 'direct'} onChange={() => setMode('direct')} />
            <span><b>Directly in the folder</b>: edits are live as agents make them, like an IDE assistant. No branches, reviews or landing.</span>
          </label>
        </fieldset>
      )}

      {state.setup && (
        <div className="grid2">
          {!target?.git && (
            <label>
              Branch
              <input value={setup.branch} onChange={(e) => setSetup({ ...setup, branch: e.target.value })} spellCheck={false} />
            </label>
          )}
          <label>
            .gitignore (if missing)
            <select value={setup.gitignore} onChange={(e) => setSetup({ ...setup, gitignore: e.target.value as RepoSetup['gitignore'] & string })}>
              <option value="general">general</option>
              <option value="python">Python</option>
              <option value="node">Node</option>
              <option value="none">none</option>
            </select>
          </label>
        </div>
      )}
      {canGitHub && (
        <label>
          GitHub
          <select value={setup.github} onChange={(e) => setSetup({ ...setup, github: e.target.value as 'none' | 'private' | 'public' })}>
            <option value="none">Local only (cards land as local merge commits)</option>
            <option value="private">Create a private GitHub repository and push (cards land as PRs)</option>
            <option value="public">Create a public GitHub repository and push (cards land as PRs)</option>
          </select>
        </label>
      )}

      <label>
        Board name
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setNameEdited(true);
          }}
          placeholder="My project"
          required
        />
      </label>

      {error && <p className="error">{error}</p>}
      <div className="row">
        <button type="submit" disabled={busy || state.blocked || !name.trim()}>
          {busy ? 'Setting up…' : state.setup || setup.github !== 'none' ? 'Set up repository & create board' : 'Create board'}
        </button>
        {onCancel && <button type="button" className="ghost" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}
