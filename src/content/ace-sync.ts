// Monaco → Ace text sync. Ace (hidden) stays the page's source of truth, so every Monaco edit
// must reach it: debounced (~100 ms) while typing, and SYNCHRONOUSLY right before RUN, because
// the page's click handler reads `editor.getValue()` in the same task (see FLUSH_EVENT).

import type * as Monaco from 'monaco-editor/editor/editor.api.js';
import { setModelText } from '../editor/monaco-setup';
import { FLUSH_EVENT } from '../shared/protocol';

const DEBOUNCE_MS = 100;

export interface AceSync {
  /** Push Monaco's text into Ace now (synchronous). */
  flush(): void;
  /** Apply text that came from Ace (aceChanged) to Monaco without echoing it back. */
  applyFromAce(value: string, apply: (fn: () => void) => void): void;
  /** Enable/disable Monaco → Ace pushes (disabled while the user edits in Ace). */
  setActive(active: boolean): void;
  dispose(): void;
}

/** Synchronously hands `value` to the MAIN world, which writes it into Ace before returning. */
export function pushToAce(value: string): void {
  document.dispatchEvent(new CustomEvent(FLUSH_EVENT, { detail: value }));
}

export function createAceSync(model: Monaco.editor.ITextModel): AceSync {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let remote = 0;
  let active = true;

  const flush = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!active) return;
    const v = model.getValue();
    pushToAce(v); // MAIN world compares with Ace's text, so redundant pushes are no-ops
  };

  const sub = model.onDidChangeContent(() => {
    if (remote > 0 || !active) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE_MS);
  });

  // RUN click: capture phase on document runs before the page's own (jQuery) handlers.
  const onClick = (e: MouseEvent) => {
    const t = e.target as Element | null;
    if (t && typeof t.closest === 'function' && t.closest('#submitbtn')) flush();
  };
  document.addEventListener('click', onClick, true);

  return {
    flush,
    applyFromAce(value, apply) {
      if (value === model.getValue()) return;
      // Ace wins (reset, draft restore, edits made while Ace is shown): drop the pending push.
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      remote++;
      try {
        apply(() => setModelText(model, value));
      } finally {
        remote--;
      }
    },
    setActive(a) {
      active = a;
      if (!a && timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    dispose() {
      sub.dispose();
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('click', onClick, true);
    },
  };
}
