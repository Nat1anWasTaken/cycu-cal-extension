// Extension controls in the page's `.coding-toolbar`, kept OUTSIDE #button-container (the site
// hides that container on passed topics). Uses the site's Bootstrap + FontAwesome 6 classes; the
// few extension-specific styles live in src/content/content.css.

import type { ServerStatus, SlmStatus, ToBackground } from '../shared/protocol';

export interface Toolbar {
  setMode(useMonaco: boolean): void;
  setClangd(status: ServerStatus | 'starting', detail?: string): void;
  setSlm(status: SlmStatus, progress?: number, detail?: string): void;
  /** Which badges/buttons the user wants; each still hides while Ace is active. */
  setVisible(show: ToolbarVisibility): void;
  dispose(): void;
}

export interface ToolbarVisibility {
  clangd: boolean;
  slm: boolean;
  format: boolean;
}

export interface ToolbarOptions {
  onToggle: (useMonaco: boolean) => void;
  onFormat: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  attrs: Record<string, string> = {},
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function icon(cls: string): HTMLElement {
  return el('i', cls, { 'aria-hidden': 'true' });
}

const CLANGD_LABEL: Record<ServerStatus | 'starting', string> = {
  starting: '程式分析：啟動中…',
  loading: '程式分析：載入中…',
  ready: '程式分析：就緒',
  error: '程式分析：發生錯誤',
  stopped: '程式分析：已停止',
};

const SLM_LABEL: Record<SlmStatus, string> = {
  idle: 'AI：待命',
  downloading: 'AI：下載中',
  loading: 'AI：載入中…',
  ready: 'AI：就緒',
  error: 'AI：發生錯誤',
};

export function createToolbar(opts: ToolbarOptions): Toolbar {
  const root = el('div', 'cal-ext-toolbar', { role: 'group', 'aria-label': 'CYCU CAL 擴充功能' });

  const toggle = el('button', 'btn btn-sm btn-outline-secondary cal-ext-btn cal-ext-toggle', { type: 'button' });
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
    title: '擴充功能設定',
    'aria-label': '擴充功能設定',
  });
  gear.append(icon('fa-solid fa-gear'));
  gear.addEventListener('click', (e) => {
    e.preventDefault();
    const msg: ToBackground = { type: 'openOptions' };
    chrome.runtime.sendMessage(msg).catch(() => {
      /* background not ready */
    });
  });

  const format = el('button', 'btn btn-sm btn-outline-secondary cal-ext-btn', {
    type: 'button',
    title: '自動整理程式碼的縮排與空白（Shift+Alt+F）',
  });
  format.append(
    icon('fa-solid fa-wand-magic-sparkles'),
    Object.assign(el('span', 'cal-ext-btn-text'), { textContent: '排版' }),
  );
  format.addEventListener('click', (e) => {
    e.preventDefault();
    opts.onFormat();
  });

  const clangd = el('span', 'badge rounded-pill cal-ext-pill', { 'data-state': 'starting' });
  const slm = el('span', 'badge rounded-pill cal-ext-pill', { 'data-state': 'idle' });
  let visible: ToolbarVisibility = { clangd: true, slm: false, format: false };
  const syncVisible = () => {
    clangd.hidden = !useMonaco || !visible.clangd;
    slm.hidden = !useMonaco || !visible.slm;
    format.hidden = !useMonaco || !visible.format;
  };

  root.append(clangd, slm, format, toggle, gear);

  const bar = document.querySelector('.coding-toolbar');
  const buttons = bar?.querySelector('#button-container');
  if (bar && buttons && buttons.parentElement === bar) bar.insertBefore(root, buttons);
  else if (bar) bar.prepend(root);
  else document.getElementById('coding')?.prepend(root);

  const api: Toolbar = {
    setMode(m) {
      useMonaco = m;
      toggleText.textContent = m ? '新版編輯器' : '原版編輯器';
      toggle.title = m
        ? '目前使用新版編輯器（Monaco）— 點擊切換回網站原本的編輯器（Ace）'
        : '目前使用網站原本的編輯器（Ace）— 點擊切換到新版編輯器（Monaco）';
      toggle.setAttribute('aria-pressed', String(m));
      syncVisible();
    },
    setClangd(status, detail) {
      clangd.dataset.state = status;
      clangd.textContent = CLANGD_LABEL[status] ?? `程式分析：${status}`;
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
    setVisible(show) {
      visible = { ...show };
      syncVisible();
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
