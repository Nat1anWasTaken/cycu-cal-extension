// Offscreen-document side of the SLM. offscreen.ts hands every SLM_PORT connection to
// attachSlmPort(). One wllama instance (its own worker + pthreads, inside the
// cross-origin-isolated offscreen doc) serves all tabs; only one generation runs at a time.
//
// The model is downloaded from Hugging Face on the first `load` only (i.e. only once the user
// has enabled the feature) and cached in OPFS by wllama's CacheManager. Models bundled into the
// offline build are read straight from the extension package instead (no network, no OPFS copy).

import { LoggerWithoutDebug, Wllama, WllamaAbortError } from '@wllama/wllama';
import { isBundled } from '../shared/bundle';
import {
  bundledModelPath,
  modelUrl,
  SLM_MODELS,
  type SlmModelId,
  type SlmPortIn,
  type SlmPortOut,
  type SlmStatus,
} from '../shared/protocol';
import { buildFimPrompt, cursorContext, postprocess, STOP_SEQUENCES, trimContext, DEFAULT_MAX_CONTEXT_TOKENS } from './fim';

const WASM_PATH = 'wllama/wllama.wasm';
/** Prompt (~1.5k tokens) + generation fits comfortably. */
const N_CTX = 2048;
const MAX_TOKENS_CAP = 128;
/** Free the model's memory after this long without any connected tab. */
const IDLE_UNLOAD_MS = 10 * 60_000;
/** Abort an in-progress download if no tab reconnects within this window (e.g. the feature was disabled). */
const DOWNLOAD_ABANDON_MS = 20_000;
const TAB_SIZE = 2;

interface StatusMsg {
  status: SlmStatus;
  progress?: number;
  detail?: string;
}

interface Generation {
  id: number;
  port: chrome.runtime.Port;
  ac: AbortController;
}

const ports = new Set<chrome.runtime.Port>();
let status: StatusMsg = { status: 'idle' };

let wllama: Wllama | null = null;
let loadedModel: SlmModelId | null = null;
let wantedModel: SlmModelId | null = null;
let downloadAc: AbortController | null = null;
/** Serializes model loads/unloads. */
let modelChain: Promise<void> = Promise.resolve();
/** Serializes generations (wllama runs one request at a time). */
let genChain: Promise<void> = Promise.resolve();
let current: Generation | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let abandonTimer: ReturnType<typeof setTimeout> | undefined;

function post(port: chrome.runtime.Port, msg: SlmPortOut): void {
  try {
    port.postMessage(msg);
  } catch {
    // Port already gone.
  }
}

function setStatus(next: StatusMsg): void {
  status = next;
  for (const p of ports) post(p, { type: 'status', ...next });
}

export function attachSlmPort(port: chrome.runtime.Port): void {
  ports.add(port);
  clearTimeout(idleTimer);
  clearTimeout(abandonTimer);
  post(port, { type: 'status', ...status });

  port.onMessage.addListener((msg: SlmPortIn) => {
    switch (msg?.type) {
      case 'load':
        if (msg.modelId in SLM_MODELS) requestModel(msg.modelId);
        else post(port, { type: 'status', status: 'error', detail: `unknown model ${msg.modelId}` });
        break;
      case 'complete':
        complete(port, msg);
        break;
      case 'cancel':
        if (current && current.port === port && current.id === msg.id) current.ac.abort();
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    ports.delete(port);
    if (current?.port === port) current.ac.abort();
    if (ports.size > 0) return;
    if (downloadAc) {
      abandonTimer = setTimeout(() => {
        if (ports.size === 0) downloadAc?.abort();
      }, DOWNLOAD_ABANDON_MS);
    }
    idleTimer = setTimeout(() => {
      if (ports.size === 0) unload();
    }, IDLE_UNLOAD_MS);
  });
}

// ---------------------------------------------------------------------------
// Model lifecycle
// ---------------------------------------------------------------------------

function requestModel(id: SlmModelId): void {
  if (id === wantedModel) {
    // Already loaded or loading: just (re)announce the state.
    setStatus(status);
    return;
  }
  wantedModel = id;
  downloadAc?.abort(); // a different model is loading: stop it
  modelChain = modelChain.then(() => switchTo(id)).catch(() => {});
}

function unload(): void {
  wantedModel = null;
  downloadAc?.abort();
  modelChain = modelChain
    .then(async () => {
      current?.ac.abort();
      await genChain;
      if (wllama) await wllama.exit().catch(() => {});
      wllama = null;
      loadedModel = null;
      status = { status: 'idle' };
    })
    .catch(() => {});
}

async function switchTo(id: SlmModelId): Promise<void> {
  if (wantedModel !== id) return; // superseded while queued
  if (wllama && loadedModel === id) {
    setStatus({ status: 'ready' });
    return;
  }
  current?.ac.abort();
  await genChain;
  if (wllama) {
    await wllama.exit().catch(() => {});
    wllama = null;
    loadedModel = null;
  }

  const w = new Wllama(
    { default: chrome.runtime.getURL(WASM_PATH) },
    { logger: LoggerWithoutDebug, suppressNativeLog: true, allowOffline: true },
  );
  const ac = new AbortController();
  downloadAc = ac;
  try {
    if (isBundled(id)) {
      setStatus({ status: 'loading' });
      const res = await fetch(chrome.runtime.getURL(bundledModelPath(id)), { signal: ac.signal });
      if (!res.ok) throw new Error(`bundled model missing (HTTP ${res.status})`);
      await w.loadModel([await res.blob()], { n_ctx: N_CTX });
    } else {
      await download(w, id, ac.signal);
    }
    if (wantedModel !== id) {
      await w.exit().catch(() => {});
      return;
    }
    wllama = w;
    loadedModel = id;
    setStatus({ status: 'ready', detail: `${SLM_MODELS[id].label}, ${w.isMultithread() ? w.getNumThreads() : 1} threads` });
  } catch (e) {
    await w.exit().catch(() => {});
    if (wantedModel !== id) return; // aborted because the user switched / disabled
    if (ac.signal.aborted) {
      wantedModel = null;
      status = { status: 'idle' };
      return;
    }
    wantedModel = null; // allow a retry via the next `load`
    setStatus({ status: 'error', detail: e instanceof Error ? e.message : String(e) });
  } finally {
    if (downloadAc === ac) downloadAc = null;
  }
}

/** Loads a non-bundled model from Hugging Face, through wllama's OPFS cache. */
async function download(w: Wllama, id: SlmModelId, signal: AbortSignal): Promise<void> {
  const url = modelUrl(id);
  const cached = (await w.modelManager.getModels()).some((m) => m.url === url);
  setStatus(cached ? { status: 'loading' } : { status: 'downloading', progress: 0 });
  let lastPct = -1;
  await w.loadModelFromUrl(url, {
    n_ctx: N_CTX,
    signal,
    progressCallback: ({ loaded, total }) => {
      if (wantedModel !== id) return;
      if (total > 0 && loaded < total) {
        const pct = Math.floor((loaded / total) * 100);
        if (pct !== lastPct) setStatus({ status: 'downloading', progress: (lastPct = pct) });
      } else if (status.status !== 'loading') {
        setStatus({ status: 'loading' });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

function complete(port: chrome.runtime.Port, msg: Extract<SlmPortIn, { type: 'complete' }>): void {
  current?.ac.abort(); // only one generation at a time: the newest request wins
  const gen: Generation = { id: msg.id, port, ac: new AbortController() };
  current = gen;
  const run = genChain.then(() => generate(gen, msg));
  genChain = run.catch(() => {});
}

async function generate(gen: Generation, msg: Extract<SlmPortIn, { type: 'complete' }>): Promise<void> {
  const fail = (error: string) => post(gen.port, { type: 'completionError', id: gen.id, error });
  try {
    if (gen.ac.signal.aborted) return fail('cancelled');
    const w = wllama;
    if (!w || loadedModel !== wantedModel) return fail('model not ready');

    // ONLY editor text around the cursor goes into the prompt.
    const ctxText = trimContext(String(msg.prefix ?? ''), String(msg.suffix ?? ''), DEFAULT_MAX_CONTEXT_TOKENS);
    const prompt = buildFimPrompt(ctxText.prefix, ctxText.suffix);
    const cursor = cursorContext(ctxText.prefix, ctxText.suffix, TAB_SIZE);
    const maxTokens = Math.max(1, Math.min(MAX_TOKENS_CAP, Math.floor(Number(msg.maxTokens) || 64)));

    let raw = '';
    let stoppedEarly = false;
    const stop = new AbortController();
    const onCancel = () => stop.abort();
    gen.ac.signal.addEventListener('abort', onCancel);
    try {
      await w.createCompletion({
        prompt,
        max_tokens: maxTokens,
        temperature: 0,
        top_k: 1,
        stop: STOP_SEQUENCES,
        stream: true,
        abortSignal: stop.signal,
        onData: (chunk) => {
          raw += chunk.choices[0]?.text ?? '';
          if (!stop.signal.aborted && postprocess(raw, cursor, false).done) {
            stoppedEarly = true;
            stop.abort();
          }
        },
      });
    } catch (e) {
      if (gen.ac.signal.aborted) return fail('cancelled');
      // We abort on purpose once a stop condition is reached; anything else is a real error.
      if (!(stoppedEarly && (e instanceof WllamaAbortError || stop.signal.aborted))) throw e;
    } finally {
      gen.ac.signal.removeEventListener('abort', onCancel);
    }
    if (gen.ac.signal.aborted) return fail('cancelled');
    post(gen.port, { type: 'completion', id: gen.id, text: postprocess(raw, cursor, true).text });
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  } finally {
    if (current === gen) current = null;
  }
}
