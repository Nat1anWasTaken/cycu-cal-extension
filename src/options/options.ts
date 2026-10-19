// Extension options page: feature toggles, editor look, page buttons, SLM model and clangd compile flags.
// Every change is saved immediately; the toast in #status confirms it.

import { isBundled } from '../shared/bundle';
import { getLocale, localeFor, setLocale, t, type LanguageSetting, type MessageKey } from '../shared/i18n';
import { SLM_CONTEXT_SIZES, SLM_MODELS, type SlmContextTokens, type SlmModelId } from '../shared/protocol';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type FeatureId, type Settings } from '../shared/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const form = $<HTMLFormElement>('form');
const featuresEl = $<HTMLElement>('features');
const useMonaco = $<HTMLInputElement>('useMonaco');
const minimap = $<HTMLInputElement>('minimap');
const fontFamily = $<HTMLInputElement>('fontFamily');
const showClangdBadge = $<HTMLInputElement>('showClangdBadge');
const showSlmBadge = $<HTMLInputElement>('showSlmBadge');
const showFormatButton = $<HTMLInputElement>('showFormatButton');
const showCopyButton = $<HTMLInputElement>('showCopyButton');
const slmModel = $<HTMLDivElement>('slmModel');
const slmContext = $<HTMLSpanElement>('slmContext');
const compileFlags = $<HTMLTextAreaElement>('compileFlags');
const statusEl = $<HTMLDivElement>('status');

const featureIds = Object.keys(DEFAULT_SETTINGS.features) as FeatureId[];
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
  return confirm(t('options.slmConfirm', m.label, sizeText(id), m.repo));
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
  $<HTMLInputElement>(`language-${s.language}`).checked = true;
  useMonaco.checked = s.useMonaco;
  $<HTMLInputElement>(`theme-${s.theme}`).checked = true;
  minimap.checked = s.minimap;
  if (document.activeElement !== fontFamily) fontFamily.value = s.fontFamily;
  showClangdBadge.checked = s.showClangdBadge;
  showSlmBadge.checked = s.showSlmBadge;
  showFormatButton.checked = s.showFormatButton;
  showCopyButton.checked = s.showCopyButton;
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
    language: (form.querySelector<HTMLInputElement>('input[name=language]:checked')?.value ??
      DEFAULT_SETTINGS.language) as LanguageSetting,
    useMonaco: useMonaco.checked,
    theme: $<HTMLInputElement>('theme-dark').checked ? 'dark' : 'light',
    minimap: minimap.checked,
    fontFamily: fontFamily.value.trim(),
    showClangdBadge: showClangdBadge.checked,
    showSlmBadge: showSlmBadge.checked,
    showFormatButton: showFormatButton.checked,
    showCopyButton: showCopyButton.checked,
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
    setStatus(t('options.saved'));
  } catch (err) {
    setStatus(t('options.saveFailed', err instanceof Error ? err.message : String(err)), true);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// Settings pick the UI language, so load them before rendering any text.
let initial = DEFAULT_SETTINGS;
let loadError: unknown;
try {
  initial = await loadSettings();
} catch (err) {
  loadError = err;
}
setLocale(localeFor(initial.language));

// Static text: data-i18n sets an element's text, data-i18n-<attr> one of its attributes. A {name} in the message is
// replaced with the element's [data-i18n-slot=name] child, which keeps its markup.
document.documentElement.lang = getLocale();
for (const e of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
  const slots = new Map([...e.querySelectorAll<HTMLElement>('[data-i18n-slot]')].map((c) => [c.dataset.i18nSlot, c]));
  e.replaceChildren(
    ...t(e.dataset.i18n as MessageKey)
      .split(/(\{\w+\})/)
      .map((part) => slots.get(part.slice(1, -1)) ?? part),
  );
}
for (const e of document.querySelectorAll<HTMLElement>('[data-i18n-aria-label], [data-i18n-placeholder]')) {
  for (const attr of ['aria-label', 'placeholder']) {
    const key = e.getAttribute(`data-i18n-${attr}`);
    if (key) e.setAttribute(attr, t(key as MessageKey));
  }
}

// Build controls. Inline completion lives in the AI section, next to its model picker.
for (const id of featureIds) {
  const row = el('label', 'row');
  const text = el('span', 'text');
  text.append(el('span', 'title', t(`feature.${id}`)), el('span', 'desc', t(`featureHint.${id}`)));
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
    ? el('span', 'badge included', t('options.slmIncluded', sizeText(id)))
    : el('span', 'badge', t('options.slmDownload', sizeText(id)));
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
let lastModel = initial.slmModel;
form.addEventListener('change', (e) => {
  const target = e.target;
  if (target === compileFlags || target === fontFamily) return; // saved while typing
  if (target === slmBox && slmBox.checked && !confirmDownload(selectedModel())) slmBox.checked = false;
  if (target instanceof HTMLInputElement && target.name === 'slmModel') {
    if (slmBox.checked && !confirmDownload(selectedModel())) radios.get(lastModel)!.checked = true;
    lastModel = selectedModel();
  }
  syncModelState();
  // A new language re-renders the page in it.
  if (target instanceof HTMLInputElement && target.name === 'language') void save().then(() => location.reload());
  else void save();
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

render(initial);
if (loadError) setStatus(t('options.loadFailed', String(loadError)), true);
