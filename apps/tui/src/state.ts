import type { CardChanges, Need } from '@mh/client';
import type { Endpoint } from '@mh/client/node';
import type { Snapshot } from './data.ts';

export type View = 'needs' | 'board' | 'pools';
export const VIEWS: { id: View; label: string }[] = [
  { id: 'needs', label: 'Needs you' },
  { id: 'board', label: 'Board' },
  { id: 'pools', label: 'Pools' },
];

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
  | { kind: 'help' };

export interface AppState {
  endpoints: Endpoint[];
  machine: string;
  snap: Snapshot;
  view: View;
  sel: Record<View, number>;
  scroll: Record<View, number>;
  folded: Set<string>;
  modal: Modal | null;
  toast: Toast | null;
  busy: string | null;
  mouse: boolean;
  now: number;
  isSeen: (n: Need) => boolean;
}
