// Light/dark resolution shared by the page theme script, Monaco and the options page. No browser imports.

export type ThemeSetting = 'light' | 'dark' | 'auto';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_SETTINGS: readonly ThemeSetting[] = ['light', 'dark', 'auto'];

/** localStorage key (in the site's origin) caching the last resolved theme, read synchronously at document_start. */
export const THEME_CACHE_KEY = 'cal-ext-theme';

export const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Monaco's built-in themes. */
export type EditorTheme = 'vs' | 'vs-dark' | 'hc-light' | 'hc-black';
/** The editor's theme: one of Monaco's built-ins, or 'page' to follow the page theme. */
export type EditorThemeSetting = 'page' | EditorTheme;

export const EDITOR_THEME_SETTINGS: readonly EditorThemeSetting[] = ['page', 'vs', 'vs-dark', 'hc-light', 'hc-black'];

/** 'auto' follows the system color scheme. */
export function resolveTheme(theme: ThemeSetting, prefersDark: boolean): ResolvedTheme {
  if (theme === 'auto') return prefersDark ? 'dark' : 'light';
  return theme;
}

/** 'page' picks vs or vs-dark to match the (resolved) page theme. */
export function resolveEditorTheme(editor: EditorThemeSetting, page: ResolvedTheme): EditorTheme {
  if (editor === 'page') return page === 'dark' ? 'vs-dark' : 'vs';
  return editor;
}

export function isDarkEditorTheme(theme: EditorTheme): boolean {
  return theme === 'vs-dark' || theme === 'hc-black';
}
