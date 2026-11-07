// What each screen looks like. Pure drawing: the state in, cells and click regions out.
import type { Need } from '@mh/client';
import { CARD_STATUSES, type Card, type CardStatus } from '@mh/core';
import { Canvas, fit, wrap, type Style } from './canvas.ts';
import { VIEWS, type AppState, type View } from './state.ts';

export const HEADER = 0;
export const TABS = 1;
export const BANNER = 2;
export const BODY_TOP = 3;
/** Rows kept below the body: the toast line and the buttons. */
export const BOTTOM = 2;

export interface Action {
  id: string;
  label: string;
  key: string;
  /** Shown in red: it discards or refuses something. */
  bad?: boolean;
}

const KIND_LABEL: Record<Need['kind'], string> = { approval: 'approve', review: 'review', blocked: 'blocked', outcome: 'weigh', message: 'message' };
const STATUS_TITLE: Record<CardStatus, string> = { backlog: 'Backlog', ready: 'Ready', in_progress: 'In progress', review: 'Review', merging: 'Merging', done: 'Done', blocked: 'Blocked' };
/** What needs a person first. */
export const BOARD_ORDER: CardStatus[] = ['blocked', 'review', 'in_progress', 'merging', 'ready', 'backlog', 'done'];

/** What can be done with a need, in the order the buttons appear. */
export function needActions(n: Need): Action[] {
  switch (n.kind) {
    case 'approval':
      return n.approvalKind === 'escalation'
        ? [{ id: 'answer', label: 'Answer', key: 'a' }, { id: 'deny', label: 'Dismiss', key: 'd', bad: true }]
        : [{ id: 'approve', label: 'Approve', key: 'a' }, { id: 'deny', label: 'Deny', key: 'd', bad: true }, ...(n.cardId ? [{ id: 'open', label: 'Open card', key: 'o' }] : [])];
    case 'review':
      return [{ id: 'review-approve', label: 'Approve', key: 'a' }, { id: 'review-changes', label: 'Request changes', key: 'c', bad: true }, { id: 'open', label: 'Open card', key: 'o' }];
    case 'blocked':
      return [{ id: 'open', label: 'Open card', key: 'o' }, { id: 'message', label: 'Message', key: 'm' }, { id: 'retry', label: 'Retry', key: 'y' }];
    case 'outcome':
      return [{ id: 'pass', label: 'Fine', key: 'p' }, { id: 'fail', label: 'Was wrong', key: 'f', bad: true }, { id: 'ignore', label: 'Ignore', key: 'i' }];
    case 'message':
      return [...(n.cardId ? [{ id: 'open', label: 'Open card', key: 'o' }, { id: 'message', label: 'Reply', key: 'm' }] : [])];
  }
}

export type BoardRow = { kind: 'header'; status: CardStatus; count: number; folded: boolean } | { kind: 'card'; card: Card };

export function boardRows(cards: Card[], folded: Set<string>): BoardRow[] {
  const rows: BoardRow[] = [];
  for (const status of BOARD_ORDER) {
    const inStatus = cards.filter((c) => c.status === status);
    if (!inStatus.length) continue;
    const isFolded = folded.has(status);
    rows.push({ kind: 'header', status, count: inStatus.length, folded: isFolded });
    if (!isFolded) for (const card of inStatus) rows.push({ kind: 'card', card });
  }
  return rows;
}

export function cardActions(card: Card): Action[] {
  return [
    ...(card.status === 'review' ? [{ id: 'review-approve', label: 'Approve', key: 'a' }, { id: 'review-changes', label: 'Request changes', key: 'c', bad: true }, { id: 'land', label: 'Land now', key: 'l' }] : []),
    { id: 'message', label: 'Message', key: 'm' },
    { id: 'move', label: 'Move…', key: 'v' },
    { id: 'terminal', label: 'Terminal', key: 't' },
    ...(card.status === 'in_progress' ? [{ id: 'cancel', label: 'Stop', key: 'x', bad: true }] : []),
  ];
}

export const ago = (iso: string, now: number): string => {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 129_600 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86_400)}d`;
};

const TONE: Record<string, Style> = { ok: { fg: 'green' }, bad: { fg: 'red' }, info: { fg: 'cyan' } };
const POOL_COLOR = { open: 'green', warn: 'yellow', halted: 'red', locked: 'red' } as const;

/** Keeps the selected row inside the visible window; returns the new first row. */
export function scrollFor(sel: number, scroll: number, rows: number, total: number): number {
  const max = Math.max(0, total - rows);
  if (sel < scroll) return Math.min(sel, max);
  if (sel >= scroll + rows) return Math.min(sel - rows + 1, max);
  return Math.min(scroll, max);
}

export function draw(c: Canvas, s: AppState): void {
  const online = s.endpoints.find((e) => e.label === s.machine)?.state === 'online';
  drawHeader(c, s);
  drawTabs(c, s);
  drawBanner(c, s, online);
  const bodyH = c.height - BODY_TOP - BOTTOM;
  if (s.view === 'needs') drawNeeds(c, s, bodyH, online);
  else if (s.view === 'board') drawBoard(c, s, bodyH);
  else drawPools(c, s, bodyH);
  if (!online) c.dim(0, BODY_TOP, c.width, bodyH);
  drawFooter(c, s);
  if (s.modal) drawModal(c, s);
  drawToast(c, s); // last, so a message about what just happened is not hidden behind a dialog
}

function unseenCount(s: AppState): number {
  return s.snap.needs.filter((n) => !s.isSeen(n)).length;
}

function drawHeader(c: Canvas, s: AppState) {
  let x = c.put(0, HEADER, ' ∞ Infinity Harness', { bold: true });
  const ep = s.endpoints.find((e) => e.label === s.machine);
  const glyph = ep?.state === 'online' ? '●' : ep?.state === 'attention' ? '!' : ep?.state === 'stopped' ? '○' : '◌';
  const color = ep?.state === 'online' ? 'green' : ep?.state === 'attention' ? 'red' : 'yellow';
  x += 2;
  const m = ` ${glyph} ${s.machine} ▾ `;
  c.put(x, HEADER, m, { inverse: true });
  c.put(x + 1, HEADER, glyph, { inverse: true, fg: color });
  c.region(x, HEADER, m.length, 1, 'machine');
  x += m.length + 1;
  if (s.snap.board && c.width >= 50) {
    const b = ` ${fit(s.snap.board.name, 18)} ▾ `;
    c.put(x, HEADER, b, { inverse: true });
    c.region(x, HEADER, b.length, 1, 'board');
    x += b.length + 1;
  }
  const n = unseenCount(s);
  const badge = n ? `● ${n} new` : s.snap.needs.length ? `${s.snap.needs.length} waiting` : 'all clear';
  c.put(Math.max(x, c.width - badge.length - 1), HEADER, badge, n ? { fg: 'yellow', bold: true } : { dim: true });
}

function drawTabs(c: Canvas, s: AppState) {
  let x = 0;
  for (const v of VIEWS) {
    const count = v.id === 'needs' ? ` (${s.snap.needs.length})` : v.id === 'board' ? ` (${s.snap.cards.filter((card) => card.status !== 'done').length})` : '';
    const label = ` ${v.label}${count} `;
    c.put(x, TABS, label, v.id === s.view ? { inverse: true, bold: true } : { underline: false });
    c.region(x, TABS, label.length, 1, `tab:${v.id}`);
    x += label.length + 1;
  }
  c.put(0, BANNER, '─'.repeat(c.width), { dim: true });
}

function drawBanner(c: Canvas, s: AppState, online: boolean) {
  const ep = s.endpoints.find((e) => e.label === s.machine);
  if (online && !s.snap.error) return;
  const why = s.snap.error ?? ep?.error ?? ep?.state ?? 'not connected';
  const text = online ? ` ${s.machine}: ${why} ` : ` ${s.machine}: ${ep?.state === 'attention' ? 'needs attention' : ep?.state ?? 'not connected'}${why && why !== ep?.state ? ` (${why})` : ''}${s.snap.loadedAt ? ': showing the last known state' : ''} `;
  c.put(0, BANNER, fit(text, c.width).padEnd(c.width), { inverse: true, fg: 'yellow' });
}

function list(c: Canvas, s: AppState, view: View, rows: number, count: number, line: (i: number, y: number, selected: boolean) => void) {
  const scroll = scrollFor(s.sel[view], s.scroll[view], rows, count);
  s.scroll[view] = scroll;
  for (let r = 0; r < rows && scroll + r < count; r++) {
    const i = scroll + r;
    const y = BODY_TOP + r;
    const selected = i === s.sel[view];
    if (selected) c.fill(0, y, c.width, 1, { inverse: true });
    line(i, y, selected);
    c.region(0, y, c.width, 1, `row:${view}:${i}`);
  }
  if (count > rows) {
    const bar = Math.max(1, Math.round((rows * rows) / count));
    const top = Math.round((scroll / Math.max(1, count - rows)) * (rows - bar));
    for (let r = 0; r < rows; r++) c.put(c.width - 1, BODY_TOP + r, r >= top && r < top + bar ? '█' : '│', { dim: true });
  }
}

function drawNeeds(c: Canvas, s: AppState, bodyH: number, online: boolean) {
  const needs = s.snap.needs;
  if (!needs.length) {
    c.put(2, BODY_TOP + 1, 'Nothing is waiting for you.', { dim: true });
    c.put(2, BODY_TOP + 2, s.snap.board ? 'Agents are working, or have nothing to ask.' : 'There are no boards on this machine yet.', { dim: true });
    return;
  }
  const detailH = bodyH >= 14 ? 7 : bodyH >= 10 ? 5 : 0;
  const rows = bodyH - detailH;
  const wide = c.width >= 56;
  list(c, s, 'needs', rows, needs.length, (i, y, selected) => {
    const n = needs[i]!;
    const unseen = !s.isSeen(n);
    const st: Style | undefined = selected ? { inverse: true } : undefined;
    c.put(0, y, unseen ? ' ●' : '  ', { ...st, fg: 'yellow' });
    let x = 3;
    if (wide) x += c.put(x, y, KIND_LABEL[n.kind].padEnd(8), { ...st, dim: !selected, fg: n.kind === 'blocked' ? 'red' : undefined });
    const age = ago(n.at, s.now);
    const room = c.width - x - age.length - 3;
    c.put(x, y, fit(n.title, room), { ...st, bold: unseen });
    c.put(c.width - age.length - 2, y, age, { ...st, dim: !selected });
  });
  if (!detailH) return;
  const n = needs[s.sel.needs];
  if (!n) return;
  const top = BODY_TOP + rows;
  c.put(0, top, '─'.repeat(c.width), { dim: true });
  c.put(2, top + 1, fit(n.title, c.width - 4), { bold: true });
  const lines = wrap(n.detail || ' ', c.width - 4).slice(0, detailH - 3);
  lines.forEach((l, i) => c.put(2, top + 2 + i, l, { dim: true }));
  if (online) {
    let x = 2;
    for (const a of needActions(n)) x += c.button(x, top + detailH - 1, `${a.label} ${a.key}`, `act:${a.id}`, a.bad ? { fg: 'red' } : undefined) + 1;
  }
}

function drawBoard(c: Canvas, s: AppState, bodyH: number) {
  const rows = boardRows(s.snap.cards, s.folded);
  if (!rows.length) {
    c.put(2, BODY_TOP + 1, s.snap.board ? 'This board has no cards yet.' : 'There are no boards on this machine yet.', { dim: true });
    return;
  }
  list(c, s, 'board', bodyH, rows.length, (i, y, selected) => {
    const row = rows[i]!;
    const st: Style | undefined = selected ? { inverse: true } : undefined;
    if (row.kind === 'header') {
      c.put(1, y, `${row.folded ? '▸' : '▾'} ${STATUS_TITLE[row.status]} (${row.count})`, { ...st, bold: true, fg: row.status === 'blocked' ? 'red' : undefined });
      return;
    }
    const card = row.card;
    const x = 4 + c.put(4, y, card.role === 'worker' ? '' : `${card.role} `, { ...st, dim: !selected });
    const who = card.agentId ? ` ${card.agentId}` : '';
    c.put(x, y, fit(card.title, c.width - x - who.length - 3), st);
    if (who) c.put(c.width - who.length - 2, y, who, { ...st, dim: !selected });
  });
}

function bar(pct: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return '▓'.repeat(filled) + '░'.repeat(width - filled);
}

function drawPools(c: Canvas, s: AppState, bodyH: number) {
  const pools = s.snap.pools;
  if (!pools.length) {
    c.put(2, BODY_TOP + 1, 'No pools reported.', { dim: true });
    return;
  }
  list(c, s, 'pools', Math.min(bodyH, pools.length), pools.length, (i, y, selected) => {
    const p = pools[i]!;
    const st: Style | undefined = selected ? { inverse: true } : undefined;
    const top = p.status.windows.reduce<{ window: string; pct: number } | undefined>((a, w) => (!a || w.pct > a.pct ? w : a), undefined);
    c.put(2, y, p.id.padEnd(8), { ...st, bold: true });
    c.put(11, y, p.status.state.padEnd(7), { ...st, fg: POOL_COLOR[p.status.state] });
    const barW = Math.max(6, Math.min(20, c.width - 50));
    c.put(19, y, bar(top?.pct ?? 0, barW), st);
    const detail = p.status.windows.map((w) => `${w.window} ${Math.round(w.pct)}%`).join('  ');
    c.put(19 + barW + 1, y, fit(`${detail}${p.running ? `  ${p.running} running` : ''}`, c.width - barW - 22), { ...st, dim: !selected });
  });
  const usage = s.snap.usage;
  const y = BODY_TOP + Math.min(bodyH, pools.length) + 1;
  if (usage && y < BODY_TOP + bodyH) {
    c.put(2, y, `Last ${usage.hours}h: ${usage.totals.tokens.toLocaleString()} tokens · $${usage.totals.costUsd.toFixed(2)} · ${usage.totals.requests} requests`, { dim: true });
    usage.budgets.slice(0, bodyH - pools.length - 2).forEach((b, i) => {
      c.put(2, y + 1 + i, `budget ${b.scope.padEnd(14)} ${bar(b.pct, 12)} ${Math.round(b.pct)}%  ${b.state}`, { fg: b.state === 'open' ? undefined : POOL_COLOR[b.state] });
    });
  }
}

function drawFooter(c: Canvas, s: AppState) {
  const y = c.height - 1;
  let x = 0;
  for (const [label, id] of [['Refresh r', 'refresh'], ['Machine M', 'machine'], ['Board B', 'board'], ['Help ?', 'help'], ['Quit q', 'quit']] as const) {
    if (x + label.length + 3 > c.width) break;
    x += c.button(x, y, label, id, { dim: true }) + 1;
  }
  if (!s.mouse && c.width - x > 14) c.put(c.width - 14, y, 'keys only', { dim: true });
}

function drawToast(c: Canvas, s: AppState) {
  const y = c.height - 2;
  if (s.toast) {
    c.fill(0, y, c.width, 1);
    c.put(1, y, fit(s.toast.text, c.width - 2), TONE[s.toast.tone]);
  } else if (s.busy) c.put(1, y, fit(`${s.busy}…`, c.width - 2), { dim: true });
}

function modalBox(c: Canvas, x: number, y: number, w: number, h: number, title: string) {
  const inner = c.box(x, y, w, h, title);
  c.region(x, y, w, h, 'modal:box');
  return inner;
}

function drawModal(c: Canvas, s: AppState) {
  const m = s.modal!;
  const w = Math.min(c.width - 2, m.kind === 'card' ? 78 : 62);
  const x = Math.floor((c.width - w) / 2);
  c.region(0, 0, c.width, c.height, 'modal:backdrop');
  c.dim(0, 0, c.width, c.height);
  if (m.kind === 'help') {
    const lines = [
      'Click anything. Keys are shown on the buttons.',
      '',
      '↑ ↓ j k   move        PgUp PgDn   page         wheel   scroll',
      'Tab  1 2 3   switch screen        Enter   open the selected item',
      'a  approve / answer     d  deny     o  open card     m  message',
      'c  request changes     y  retry     p f i  weigh a result',
      'M  switch machine      B  switch board           r  refresh',
      'f  (on Board) fold a column        q  quit  (Ctrl+C too)',
    ];
    const h = lines.length + 4;
    const y = Math.max(1, Math.floor((c.height - h) / 2));
    const inner = modalBox(c, x, y, w, h, 'Help');
    lines.forEach((l, i) => c.put(inner.x, inner.y + i, fit(l, inner.w)));
    c.button(inner.x, y + h - 2, 'Close esc', 'modal:close');
    return;
  }
  if (m.kind === 'prompt') {
    const h = 7;
    const y = Math.max(1, Math.floor((c.height - h) / 2));
    const inner = modalBox(c, x, y, w, h, m.title);
    c.put(inner.x, inner.y, fit(m.hint, inner.w), { dim: true });
    const shown = m.value.length > inner.w - 2 ? `…${m.value.slice(-(inner.w - 3))}` : m.value;
    c.put(inner.x, inner.y + 2, `${shown}█`.padEnd(inner.w), { inverse: true });
    let bx = inner.x;
    bx += c.button(bx, y + h - 2, 'Send ⏎', 'prompt:submit') + 1;
    c.button(bx, y + h - 2, 'Cancel esc', 'prompt:cancel');
    return;
  }
  if (m.kind === 'menu') {
    const h = Math.min(c.height - 2, m.items.length + 4);
    const y = Math.max(1, Math.floor((c.height - h) / 2));
    const inner = modalBox(c, x, y, w, h, m.title);
    m.items.slice(0, inner.h - 1).forEach((item, i) => {
      const st: Style = i === m.index ? { inverse: true } : item.disabled ? { dim: true } : {};
      c.fill(inner.x, inner.y + i, inner.w, 1, i === m.index ? { inverse: true } : undefined);
      c.put(inner.x, inner.y + i, fit(`${item.label}${item.detail ? `  ${item.detail}` : ''}`, inner.w), st);
      if (!item.disabled) c.region(inner.x, inner.y + i, inner.w, 1, `menu:${i}`);
    });
    c.button(inner.x, y + h - 2, 'Close esc', 'modal:close');
    return;
  }
  // card
  const card = s.snap.cards.find((cd) => cd.id === m.cardId);
  const h = c.height - 2;
  const y = 1;
  const inner = modalBox(c, x, y, w, h, card ? fit(card.title, w - 8) : 'Card');
  if (!card) {
    c.put(inner.x, inner.y, 'This card is gone.', { dim: true });
    c.button(inner.x, y + h - 2, 'Close esc', 'modal:close');
    return;
  }
  const info = [
    `${STATUS_TITLE[card.status]} · ${card.role} · ${card.agentId ?? 'no agent yet'}${card.poolId ? ` on ${card.poolId}` : ''}`,
    card.branch ? `branch ${card.branch}` : '',
    card.narration ? `now: ${card.narration}` : '',
    m.changes ? `${m.changes.files.length} file${m.changes.files.length === 1 ? '' : 's'} changed${m.changes.landed ? ' (landed)' : ''}: ${m.changes.files.slice(0, 6).map((f) => f.path).join(', ')}` : '',
    '',
    ...wrap(card.description || '(no description)', inner.w),
  ].filter((l, i) => l || i === 4);
  const textRows = inner.h - 3;
  const scroll = Math.max(0, Math.min(m.scroll, Math.max(0, info.length - textRows)));
  m.scroll = scroll;
  info.slice(scroll, scroll + textRows).forEach((l, i) => c.put(inner.x, inner.y + i, fit(l, inner.w), i === 0 ? { bold: true } : undefined));
  c.region(inner.x, inner.y, inner.w, textRows, 'card:text');
  let bx = inner.x;
  const by = y + h - 2;
  for (const a of cardActions(card)) {
    const label = `${a.label} ${a.key}`;
    if (bx + label.length + 3 > inner.x + inner.w) break;
    bx += c.button(bx, by, label, `card:${a.id}`, a.bad ? { fg: 'red' } : undefined) + 1;
  }
  c.button(inner.x + inner.w - 11, y, 'Close esc', 'modal:close');
}
