// User settings, persisted in chrome.storage.sync and shared by the content script and options page.

import type { SlmModelId } from './protocol';

export type FeatureId =
  | 'diagnostics'
  | 'completion'
  | 'hover'
  | 'signatureHelp'
  | 'formatting'
  | 'definition'
  | 'highlightRename'
  | 'outline'
  | 'folding'
  | 'inlayHints'
  | 'semanticTokens'
  | 'documentLinks'
  | 'inlineCompletion';

export const FEATURE_LABELS: Record<FeatureId, string> = {
  diagnostics: 'Diagnostics & quick fixes',
  completion: 'Code completion',
  hover: 'Hover information',
  signatureHelp: 'Signature help',
  formatting: 'Formatting (clang-format)',
  definition: 'Go to definition / references',
  highlightRename: 'Symbol highlight & rename',
  outline: 'Document outline',
  folding: 'Folding ranges',
  inlayHints: 'Inlay hints',
  semanticTokens: 'Semantic highlighting',
  documentLinks: '#include links',
  inlineCompletion: 'Local AI ghost-text completion (downloads a model)',
};

export interface Settings {
  /** Show Monaco instead of the site's Ace editor. */
  useMonaco: boolean;
  features: Record<FeatureId, boolean>;
  compileFlags: string[];
  theme: 'light' | 'dark';
  minimap: boolean;
  slmModel: SlmModelId;
}

export const DEFAULT_SETTINGS: Settings = {
  useMonaco: true,
  features: {
    diagnostics: true,
    completion: true,
    hover: true,
    signatureHelp: true,
    formatting: true,
    definition: true,
    highlightRename: true,
    outline: true,
    folding: true,
    inlayHints: true,
    semanticTokens: true,
    documentLinks: true,
    inlineCompletion: false,
  },
  compileFlags: ['-xc', '-std=gnu11', '-Wall', '-Wextra'],
  theme: 'light',
  minimap: false,
  slmModel: 'qwen2.5-coder-0.5b',
};

const KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const raw = (await chrome.storage.sync.get(KEY))[KEY] as Partial<Settings> | undefined;
  return mergeSettings(raw);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = mergeSettings({ ...(await loadSettings()), ...patch });
  await chrome.storage.sync.set({ [KEY]: next });
  return next;
}

/** Calls `cb` whenever settings change in any context. Returns an unsubscribe function. */
export function onSettingsChanged(cb: (s: Settings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'sync' && KEY in changes) cb(mergeSettings(changes[KEY].newValue as Partial<Settings>));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

function mergeSettings(raw: Partial<Settings> | undefined): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    features: { ...DEFAULT_SETTINGS.features, ...raw?.features },
  };
}
