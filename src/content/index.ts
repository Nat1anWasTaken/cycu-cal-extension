// ISOLATED-world content script entry. Monaco resolves most of its UI strings while its modules load,
// so the rest of the content script (app.ts) is imported only after settings have set the UI locale.

import { localeFor, setLocale } from '../shared/i18n';
import { DEFAULT_SETTINGS, loadSettings } from '../shared/settings';

const LOG = '[cycu-cal-ext]';

async function start(): Promise<void> {
  if (!document.getElementById('editor') || !document.getElementById('coding')) return;
  const settings = await loadSettings().catch(() => DEFAULT_SETTINGS);
  setLocale(localeFor(settings.language));
  const { main } = await import('./app');
  await main(settings);
}

if (!(globalThis as any).__calExtStarted) {
  (globalThis as any).__calExtStarted = true;
  start().catch((err) => console.error(LOG, err));
}
