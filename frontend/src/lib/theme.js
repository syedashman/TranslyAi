import { syncStatusBar } from './native';

const THEME_KEY = 'linguaai-theme';

export function getStoredTheme() {
  try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  syncStatusBar(theme); // no-op on the web; keeps the Android status bar matching the app's own theme
}

export function setTheme(theme) {
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage unavailable: theme still applies for this visit */ }
  applyTheme(theme);
}
