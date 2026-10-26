// ISOLATED-world content script, loaded by index.ts once the UI locale is set: mounts Monaco over
// the page's (hidden) Ace editor and wires the Ace bridge, lock guard, toolbar, question copy button,
// LSP and SLM features.
// If anything is off (no #editor, main-world reports `unavailable`, Monaco fails to mount) the page
// is left untouched.

import './content.css';
import { createAceSync, type AceSync } from './ace-sync';
import { createCopyQuestionButton } from './copy-question';
import { applyEditorSettings, createEditor, createModel, getEditorWorkerState, monaco } from '../editor/monaco-setup';
import { installLockGuard, isPositionLocked, type LockGuard } from '../editor/locks';
import { createToolbar, type Toolbar, type ToolbarVisibility } from '../editor/toolbar';
import { createVim, type VimController } from '../editor/vim';
import { startLanguageFeatures, type LanguageFeatures } from '../lsp/index';
import { startInlineCompletion, type InlineCompletion } from '../slm/inline-completion';
import {
  BRIDGE_TAG,
  type AceSnapshot,
  type BridgeEnvelope,
  type ContentToPage,
  type LockRange,
  type PageToContent,
} from '../shared/protocol';
import { onSettingsChanged, saveSettings, type Settings } from '../shared/settings';

const INIT_TIMEOUT_MS = 25_000;

const LOG = '[cycu-cal-ext]';

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

type Listener = (m: PageToContent) => void;
const listeners = new Set<Listener>();

window.addEventListener('message', (e) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const env = e.data as BridgeEnvelope<PageToContent> | undefined;
  if (!env || typeof env !== 'object' || env.tag !== BRIDGE_TAG || env.dir !== 'toContent') return;
  if (!env.msg || typeof env.msg.type !== 'string') return;
  for (const l of listeners) l(env.msg);
});

function toPage(msg: ContentToPage): void {
  const env: BridgeEnvelope<ContentToPage> = { tag: BRIDGE_TAG, dir: 'toPage', msg };
  window.postMessage(env, location.origin);
}

function waitForInit(): Promise<{ topicId: string; snapshot: AceSnapshot } | null> {
  return new Promise((resolve) => {
    const done = (v: { topicId: string; snapshot: AceSnapshot } | null) => {
      listeners.delete(l);
      clearInterval(hello);
      clearTimeout(timer);
      resolve(v);
    };
    const l: Listener = (m) => {
      if (m.type === 'init') done({ topicId: m.topicId, snapshot: m.snapshot });
      else if (m.type === 'unavailable') {
        console.info(LOG, 'Ace not available, leaving the page alone:', m.reason);
        done(null);
      }
    };
    listeners.add(l);
    toPage({ type: 'hello' });
    // MAIN-world may load after us; keep knocking until it answers.
    const hello = setInterval(() => toPage({ type: 'hello' }), 500);
    const timer = setTimeout(() => done(null), INIT_TIMEOUT_MS);
  });
}

// ---------------------------------------------------------------------------
// Monaco session
// ---------------------------------------------------------------------------

interface Session {
  host: HTMLElement;
  editor: monaco.editor.IStandaloneCodeEditor;
  model: monaco.editor.ITextModel;
  sync: AceSync;
  guard: LockGuard;
  vim: VimController;
  lsp: LanguageFeatures | null;
  slm: InlineCompletion | null;
  setReadOnly(ro: boolean): void;
  applySettings(s: Settings): void;
  show(visible: boolean): void;
}

function positionHost(host: HTMLElement, aceEl: HTMLElement, coding: HTMLElement): () => void {
  if (getComputedStyle(coding).position === 'static') coding.style.position = 'relative';
  const place = () => {
    const a = aceEl.getBoundingClientRect();
    const c = coding.getBoundingClientRect();
    host.style.top = `${a.top - c.top - coding.clientTop + coding.scrollTop}px`;
    host.style.left = `${a.left - c.left - coding.clientLeft + coding.scrollLeft}px`;
    host.style.width = `${a.width}px`;
    host.style.height = `${a.height}px`;
  };
  place();
  const ro = new ResizeObserver(place);
  ro.observe(aceEl);
  ro.observe(coding);
  window.addEventListener('resize', place);
  return place;
}

function mountSession(
  aceEl: HTMLElement,
  coding: HTMLElement,
  topicId: string,
  initialValue: string,
  state: { readOnly: boolean; locks: LockRange[] },
  settings: Settings,
  toolbar: Toolbar,
): Session {
  const host = document.createElement('div');
  host.className = 'cal-monaco-host';
  const editorEl = document.createElement('div');
  editorEl.className = 'cal-monaco-editor';
  const vimBar = document.createElement('div');
  vimBar.className = 'cal-vim-bar';
  vimBar.hidden = true;
  host.append(editorEl, vimBar);
  aceEl.after(host);
  const place = positionHost(host, aceEl, coding);

  const safeTopic = topicId.replace(/[^\w-]/g, '_') || 'topic';
  const rand = Math.random().toString(36).slice(2, 8);
  const model = createModel(initialValue, `file:///workspace/${safeTopic}-${rand}.c`);
  const ed = createEditor(editorEl, model, settings, state.readOnly);
  const sync = createAceSync(model);
  // Before the lock guard, so Vim sees keys first: in normal mode they are commands, not edits.
  const vim = createVim(ed, vimBar, () => sync.flush());
  const guard = installLockGuard(monaco, ed, state.locks, vim.isCommandMode);

  ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
    sync.flush();
    if (state.readOnly) return;
    const btn = document.getElementById('submitbtn') as HTMLButtonElement | null;
    if (btn && !btn.disabled) btn.click();
  });

  const s: Session = {
    host,
    editor: ed,
    model,
    sync,
    guard,
    vim,
    lsp: null,
    slm: null,
    setReadOnly(ro) {
      ed.updateOptions({ readOnly: ro });
      host.classList.toggle('cal-readonly', ro);
    },
    applySettings(st) {
      applyEditorSettings(ed, st);
      host.classList.toggle('cal-dark', st.theme === 'dark');
      vim.setEnabled(st.vimMode);
    },
    show(visible) {
      host.hidden = !visible;
      if (visible) {
        place();
        ed.layout();
      }
    },
  };
  s.setReadOnly(state.readOnly);
  s.applySettings(settings);

  try {
    s.lsp = startLanguageFeatures({
      monaco,
      editor: ed,
      model,
      topicId,
      settings,
      getLocks: () => guard.getLocks(),
      onStatus: (st, detail) => toolbar.setClangd(st, detail),
    });
  } catch (err) {
    console.error(LOG, 'language features failed to start', err);
    toolbar.setClangd('error', String(err));
  }
  try {
    s.slm = startInlineCompletion({
      monaco,
      editor: ed,
      model,
      settings,
      isSuppressed: (pos) => state.readOnly || vim.isCommandMode() || isPositionLocked(pos, guard.getLocks()),
      onStatus: (st, progress, detail) => toolbar.setSlm(st, progress, detail),
    });
  } catch (err) {
    console.error(LOG, 'inline completion failed to start', err);
    toolbar.setSlm('error', undefined, String(err));
  }
  return s;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function toolbarVisibility(s: Settings): ToolbarVisibility {
  return {
    clangd: s.showClangdBadge,
    slm: s.showSlmBadge && s.features.inlineCompletion,
    format: s.showFormatButton && s.features.formatting,
  };
}

export async function main(initialSettings: Settings): Promise<void> {
  const aceEl = document.getElementById('editor');
  const coding = document.getElementById('coding');
  if (!aceEl || !coding) return;

  let settings = initialSettings;
  const init = await waitForInit();
  if (!init) return;

  const state = {
    value: init.snapshot.value,
    readOnly: init.snapshot.readOnly,
    locks: init.snapshot.locks,
  };
  let session: Session | null = null;
  let useMonaco = false;

  const toolbar = createToolbar({
    onToggle: (m) => {
      setMode(m, true);
      saveSettings({ useMonaco: m }).catch((err) => console.warn(LOG, 'cannot save settings', err));
    },
    onFormat: () => {
      if (!session) return;
      session.editor.focus();
      session.editor
        .getAction('editor.action.formatDocument')
        ?.run()
        .catch((err) => console.warn(LOG, 'format failed', err));
    },
  });
  toolbar.setVisible(toolbarVisibility(settings));
  const copyButton = createCopyQuestionButton();
  copyButton?.setVisible(settings.showCopyButton);

  function setMode(m: boolean, userInitiated: boolean): void {
    if (m) {
      if (!session) {
        try {
          session = mountSession(aceEl!, coding!, init!.topicId, state.value, state, settings, toolbar);
        } catch (err) {
          console.error(LOG, 'Monaco failed to mount, keeping Ace', err);
          session = null;
          useMonaco = false;
          toolbar.setMode(false);
          return;
        }
      } else {
        session.sync.applyFromAce(state.value, (fn) => session!.guard.runUnguarded(fn));
      }
      useMonaco = true;
      session.sync.setActive(true);
      session.show(true);
      toPage({ type: 'showAce', show: false });
      if (userInitiated) session.editor.focus();
    } else {
      if (session) {
        session.sync.flush();
        session.sync.setActive(false);
        session.show(false);
      }
      useMonaco = false;
      toPage({ type: 'showAce', show: true });
      if (userInitiated) toPage({ type: 'focusAce' });
    }
    toolbar.setMode(useMonaco);
  }

  listeners.add((m) => {
    switch (m.type) {
      case 'aceChanged':
        state.value = m.value;
        if (session) session.sync.applyFromAce(m.value, (fn) => session!.guard.runUnguarded(fn));
        break;
      case 'readOnly':
        state.readOnly = m.readOnly;
        session?.setReadOnly(m.readOnly);
        break;
      case 'locks':
        state.locks = m.locks;
        session?.guard.setLocks(m.locks);
        break;
      case 'init': // MAIN world re-sent init (answer to a late hello): resync everything
        state.value = m.snapshot.value;
        state.readOnly = m.snapshot.readOnly;
        state.locks = m.snapshot.locks;
        if (session) {
          session.sync.applyFromAce(state.value, (fn) => session!.guard.runUnguarded(fn));
          session.setReadOnly(state.readOnly);
          session.guard.setLocks(state.locks);
        }
        break;
    }
  });

  onSettingsChanged((next) => {
    settings = next;
    if (next.useMonaco !== useMonaco) setMode(next.useMonaco, false);
    toolbar.setVisible(toolbarVisibility(next));
    copyButton?.setVisible(next.showCopyButton);
    if (session) {
      session.applySettings(next);
      try {
        session.lsp?.updateSettings(next);
      } catch (err) {
        console.error(LOG, 'language features updateSettings failed', err);
      }
      try {
        session.slm?.updateSettings(next);
      } catch (err) {
        console.error(LOG, 'inline completion updateSettings failed', err);
      }
    }
  });

  setMode(settings.useMonaco, false);

  // Debug handle for e2e tests; lives in the extension's isolated world only (invisible to the page).
  (globalThis as any).__calExt = {
    monaco,
    get session() {
      return session;
    },
    get useMonaco() {
      return useMonaco;
    },
    editorWorkerState: getEditorWorkerState,
  };
}
