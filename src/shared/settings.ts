// User settings, persisted in chrome.storage.sync and shared by the content script and options page.

import { BUNDLED_MODELS } from './bundle';
import { LOCALES, type LanguageSetting } from './i18n';
import { SLM_CONTEXT_SIZES, type SlmContextTokens, type SlmModelId } from './protocol';

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

export interface Settings {
  /** UI language; 'auto' follows the browser. Open pages pick up a change on reload. */
  language: LanguageSetting;
  /** Show Monaco instead of the site's Ace editor. */
  useMonaco: boolean;
  features: Record<FeatureId, boolean>;
  compileFlags: string[];
  theme: 'light' | 'dark';
  minimap: boolean;
  /** CSS font-family list for the editor; empty uses the site's monospace font. */
  fontFamily: string;
  /** Vim keybindings in Monaco, with a mode line under the editor. */
  vimMode: boolean;
  /** Show the clangd status badge in the page toolbar. */
  showClangdBadge: boolean;
  /** Show the local AI status badge in the page toolbar (only while inline completion is on). */
  showSlmBadge: boolean;
  /** Show a "Format" button in the page toolbar (only while formatting is on). */
  showFormatButton: boolean;
  /** Show a "Copy" button at the top right of the question that copies it as Markdown. */
  showCopyButton: boolean;
  slmModel: SlmModelId;
  /** Prompt budget for local AI completion; larger fits more code but responds slower. */
  slmContextTokens: SlmContextTokens;
}

export const DEFAULT_SETTINGS: Settings = {
  language: 'auto',
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
  fontFamily: '',
  vimMode: false,
  showClangdBadge: true,
  showSlmBadge: true,
  showFormatButton: true,
  showCopyButton: true,
  // An offline build defaults to the model it ships with.
  slmModel: BUNDLED_MODELS[0] ?? 'qwen2.5-coder-0.5b',
  slmContextTokens: 1536,
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
  const s: Settings = {
    ...DEFAULT_SETTINGS,
    ...raw,
    features: { ...DEFAULT_SETTINGS.features, ...raw?.features },
  };
  if (s.language !== 'auto' && !(s.language in LOCALES)) s.language = DEFAULT_SETTINGS.language;
  if (!SLM_CONTEXT_SIZES.includes(s.slmContextTokens)) s.slmContextTokens = DEFAULT_SETTINGS.slmContextTokens;
  return s;
}
