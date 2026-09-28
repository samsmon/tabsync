// 'system' | 'light' | 'dark', kept per device in localStorage (shared by the list and settings pages).
const KEY = 'theme';
export const THEMES = ['system', 'light', 'dark'];

export function getTheme() {
  try { return THEMES.includes(localStorage.getItem(KEY)) ? localStorage.getItem(KEY) : 'system'; } catch { return 'system'; }
}

export function applyTheme(theme = getTheme()) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

export function setTheme(theme) {
  try { localStorage.setItem(KEY, theme); } catch {}
  applyTheme(theme);
}

// Another open TabSync page changed the theme.
addEventListener('storage', (e) => e.key === KEY && applyTheme());
