// Page theme for CAL pages, run at document_start. chrome.storage is async-only, so the last resolved theme is cached
// in the site's localStorage and applied synchronously before the body is parsed (no light flash on later loads).
// The manifest matches /cal/ paths on any host, so nothing is applied or cached until the page is confirmed to be
// CAL; only an origin that passed that check has a cache to apply early. theme.css keys on html[data-cal-theme=dark].

import './theme.css';
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged } from '../shared/settings';
import { DARK_QUERY, resolveTheme, THEME_CACHE_KEY, type ResolvedTheme, type ThemeSetting } from '../shared/theme';

const LOG = '[cycu-cal-ext]';
const root = document.documentElement;
const media = matchMedia(DARK_QUERY);
// The page's own Bootstrap theme, if it ever ships one; restored when switching back to light.
const pageBsTheme = root.getAttribute('data-bs-theme');

let setting: ThemeSetting | null = null;
let isCal = false;

/** Every CAL page has the #left nav bar and MarkDownStyle.css; topic pages (and the test harness) have the editor. */
function isCalPage(): boolean {
  if (document.getElementById('left') && document.querySelector('link[href*="MarkDownStyle.css"]')) return true;
  return !!document.getElementById('editor') && !!document.getElementById('coding');
}

function apply(theme: ResolvedTheme | null): void {
  if (theme) root.setAttribute('data-cal-theme', theme);
  else root.removeAttribute('data-cal-theme');
  if (theme === 'dark') root.setAttribute('data-bs-theme', 'dark');
  else if (pageBsTheme === null) root.removeAttribute('data-bs-theme');
  else root.setAttribute('data-bs-theme', pageBsTheme);
}

function cached(): ResolvedTheme | null {
  try {
    const v = localStorage.getItem(THEME_CACHE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

function update(): void {
  if (!isCal) return;
  const theme = resolveTheme(setting ?? cached() ?? DEFAULT_SETTINGS.theme, media.matches);
  apply(theme);
  if (setting === null) return;
  try {
    localStorage.setItem(THEME_CACHE_KEY, theme);
  } catch {
    // Storage blocked: every load just waits for settings instead.
  }
}

function onReady(): void {
  isCal = isCalPage();
  if (isCal) update();
  else apply(null);
}

if (!(globalThis as any).__calThemeStarted) {
  (globalThis as any).__calThemeStarted = true;
  apply(cached());
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady, { once: true });
  else onReady();
  media.addEventListener('change', update);
  onSettingsChanged((s) => {
    setting = s.theme;
    update();
  });
  loadSettings()
    .then((s) => {
      setting = s.theme;
      update();
    })
    .catch((err) => console.error(LOG, 'theme settings', err));
}
