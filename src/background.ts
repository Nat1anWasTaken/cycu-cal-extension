// Background service worker: makes sure the offscreen document (clangd / SLM host) exists,
// and opens the options page on request. Content scripts then connect to the offscreen
// document directly with chrome.runtime.connect().

import type { EnsureOffscreenResponse, ToBackground } from './shared/protocol';

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

let creating: Promise<void> | null = null;

async function hasOffscreen(): Promise<boolean> {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [url],
  });
  return contexts.length > 0;
}

/** Creates the offscreen document unless it already exists. Safe to call concurrently. */
export async function ensureOffscreen(): Promise<void> {
  if (creating) return creating;
  if (await hasOffscreen()) return;
  // Re-check after the await: another call may have started creating meanwhile.
  if (creating) return creating;
  creating = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: 'Runs clangd (WebAssembly) and the optional local completion model in workers.',
      });
    } catch (e) {
      // Lost a race with another context: fine as long as the document now exists.
      if (!(await hasOffscreen())) throw e;
    } finally {
      creating = null;
    }
  })();
  return creating;
}

chrome.runtime.onMessage.addListener((msg: ToBackground, _sender, sendResponse) => {
  switch (msg?.type) {
    case 'ensureOffscreen':
      ensureOffscreen().then(
        () => sendResponse({ ok: true } satisfies EnsureOffscreenResponse),
        (e) => sendResponse({ ok: false, error: String(e?.message ?? e) } satisfies EnsureOffscreenResponse),
      );
      return true; // async response
    case 'openOptions':
      void chrome.runtime.openOptionsPage();
      return false;
  }
  return false;
});

// Test hook (scripts/e2e-runtime.mjs drives the service worker over CDP).
(globalThis as { __calEnsureOffscreen?: typeof ensureOffscreen }).__calEnsureOffscreen = ensureOffscreen;
