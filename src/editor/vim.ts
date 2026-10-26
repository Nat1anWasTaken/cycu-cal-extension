// Vim keybindings (monaco-vim) with its mode line in `bar`, switched on and off live from settings.
//
// While Vim is in normal / visual mode, keys are commands rather than text, so the lock guard skips
// its key interception (`isCommandMode`) and relies on its content-change safety net instead.

import type * as Monaco from 'monaco-editor/editor/editor.api.js';
import { initVimMode, VimMode, type VimAdapterInstance } from 'monaco-vim';

export interface VimController {
  setEnabled(on: boolean): void;
  /** True while Vim is on and not in insert or replace mode. */
  isCommandMode(): boolean;
  dispose(): void;
}

/** `onWrite` runs for `:w`. */
export function createVim(
  ed: Monaco.editor.IStandaloneCodeEditor,
  bar: HTMLElement,
  onWrite: () => void,
): VimController {
  let adapter: VimAdapterInstance | null = null;
  let mode = 'normal';

  // CodeMirror's global save command; there is one editor per page.
  (VimMode as any).commands.save = onWrite;

  const api: VimController = {
    setEnabled(on) {
      if (on === !!adapter) return;
      if (on) {
        bar.hidden = false;
        mode = 'normal';
        adapter = initVimMode(ed, bar);
        adapter.on('vim-mode-change', (e: { mode: string }) => {
          mode = e.mode;
          // Vim takes Escape, so Monaco never gets to dismiss these itself.
          if (api.isCommandMode()) {
            ed.trigger('vim', 'hideSuggestWidget', null);
            ed.trigger('vim', 'editor.action.inlineSuggest.hide', null);
          }
        });
      } else {
        adapter!.dispose();
        adapter = null;
        bar.hidden = true;
      }
    },
    isCommandMode: () => !!adapter && mode !== 'insert' && mode !== 'replace',
    dispose() {
      api.setEnabled(false);
    },
  };
  return api;
}
