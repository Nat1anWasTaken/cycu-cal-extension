/// <reference lib="webworker" />
// Module worker running clangd (Emscripten, pthreads + Asyncify) with LSP over stdin/stdout.
// Loaded from the extension root at runtime: build.mjs copies clangd.js / clangd.wasm to /clangd/.

import { setLocale, t, type Locale } from '../shared/i18n';

export type ToClangdWorker =
  | { type: 'start'; compileFlags: string[]; locale: Locale }
  | { type: 'config'; compileFlags: string[] }
  | { type: 'lsp'; message: unknown }
  | { type: 'readFile'; id: number; path: string };

export type FromClangdWorker =
  | { type: 'progress'; detail: string }
  | { type: 'started'; ms: number }
  | { type: 'lsp'; message: unknown }
  | { type: 'readFile'; id: number; text: string | null }
  | { type: 'exit'; code: number }
  | { type: 'error'; error: string };

declare const self: DedicatedWorkerGlobalScope;

const CLANGD_JS = new URL('/clangd/clangd.js', self.location.origin).href;
const CLANGD_WASM = new URL('/clangd/clangd.wasm', self.location.origin).href;

const CXX_INCLUDE_FLAGS = ['-isystem/usr/include/c++/v1', '-isystem/usr/include/wasm32-wasi/c++/v1'];
const C_INCLUDE_FLAGS = ['-isystem/usr/include', '-isystem/usr/include/wasm32-wasi'];

/** libc++'s <stdio.h> etc. wrappers would shadow the C headers, so only add them for C++. */
function systemFlags(userFlags: string[]): string[] {
  const isC = userFlags.some((f) => f === '-xc' || f === '--language=c' || /^-std=(gnu|c)\d/.test(f));
  return ['--target=wasm32-wasi', ...(isC ? [] : CXX_INCLUDE_FLAGS), ...C_INCLUDE_FLAGS];
}
const CLANG_FORMAT = 'BasedOnStyle: LLVM\nUseTab: Never\nIndentWidth: 2\nTabWidth: 2\n';
const MAIN_ARGS = [
  '--background-index=false',
  '--clang-tidy=false',
  '--header-insertion=never',
  '--pch-storage=memory',
  '--log=error',
];

const post = (m: FromClangdWorker) => self.postMessage(m);

// ---- stdin: queue of framed messages, consumed byte by byte by clangd -----------------------
const encoder = new TextEncoder();
const chunks: string[] = [];
const current: (number | null)[] = [];
let resolveStdin: () => void = () => {};

function stdin(): number | null {
  if (current.length === 0) {
    if (chunks.length === 0) return null;
    // A trailing null ends the current read() so clangd processes what it has.
    current.push(...encoder.encode(chunks.shift()!), null);
  }
  return current.shift()!;
}

function stdinReady(): Promise<void> | void {
  if (chunks.length === 0) return new Promise<void>((r) => (resolveStdin = r));
}

function sendToClangd(message: unknown) {
  // Escape non-ASCII so the body is pure ASCII and Content-Length (bytes) == string length.
  const body = JSON.stringify(message).replace(
    /[\u007F-\uFFFF]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
  chunks.push(`Content-Length: ${body.length}\r\n`, '\r\n', body);
  resolveStdin();
}

// ---- stdout: Content-Length framing, one byte at a time ------------------------------------
const decoder = new TextDecoder();
let header = '';
let body: Uint8Array | null = null;
let bodyLen = 0;

function stdout(byte: number) {
  if (body) {
    body[bodyLen++] = byte;
    if (bodyLen === body.length) {
      const text = decoder.decode(body);
      body = null;
      try {
        post({ type: 'lsp', message: JSON.parse(text) });
      } catch (e) {
        console.error('[clangd] bad JSON from server', e, text.slice(0, 200));
      }
    }
    return;
  }
  header += String.fromCharCode(byte);
  if (header.endsWith('\r\n\r\n')) {
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    header = '';
    if (m) {
      body = new Uint8Array(Number(m[1]));
      bodyLen = 0;
      if (body.length === 0) body = null;
    }
  }
}

let stderrLine = '';
function stderr(byte: number) {
  if (byte === 10) {
    if (stderrLine) console.debug('[clangd]', stderrLine);
    stderrLine = '';
  } else stderrLine += String.fromCharCode(byte);
}

// ---- wasm download progress: wrap fetch() of the .wasm, keeping streaming compilation ------
const realFetch = self.fetch.bind(self);
self.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const res = await realFetch(input, init);
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.endsWith('.wasm') || !res.body) return res;
  const total = Number(res.headers.get('content-length')) || 0;
  let loaded = 0;
  let lastPct = -1;
  const counted = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        loaded += chunk.byteLength;
        const pct = total ? Math.floor((loaded / total) * 100) : -1;
        if (pct !== lastPct) {
          lastPct = pct;
          post({
            type: 'progress',
            detail: total ? t('clangd.detail.loadingPct', pct) : t('clangd.detail.loadingMB', (loaded / 1e6) | 0),
          });
        }
        ctl.enqueue(chunk);
      },
      flush() {
        post({ type: 'progress', detail: t('clangd.detail.compiling') });
      },
    }),
  );
  return new Response(counted, { status: res.status, statusText: res.statusText, headers: res.headers });
};

// ---- Emscripten module -----------------------------------------------------------------------
interface EmFS {
  writeFile(path: string, data: string): void;
  readFile(path: string, opts: { encoding: 'utf8' }): string;
  mkdirTree?(path: string): void;
  mkdir(path: string): void;
}
interface ClangdModule {
  FS: EmFS;
  callMain(args: string[]): number | void;
}

let inst: ClangdModule | null = null;
const early: ToClangdWorker[] = [];

function writeConfig(fs: EmFS, compileFlags: string[]) {
  try {
    fs.mkdir('/workspace');
  } catch {
    /* exists */
  }
  fs.writeFile(
    '/workspace/.clangd',
    JSON.stringify({ CompileFlags: { Add: [...compileFlags, ...systemFlags(compileFlags)] } }),
  );
  fs.writeFile('/workspace/.clang-format', CLANG_FORMAT);
}

function readFile(path: string): string | null {
  if (!inst) return null;
  try {
    return inst.FS.readFile(path, { encoding: 'utf8' });
  } catch {
    return null;
  }
}

async function start(compileFlags: string[]) {
  const t0 = performance.now();
  try {
    post({ type: 'progress', detail: t('clangd.detail.loading') });
    const { default: Module } = (await import(/* @vite-ignore */ CLANGD_JS)) as {
      default: (opts: Record<string, unknown>) => Promise<ClangdModule>;
    };
    const m = await Module({
      thisProgram: '/usr/bin/clangd',
      locateFile: (p: string, prefix: string) => (p.endsWith('.wasm') ? CLANGD_WASM : prefix + p),
      stdinReady,
      stdin,
      stdout,
      stderr,
      onExit: (code: number) => post({ type: 'exit', code }),
      onAbort: (reason: unknown) => post({ type: 'error', error: `clangd aborted: ${String(reason)}` }),
    });
    inst = m;
    writeConfig(m.FS, compileFlags);
    post({ type: 'progress', detail: t('clangd.detail.starting') });
    // With Asyncify, callMain returns once main() first suspends waiting for stdin.
    m.callMain(MAIN_ARGS);
    post({ type: 'started', ms: Math.round(performance.now() - t0) });
    for (const msg of early.splice(0)) handle(msg);
  } catch (e) {
    post({ type: 'error', error: String((e as Error)?.stack ?? e) });
  }
}

function handle(msg: ToClangdWorker) {
  switch (msg.type) {
    case 'start':
      setLocale(msg.locale);
      void start(msg.compileFlags);
      break;
    case 'lsp':
      // Buffered in `chunks` until clangd reads stdin, so this is safe before start finishes.
      sendToClangd(msg.message);
      break;
    case 'config':
      if (inst) writeConfig(inst.FS, msg.compileFlags);
      else early.push(msg);
      break;
    case 'readFile':
      if (inst) post({ type: 'readFile', id: msg.id, text: readFile(msg.path) });
      else early.push(msg);
      break;
  }
}

self.onmessage = (e: MessageEvent<ToClangdWorker>) => handle(e.data);
