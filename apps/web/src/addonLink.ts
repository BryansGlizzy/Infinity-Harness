import type { AddonView } from '@ih/core';

// What the status strip shows for an add-on's link to the outside world (Roblox: Studio's plugins and the sync process).
// Pure, so it can be tested without a browser.

export type LinkState = 'ok' | 'bad' | 'unknown';

export interface LinkPart {
  id: string;
  /** Short name for the chip. */
  label: string;
  state: LinkState;
  /** One line for the tooltip. */
  detail: string;
}

export interface LinkSummary {
  id: string;
  label: string;
  /** ok: everything connected. bad: something is not. unknown: not read yet. */
  state: LinkState;
  parts: LinkPart[];
  /** What to do, when something is not connected. */
  advice: string | null;
}

const short = (label: string) => label.replace(/\s*(MCP\s+)?plugin\s*$/i, '').replace(/\s*file sync$/i, ' sync').trim() || label;

/** One summary per add-on that is switched on and has an outside half to watch. */
export function linkSummaries(addons: AddonView[]): LinkSummary[] {
  const out: LinkSummary[] = [];
  for (const a of addons) {
    if (!a.enabled) continue;
    const parts: LinkPart[] = a.components
      .filter((c) => c.kind === 'plugin' || c.kind === 'service')
      .map((c) => ({
        id: c.id,
        label: short(c.label),
        state: (c.state === 'running' ? 'ok' : c.state === 'starting' ? 'unknown' : 'bad') as LinkState,
        detail: `${c.kind === 'plugin' ? (c.state === 'running' ? 'connected' : 'not connected') : c.state}${c.detail ? `: ${c.detail}` : ''}`,
      }));
    if (!parts.length) continue;
    // Plugins are read a few seconds after the add-on is switched on; until then the link is unknown, not broken.
    const readAny = a.components.some((c) => c.kind === 'plugin');
    const state: LinkState = parts.some((p) => p.state === 'bad') ? 'bad' : !readAny || parts.some((p) => p.state === 'unknown') ? 'unknown' : 'ok';
    out.push({ id: a.id, label: a.label, state, parts, advice: state === 'bad' ? a.advice : null });
  }
  return out;
}

/** Applies a pushed view of one add-on to the list the page holds. */
export function applyAddonView(list: AddonView[], view: AddonView): AddonView[] {
  return list.some((a) => a.id === view.id) ? list.map((a) => (a.id === view.id ? view : a)) : [...list, view];
}
