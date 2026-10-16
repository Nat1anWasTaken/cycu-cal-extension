// Extension options page: feature toggles, editor look, toolbar controls, SLM model and clangd compile flags.
// Every change is saved immediately; the toast in #status confirms it.

import { isBundled } from '../shared/bundle';
import { SLM_CONTEXT_SIZES, SLM_MODELS, type SlmContextTokens, type SlmModelId } from '../shared/protocol';
import {
  DEFAULT_SETTINGS,
  FEATURE_LABELS,
  loadSettings,
  saveSettings,
  type FeatureId,
  type Settings,
} from '../shared/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const form = $<HTMLFormElement>('form');
const featuresEl = $<HTMLElement>('features');
const useMonaco = $<HTMLInputElement>('useMonaco');
const minimap = $<HTMLInputElement>('minimap');
const fontFamily = $<HTMLInputElement>('fontFamily');
const showClangdBadge = $<HTMLInputElement>('showClangdBadge');
const showSlmBadge = $<HTMLInputElement>('showSlmBadge');
const showFormatButton = $<HTMLInputElement>('showFormatButton');
const slmModel = $<HTMLDivElement>('slmModel');
const slmContext = $<HTMLSpanElement>('slmContext');
const compileFlags = $<HTMLTextAreaElement>('compileFlags');
const statusEl = $<HTMLDivElement>('status');

const FEATURE_HINTS: Record<FeatureId, string> = {
  diagnostics: '邊打字邊標出錯誤和警告，並提供一鍵修正',
  completion: '打字時跳出變數、函式名稱等建議',
  hover: '滑鼠移到程式碼上，顯示它的型別和說明',
  signatureHelp: '呼叫函式時，提示該填哪些參數',
  formatting: '自動整理整份或選取部分程式碼的縮排與空白',
  definition: '跳到變數或函式定義的位置，或找出所有用到它的地方',
  highlightRename: '標示同一個名稱出現的所有位置，並可一次全部改名',
  outline: '快速列出所有函式和變數（Ctrl/Cmd+Shift+O）',
  folding: '把程式區塊或註解收合起來，讓畫面更清爽',
  inlayHints: '在程式碼中直接顯示參數名稱和型別',
  semanticTokens: '依照用途（變數、函式、型別等）為程式碼上色',
  documentLinks: '按住 Ctrl/Cmd 點擊 #include，查看標頭檔內容',
  inlineCompletion: '以灰色文字預先顯示 AI 建議的程式碼，按 Tab 接受',
};

const featureIds = Object.keys(FEATURE_LABELS) as FeatureId[];
const boxes = new Map<FeatureId, HTMLInputElement>();
const modelIds = Object.keys(SLM_MODELS) as SlmModelId[];
const radios = new Map<SlmModelId, HTMLInputElement>();

function sizeText(id: SlmModelId): string {
  const mb = SLM_MODELS[id].approxMB;
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`;
}

function confirmDownload(id: SlmModelId): boolean {
  if (isBundled(id)) return true;
  const m = SLM_MODELS[id];
  return confirm(
    `本機 AI 自動補全需要從 Hugging Face（${m.repo}）下載 ${m.label}，大小約 ${sizeText(id)}。\n\n` +
      '下載後會存在這個瀏覽器中，並在你的電腦上執行。要繼續嗎？',
  );
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function setStatus(text: string, error = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
  statusEl.classList.add('show');
  clearTimeout(toastTimer);
  if (!error) toastTimer = setTimeout(() => statusEl.classList.remove('show'), 1600);
}

const selectedModel = (): SlmModelId => modelIds.find((id) => radios.get(id)!.checked) ?? DEFAULT_SETTINGS.slmModel;

function syncModelState(): void {
  slmModel.classList.toggle('off', !boxes.get('inlineCompletion')!.checked);
}

function render(s: Settings): void {
  useMonaco.checked = s.useMonaco;
  $<HTMLInputElement>(`theme-${s.theme}`).checked = true;
  minimap.checked = s.minimap;
  if (document.activeElement !== fontFamily) fontFamily.value = s.fontFamily;
  showClangdBadge.checked = s.showClangdBadge;
  showSlmBadge.checked = s.showSlmBadge;
  showFormatButton.checked = s.showFormatButton;
  radios.get(s.slmModel)!.checked = true;
  $<HTMLInputElement>(`slmContext-${s.slmContextTokens}`).checked = true;
  if (document.activeElement !== compileFlags) compileFlags.value = s.compileFlags.join('\n');
  for (const id of featureIds) boxes.get(id)!.checked = s.features[id];
  syncModelState();
}

function read(): Partial<Settings> {
  const features = {} as Record<FeatureId, boolean>;
  for (const id of featureIds) features[id] = boxes.get(id)!.checked;
  return {
    useMonaco: useMonaco.checked,
    theme: $<HTMLInputElement>('theme-dark').checked ? 'dark' : 'light',
    minimap: minimap.checked,
    fontFamily: fontFamily.value.trim(),
    showClangdBadge: showClangdBadge.checked,
    showSlmBadge: showSlmBadge.checked,
    showFormatButton: showFormatButton.checked,
    slmModel: selectedModel(),
    slmContextTokens: Number(
      slmContext.querySelector<HTMLInputElement>('input:checked')?.value ?? DEFAULT_SETTINGS.slmContextTokens,
    ) as SlmContextTokens,
    compileFlags: compileFlags.value
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
    features,
  };
}

async function save(): Promise<void> {
  try {
    render(await saveSettings(read()));
    setStatus('已儲存');
  } catch (err) {
    setStatus(`儲存失敗：${err instanceof Error ? err.message : String(err)}`, true);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// Build controls. Inline completion lives in the AI section, next to its model picker.
for (const id of featureIds) {
  const row = el('label', 'row');
  const text = el('span', 'text');
  text.append(el('span', 'title', FEATURE_LABELS[id]), el('span', 'desc', FEATURE_HINTS[id]));
  const box = el('input', 'switch');
  box.type = 'checkbox';
  box.id = `feature-${id}`;
  box.dataset.feature = id;
  row.append(text, box);
  (id === 'inlineCompletion' ? $('slmToggle') : featuresEl).append(row);
  boxes.set(id, box);
}
for (const id of modelIds) {
  const m = SLM_MODELS[id];
  const [name, quant] = m.label.split(/ (?=\()/);
  const row = el('label', 'model');
  const radio = el('input', '');
  radio.type = 'radio';
  radio.name = 'slmModel';
  radio.value = id;
  const title = el('span', 'name', name);
  if (quant) title.append(el('span', 'quant', quant));
  const badge = isBundled(id)
    ? el('span', 'badge included', `已內建 · ${sizeText(id)}`)
    : el('span', 'badge', `需下載 ${sizeText(id)}`);
  row.append(radio, title, badge);
  slmModel.append(row);
  radios.set(id, radio);
}
for (const size of SLM_CONTEXT_SIZES) {
  const radio = el('input', '');
  radio.type = 'radio';
  radio.name = 'slmContext';
  radio.id = `slmContext-${size}`;
  radio.value = String(size);
  const label = el('label', '', `${size / 1024}K`);
  label.htmlFor = radio.id;
  slmContext.append(radio, label);
}
try {
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;
} catch {
  /* not running as an extension page */
}

// Enabling inline completion (or switching to another model while enabled) downloads weights: ask first.
const slmBox = boxes.get('inlineCompletion')!;
let lastModel = DEFAULT_SETTINGS.slmModel;
form.addEventListener('change', (e) => {
  const t = e.target;
  if (t === compileFlags || t === fontFamily) return; // saved while typing
  if (t === slmBox && slmBox.checked && !confirmDownload(selectedModel())) slmBox.checked = false;
  if (t instanceof HTMLInputElement && t.name === 'slmModel') {
    if (slmBox.checked && !confirmDownload(selectedModel())) radios.get(lastModel)!.checked = true;
    lastModel = selectedModel();
  }
  syncModelState();
  void save();
});

let typingTimer: ReturnType<typeof setTimeout> | undefined;
for (const field of [compileFlags, fontFamily]) {
  field.addEventListener('input', () => {
    clearTimeout(typingTimer);
    typingTimer = setTimeout(save, 600);
  });
}

$<HTMLButtonElement>('resetFlags').addEventListener('click', () => {
  compileFlags.value = DEFAULT_SETTINGS.compileFlags.join('\n');
  void save();
});

loadSettings()
  .then((s) => {
    render(s);
    lastModel = s.slmModel;
  })
  .catch((err) => setStatus(`無法載入設定：${err}`, true));
