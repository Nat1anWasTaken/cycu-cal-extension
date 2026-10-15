// Extension options page: feature toggles, editor look, toolbar badges, SLM model and clangd compile flags.
// Every change is saved immediately; the toast in #status confirms it.

import { isBundled } from '../shared/bundle';
import { SLM_MODELS, type SlmModelId } from '../shared/protocol';
import { DEFAULT_SETTINGS, FEATURE_LABELS, loadSettings, saveSettings, type FeatureId, type Settings } from '../shared/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const form = $<HTMLFormElement>('form');
const featuresEl = $<HTMLElement>('features');
const useMonaco = $<HTMLInputElement>('useMonaco');
const minimap = $<HTMLInputElement>('minimap');
const fontFamily = $<HTMLInputElement>('fontFamily');
const showClangdBadge = $<HTMLInputElement>('showClangdBadge');
const showSlmBadge = $<HTMLInputElement>('showSlmBadge');
const slmModel = $<HTMLDivElement>('slmModel');
const compileFlags = $<HTMLTextAreaElement>('compileFlags');
const statusEl = $<HTMLDivElement>('status');

const FEATURE_HINTS: Record<FeatureId, string> = {
  diagnostics: 'Errors and warnings as you type',
  completion: 'Suggestions for names and members',
  hover: 'Types and docs under the cursor',
  signatureHelp: 'Parameter hints inside calls',
  formatting: 'Format the document or a selection',
  definition: 'Jump to declarations and usages',
  highlightRename: 'Highlight and rename symbols',
  outline: 'Quick outline (Ctrl/Cmd-Shift-O)',
  folding: 'Collapse blocks and comments',
  inlayHints: 'Inline parameter names and types',
  semanticTokens: 'Color by meaning, not just syntax',
  documentLinks: 'Ctrl/Cmd-click to peek at a header',
  inlineCompletion: 'Gray ghost-text suggestions; press Tab to accept',
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
    `Local AI completion downloads ${m.label} (about ${sizeText(id)}) from Hugging Face (${m.repo}).\n\n` +
      'It is cached in this browser and runs on your CPU. Continue?',
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
  radios.get(s.slmModel)!.checked = true;
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
    slmModel: selectedModel(),
    compileFlags: compileFlags.value.split('\n').map((l) => l.trim()).filter(Boolean),
    features,
  };
}

async function save(): Promise<void> {
  try {
    render(await saveSettings(read()));
    setStatus('Saved');
  } catch (err) {
    setStatus(`Save failed: ${err instanceof Error ? err.message : String(err)}`, true);
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
  const badge = isBundled(id) ? el('span', 'badge included', `Included · ${sizeText(id)}`) : el('span', 'badge', `${sizeText(id)} download`);
  row.append(radio, title, badge);
  slmModel.append(row);
  radios.set(id, radio);
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
  .catch((err) => setStatus(`Could not load settings: ${err}`, true));
