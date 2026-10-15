// Extension controls in the page's `.coding-toolbar`, kept OUTSIDE #button-container (the site
// hides that container on passed topics). Uses the site's Bootstrap + FontAwesome 6 classes; the
// few extension-specific styles live in src/content/content.css.

import type { ServerStatus, SlmStatus, ToBackground } from '../shared/protocol';

export interface Toolbar {
  setMode(useMonaco: boolean): void;
  setClangd(status: ServerStatus | 'starting', detail?: string): void;
  setSlm(status: SlmStatus, progress?: number, detail?: string): void;
  setSlmVisible(visible: boolean): void;
  dispose(): void;
}

export interface ToolbarOptions {
  onToggle: (useMonaco: boolean) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, attrs: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function icon(cls: string): HTMLElement {
  return el('i', cls, { 'aria-hidden': 'true' });
}

const CLANGD_LABEL: Record<ServerStatus | 'starting', string> = {
  starting: 'clangd: starting…',
  loading: 'clangd: loading…',
  ready: 'clangd: ready',
  error: 'clangd: error',
  stopped: 'clangd: stopped',
};

const SLM_LABEL: Record<SlmStatus, string> = {
  idle: 'AI: idle',
  downloading: 'AI: downloading',
  loading: 'AI: loading…',
  ready: 'AI: ready',
  error: 'AI: error',
};

export function createToolbar(opts: ToolbarOptions): Toolbar {
  const root = el('div', 'cal-ext-toolbar', { role: 'group', 'aria-label': 'CYCU CAL extension' });

  const toggle = el('button', 'btn btn-sm btn-outline-secondary cal-ext-btn', { type: 'button' });
  const toggleIcon = icon('fa-solid fa-code');
  const toggleText = el('span', 'cal-ext-btn-text');
  toggle.append(toggleIcon, toggleText);
  let useMonaco = true;
  toggle.addEventListener('click', (e) => {
    e.preventDefault();
    opts.onToggle(!useMonaco);
  });

  const gear = el('button', 'btn btn-sm btn-outline-secondary cal-ext-btn', {
    type: 'button',
    title: 'Extension settings',
    'aria-label': 'Extension settings',
  });
  gear.append(icon('fa-solid fa-gear'));
  gear.addEventListener('click', (e) => {
    e.preventDefault();
    const msg: ToBackground = { type: 'openOptions' };
    chrome.runtime.sendMessage(msg).catch(() => {
      /* background not ready */
    });
  });

  const clangd = el('span', 'badge rounded-pill cal-ext-pill', { 'data-state': 'starting' });
  const slm = el('span', 'badge rounded-pill cal-ext-pill', { 'data-state': 'idle' });
  slm.hidden = true;

  root.append(clangd, slm, toggle, gear);

  const bar = document.querySelector('.coding-toolbar');
  const buttons = bar?.querySelector('#button-container');
  if (bar && buttons && buttons.parentElement === bar) bar.insertBefore(root, buttons);
  else if (bar) bar.prepend(root);
  else document.getElementById('coding')?.prepend(root);

  const api: Toolbar = {
    setMode(m) {
      useMonaco = m;
      toggleText.textContent = m ? 'Monaco' : 'Ace';
      toggle.title = m ? 'Using Monaco editor — click to switch back to the site editor (Ace)' : 'Using the site editor (Ace) — click to switch to Monaco';
      toggle.setAttribute('aria-pressed', String(m));
      clangd.hidden = !m;
      slm.dataset.hiddenByMode = String(!m);
      slm.hidden = !m || slm.dataset.enabled !== 'true';
    },
    setClangd(status, detail) {
      clangd.dataset.state = status;
      clangd.textContent = CLANGD_LABEL[status] ?? `clangd: ${status}`;
      clangd.title = detail ?? '';
    },
    setSlm(status, progress, detail) {
      slm.dataset.state = status;
      // progress may be a 0..1 fraction or a 0..100 percentage
      const pct =
        status === 'downloading' && typeof progress === 'number'
          ? ` ${Math.round(progress <= 1 ? progress * 100 : progress)}%`
          : '';
      slm.textContent = SLM_LABEL[status] + pct;
      slm.title = detail ?? '';
    },
    setSlmVisible(v) {
      slm.dataset.enabled = String(v);
      slm.hidden = !v || slm.dataset.hiddenByMode === 'true';
    },
    dispose() {
      root.remove();
    },
  };
  api.setMode(true);
  api.setClangd('starting');
  api.setSlm('idle');
  return api;
}
