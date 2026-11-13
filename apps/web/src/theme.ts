import { remember, saved } from './storage.ts';

export const THEMES = [
  { id: 'clean', name: 'Clean', hint: 'Precision interface: crisp borders and layered surfaces' },
  { id: 'aero', name: 'Frutiger Aero', hint: 'Sky gradients, specular gloss and soft aqua glass' },
  { id: 'metro', name: 'Metro', hint: 'Sharp 0px tiles, bold Swiss typography and flat accents' },
  { id: 'metalheart', name: 'Metalheart', hint: 'Machined metal and ember LED telemetry' },
  { id: 'glass', name: 'Glassmorphism', hint: 'Frosted acrylic panels over a vivid mesh backdrop' },
] as const;
export type ThemeId = (typeof THEMES)[number]['id'];

export const COLOR_MODES = [
  { id: 'system', label: 'Auto', hint: 'Follow system light or dark appearance' },
  { id: 'light', label: 'Light', hint: 'Light appearance' },
  { id: 'dark', label: 'Dark', hint: 'Dark appearance' },
] as const;
export type ColorMode = (typeof COLOR_MODES)[number]['id'];

const KEY = 'ih.theme';
const MODE_KEY = 'ih.colorMode';

export function savedTheme(): ThemeId {
  // ?theme=metro in the URL picks (and remembers) a theme.
  const t = new URLSearchParams(location.search).get('theme') ?? saved(KEY);
  return THEMES.some((x) => x.id === t) ? (t as ThemeId) : 'clean';
}

export function savedColorMode(): ColorMode {
  const m = new URLSearchParams(location.search).get('mode') ?? saved(MODE_KEY);
  return COLOR_MODES.some((x) => x.id === m) ? (m as ColorMode) : 'system';
}

export function resolveColorMode(mode: ColorMode): 'light' | 'dark' {
  if (mode === 'light' || mode === 'dark') return mode;
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Themes are token sets on <html data-ui-theme>; light/dark follows data-color-mode (or system by default). */
export function applyTheme(id: ThemeId) {
  document.documentElement.dataset.uiTheme = id;
  remember(KEY, id);
}

export function applyColorMode(mode: ColorMode) {
  document.documentElement.dataset.colorMode = resolveColorMode(mode);
  document.documentElement.dataset.colorModePref = mode;
  remember(MODE_KEY, mode);
}

