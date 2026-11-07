import { remember, saved } from './storage.ts';

export const THEMES = [
  { id: 'clean', name: 'Clean', hint: 'The default: plain, light or dark with your system' },
  { id: 'aero', name: 'Frutiger Aero', hint: 'Sky gradients, gloss and soft glass' },
  { id: 'metro', name: 'Metro', hint: 'Flat tiles, square corners, bold accents' },
  { id: 'metalheart', name: 'Metalheart', hint: 'Brushed steel and ember red, always dark' },
  { id: 'glass', name: 'Glassmorphism', hint: 'Frosted panels over a vivid backdrop' },
] as const;
export type ThemeId = (typeof THEMES)[number]['id'];

const KEY = 'ih.theme';

export function savedTheme(): ThemeId {
  // ?theme=metro in the URL picks (and remembers) a theme.
  const t = new URLSearchParams(location.search).get('theme') ?? saved(KEY);
  return THEMES.some((x) => x.id === t) ? (t as ThemeId) : 'clean';
}

/** Themes are token sets on <html data-ui-theme>; light/dark still follows the system inside each one. */
export function applyTheme(id: ThemeId) {
  document.documentElement.dataset.uiTheme = id;
  remember(KEY, id);
}
