// Message contracts shared by every context of the extension.
//
//   page (MAIN world)  ⇄ window.postMessage ⇄  content script (ISOLATED world)
//   content script     ⇄ chrome.runtime Port ⇄ offscreen document (clangd / SLM workers)
//   content script     → chrome.runtime.sendMessage → background service worker

// ---------------------------------------------------------------------------
// MAIN world ⇄ ISOLATED world bridge (window.postMessage)
// ---------------------------------------------------------------------------

export const BRIDGE_TAG = '__cycu_cal_ext__';

/** 0-indexed Ace position. */
export interface AcePos {
  row: number;
  column: number;
}

/** A locked region copied from the page's `arr2` / `arrE` globals. */
export interface LockRange {
  start: AcePos;
  end: AcePos;
}

export interface AceSnapshot {
  value: string;
  readOnly: boolean;
  locks: LockRange[];
  tabSize: number;
  useSoftTabs: boolean;
}

/** MAIN → ISOLATED */
export type PageToContent =
  | { type: 'init'; topicId: string; snapshot: AceSnapshot }
  | { type: 'aceChanged'; value: string }
  | { type: 'readOnly'; readOnly: boolean }
  | { type: 'locks'; locks: LockRange[] }
  | { type: 'unavailable'; reason: string };

/** ISOLATED → MAIN */
export type ContentToPage =
  { type: 'hello' } | { type: 'setValue'; value: string } | { type: 'showAce'; show: boolean } | { type: 'focusAce' };

export interface BridgeEnvelope<T> {
  tag: typeof BRIDGE_TAG;
  dir: 'toContent' | 'toPage';
  msg: T;
}

/**
 * SYNCHRONOUS ISOLATED → MAIN text push. postMessage is async, but the page's RUN handler
 * reads Ace's `editor.getValue()` in the same task as the click, so before RUN (capture-phase
 * click on #submitbtn, Cmd/Ctrl-Enter) and for the debounced Monaco → Ace sync, the content
 * script dispatches `new CustomEvent(FLUSH_EVENT, { detail: <full text> })` on `document`.
 * DOM events dispatch synchronously across worlds, so main-world applies it to Ace
 * (echo-suppressed, only if different) before dispatchEvent() returns. `detail` must be a string.
 */
export const FLUSH_EVENT = '__cycu_cal_ext_flush__';

// ---------------------------------------------------------------------------
// Content script → background (one-shot messages)
// ---------------------------------------------------------------------------

export type ToBackground = { type: 'ensureOffscreen' } | { type: 'openOptions' };

export interface EnsureOffscreenResponse {
  ok: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Content script ⇄ offscreen (long-lived Ports)
// ---------------------------------------------------------------------------

export const LSP_PORT = 'cal-lsp';
export const SLM_PORT = 'cal-slm';

/** First message a content script sends on an LSP port. */
export interface LspHello {
  type: 'hello';
  /** compile_flags.txt content, one flag per line. */
  compileFlags: string[];
}

/** Port messages content → offscreen on LSP_PORT. */
export type LspPortIn = LspHello | { type: 'rpc'; message: unknown };

/** Port messages offscreen → content on LSP_PORT. */
export type LspPortOut = { type: 'status'; status: ServerStatus; detail?: string } | { type: 'rpc'; message: unknown };

export type ServerStatus = 'loading' | 'ready' | 'error' | 'stopped';

/**
 * Custom LSP request served by the offscreen host (not clangd): read a file from
 * clangd's virtual FS, e.g. a system header for document links / go-to-definition.
 */
export const READ_FILE_METHOD = 'cal/readFile';
export interface ReadFileParams {
  uri: string;
}
export interface ReadFileResult {
  text: string | null;
}

/** Port messages content → offscreen on SLM_PORT. */
export type SlmPortIn =
  | { type: 'load'; modelId: SlmModelId; contextTokens: SlmContextTokens }
  | { type: 'complete'; id: number; prefix: string; suffix: string; maxTokens: number }
  | { type: 'cancel'; id: number };

/** Port messages offscreen → content on SLM_PORT. */
export type SlmPortOut =
  | { type: 'status'; status: SlmStatus; progress?: number; detail?: string }
  | { type: 'completion'; id: number; text: string }
  | { type: 'completionError'; id: number; error: string };

export type SlmStatus = 'idle' | 'downloading' | 'loading' | 'ready' | 'error';

export type SlmModelId = 'qwen2.5-coder-0.5b' | 'qwen2.5-coder-1.5b';

/** Prompt budgets (editor code, in estimated tokens) offered in the options page. */
export const SLM_CONTEXT_SIZES = [1536, 3072, 6144] as const;
export type SlmContextTokens = (typeof SLM_CONTEXT_SIZES)[number];

export interface SlmModel {
  label: string;
  repo: string;
  /** Pinned commit of `repo`, so upstream edits can't swap the weights. */
  revision: string;
  file: string;
  /** SHA-256 of `file` (Hugging Face's LFS etag); checked when the model is bundled at build time. */
  sha256: string;
  approxMB: number;
}

export const SLM_MODELS: Record<SlmModelId, SlmModel> = {
  'qwen2.5-coder-0.5b': {
    label: 'Qwen2.5-Coder 0.5B (Q4_K_M)',
    repo: 'bartowski/Qwen2.5-Coder-0.5B-GGUF',
    revision: '01c1b8072277dfbfd0d051ec95b7a43bb23d2f6a',
    file: 'Qwen2.5-Coder-0.5B-Q4_K_M.gguf',
    sha256: 'fefe9d34df79d3ad3db33519d81112be76096626a5fdb87a98092035dc79ad68',
    approxMB: 400,
  },
  'qwen2.5-coder-1.5b': {
    label: 'Qwen2.5-Coder 1.5B (Q4_K_M)',
    repo: 'QuantFactory/Qwen2.5-Coder-1.5B-GGUF',
    revision: '73c3c696087d8d57a3005e31f2afe78f43059739',
    file: 'Qwen2.5-Coder-1.5B.Q4_K_M.gguf',
    sha256: 'a9ccb6be802412e61e1acbee6287a23b11e56e94718560f910075c64b6194910',
    approxMB: 990,
  },
};

/** Models with an offline build (`pnpm package:offline-<size>`); the first is what a bare `--offline` bundles. */
export const OFFLINE_MODELS: readonly SlmModelId[] = ['qwen2.5-coder-0.5b', 'qwen2.5-coder-1.5b'];

/** Short name used in offline package file names, e.g. "1.5b" for qwen2.5-coder-1.5b. */
export const modelSize = (id: SlmModelId): string => id.slice(id.lastIndexOf('-') + 1);

export function modelUrl(id: SlmModelId): string {
  const m = SLM_MODELS[id];
  return `https://huggingface.co/${m.repo}/resolve/${m.revision}/${m.file}`;
}

/** Path of a bundled model, relative to vendor/ at build time and to the extension root at run time. */
export function bundledModelPath(id: SlmModelId): string {
  return `models/${SLM_MODELS[id].file}`;
}
