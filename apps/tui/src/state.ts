import type { CardChanges, Need } from '@ih/client';
import type { FileContent, FileEntry } from '@ih/core';
import type { Endpoint } from '@ih/client/node';
import type { Snapshot } from './data.ts';

export type View = 'needs' | 'board' | 'pools' | 'files';
export const VIEWS: { id: View; label: string }[] = [
  { id: 'needs', label: 'Needs you' },
  { id: 'board', label: 'Board' },
  { id: 'pools', label: 'Pools' },
  { id: 'files', label: 'Files' },
];

/** A folder of the project as last listed (or why it could not be). */
export interface FileDir {
  entries?: FileEntry[];
  error?: string;
}
/** The file tree: which board it belongs to, the folders loaded so far and which are open. */
export interface FilesState {
  boardId: string | null;
  dirs: Record<string, FileDir>;
  expanded: Set<string>;
}

export interface Toast {
  text: string;
  tone: 'ok' | 'bad' | 'info';
  until: number;
}
export interface MenuItem {
  id: string;
  label: string;
  detail?: string;
  disabled?: boolean;
}
export type Modal =
  | { kind: 'prompt'; title: string; hint: string; value: string; required: boolean; submit: (value: string) => void }
  | { kind: 'menu'; title: string; items: MenuItem[]; index: number; pick: (id: string) => void; refresh?: () => MenuItem[] }
  | { kind: 'card'; cardId: string; scroll: number; changes: CardChanges | null }
  | { kind: 'file'; path: string; scroll: number; data: FileContent | null; error: string | null }
  | { kind: 'help' };

export interface AppState {
  endpoints: Endpoint[];
  machine: string;
  snap: Snapshot;
  view: View;
  sel: Record<View, number>;
  scroll: Record<View, number>;
  folded: Set<string>;
  files: FilesState;
  modal: Modal | null;
  toast: Toast | null;
  busy: string | null;
  mouse: boolean;
  now: number;
  isSeen: (n: Need) => boolean;
}
