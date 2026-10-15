// Extension options page: feature toggles, editor look, SLM model and clangd compile flags.

import { SLM_MODELS, type SlmModelId } from '../shared/protocol';
import { DEFAULT_SETTINGS, FEATURE_LABELS, loadSettings, saveSettings, type FeatureId, type Settings } from '../shared/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const form = $<HTMLFormElement>('form');
const featuresEl = $<HTMLDivElement>('features');
const useMonaco = $<HTMLInputElement>('useMonaco');
const theme = $<HTMLSelectElement>('theme');
const minimap = $<HTMLInputElement>('minimap');
const slmModel = $<HTMLSelectElement>('slmModel');
const compileFlags = $<HTMLTextAreaElement>('compileFlags');
const statusEl = $<HTMLSpanElement>('status');

const featureIds = Object.keys(FEATURE_LABELS) as FeatureId[];
const boxes = new Map<FeatureId, HTMLInputElement>();

function sizeText(id: SlmModelId): string {
  const mb = SLM_MODELS[id].approxMB;
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`;
}

function confirmDownload(id: SlmModelId): boolean {
  const m = SLM_MODELS[id];
  return confirm(
    `Local AI completion downloads ${m.label} (about ${sizeText(id)}) from Hugging Face (${m.repo}).\n\n` +
      'It is cached in this browser and runs on your CPU. Continue?',
  );
}

function setStatus(text: string, error = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
}

function render(s: Settings): void {
  useMonaco.checked = s.useMonaco;
  theme.value = s.theme;
  minimap.checked = s.minimap;
  slmModel.value = s.slmModel;
  compileFlags.value = s.compileFlags.join('\n');
  for (const id of featureIds) boxes.get(id)!.checked = s.features[id];
}

function read(): Partial<Settings> {
  const features = {} as Record<FeatureId, boolean>;
  for (const id of featureIds) features[id] = boxes.get(id)!.checked;
  return {
    useMonaco: useMonaco.checked,
    theme: theme.value === 'dark' ? 'dark' : 'light',
    minimap: minimap.checked,
    slmModel: slmModel.value as SlmModelId,
    compileFlags: compileFlags.value.split('\n').map((l) => l.trim()).filter(Boolean),
    features,
  };
}

// Build controls.
for (const id of featureIds) {
  const label = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.id = `feature-${id}`;
  box.dataset.feature = id;
  label.append(box, ` ${FEATURE_LABELS[id]}`);
  featuresEl.append(label);
  boxes.set(id, box);
}
for (const [id, m] of Object.entries(SLM_MODELS) as Array<[SlmModelId, (typeof SLM_MODELS)[SlmModelId]]>) {
  slmModel.append(new Option(`${m.label} – ~${sizeText(id)}`, id));
}

// Enabling inline completion (or switching to another model while enabled) downloads weights: ask first.
const slmBox = boxes.get('inlineCompletion')!;
slmBox.addEventListener('change', () => {
  if (slmBox.checked && !confirmDownload(slmModel.value as SlmModelId)) slmBox.checked = false;
});
let lastModel = slmModel.value;
slmModel.addEventListener('focus', () => (lastModel = slmModel.value));
slmModel.addEventListener('change', () => {
  if (slmBox.checked && !confirmDownload(slmModel.value as SlmModelId)) slmModel.value = lastModel;
  lastModel = slmModel.value;
});

$<HTMLButtonElement>('resetFlags').addEventListener('click', () => {
  compileFlags.value = DEFAULT_SETTINGS.compileFlags.join('\n');
});

form.addEventListener('input', () => setStatus('Unsaved changes'));
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    render(await saveSettings(read()));
    setStatus('Saved');
  } catch (err) {
    setStatus(`Save failed: ${err instanceof Error ? err.message : String(err)}`, true);
  }
});

loadSettings()
  .then((s) => {
    render(s);
    lastModel = slmModel.value;
  })
  .catch((err) => setStatus(`Could not load settings: ${err}`, true));
