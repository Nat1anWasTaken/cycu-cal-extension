// Public entry of the local-model ghost-text feature (content-script side).
//
// Registers a Monaco inline-completions provider for 'c' that asks the offscreen SLM host
// (over SLM_PORT) for a FIM completion. Only the editor text before/after the cursor is
// ever sent: never the problem statement or other page content.

import type * as Monaco from 'monaco-editor/editor/editor.api.js';
import { getLocale, t } from '../shared/i18n';
import {
  SLM_PORT,
  type EnsureOffscreenResponse,
  type SlmPortIn,
  type SlmPortOut,
  type SlmStatus,
  type ToBackground,
} from '../shared/protocol';
import type { Settings } from '../shared/settings';
import { trimContext } from './fim';

export interface InlineCompletionOptions {
  monaco: typeof Monaco;
  editor: Monaco.editor.IStandaloneCodeEditor;
  model: Monaco.editor.ITextModel;
  settings: Settings;
  /** True when suggestions must not be shown (read-only editor, cursor inside a locked range). */
  isSuppressed: (position: Monaco.Position) => boolean;
  onStatus: (status: SlmStatus, progress?: number, detail?: string) => void;
}

export interface InlineCompletion {
  /** Enables/disables (settings.features.inlineCompletion) or switches model / context size (settings.slmModel, settings.slmContextTokens). */
  updateSettings(settings: Settings): void;
  dispose(): void;
}

const DEBOUNCE_MS = 300;
const MAX_TOKENS = 64;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export function startInlineCompletion(opts: InlineCompletionOptions): InlineCompletion {
  const { monaco, model } = opts;
  let settings = opts.settings;
  let disposed = false;

  let provider: Monaco.IDisposable | null = null;
  let port: chrome.runtime.Port | null = null;
  let connecting = false;
  /** `${modelId}@${contextTokens}` last sent in a `load`, so unchanged settings don't resend it. */
  let sentLoad: string | null = null;
  let status: SlmStatus = 'idle';
  let reconnectDelay = RECONNECT_MIN_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  let nextId = 1;
  let inFlight: { id: number; resolve: (text: string | null) => void } | null = null;

  const enabled = () => !disposed && settings.features.inlineCompletion;

  const report = (s: SlmStatus, progress?: number, detail?: string) => {
    status = s;
    opts.onStatus(s, progress, detail);
  };

  function send(msg: SlmPortIn): boolean {
    if (!port) return false;
    try {
      port.postMessage(msg);
      return true;
    } catch {
      return false;
    }
  }

  function settle(text: string | null): void {
    const f = inFlight;
    inFlight = null;
    f?.resolve(text);
  }

  function cancelInFlight(): void {
    if (!inFlight) return;
    send({ type: 'cancel', id: inFlight.id });
    settle(null);
  }

  function sendLoad(): void {
    const key = `${settings.slmModel}@${settings.slmContextTokens}`;
    if (
      port &&
      sentLoad !== key &&
      send({ type: 'load', modelId: settings.slmModel, contextTokens: settings.slmContextTokens, locale: getLocale() })
    ) {
      sentLoad = key;
    }
  }

  function onPortMessage(msg: SlmPortOut): void {
    switch (msg?.type) {
      case 'status':
        report(msg.status, msg.progress, msg.detail);
        if (msg.status === 'ready') reconnectDelay = RECONNECT_MIN_MS;
        break;
      case 'completion':
        if (inFlight?.id === msg.id) settle(msg.text);
        break;
      case 'completionError':
        if (inFlight?.id === msg.id) settle(null);
        break;
    }
  }

  async function connect(): Promise<void> {
    if (port || connecting || !enabled()) return;
    connecting = true;
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'ensureOffscreen' } satisfies ToBackground)) as
        EnsureOffscreenResponse | undefined;
      if (!enabled()) return;
      if (!res?.ok) throw new Error(res?.error ?? 'offscreen document unavailable');
      const p = chrome.runtime.connect({ name: SLM_PORT });
      port = p;
      sentLoad = null;
      p.onMessage.addListener(onPortMessage);
      p.onDisconnect.addListener(() => {
        void chrome.runtime.lastError; // silence "Unchecked runtime.lastError"
        if (port !== p) return;
        port = null;
        sentLoad = null;
        settle(null);
        if (enabled()) {
          report('loading', undefined, 'reconnecting');
          scheduleReconnect();
        }
      });
      sendLoad();
    } catch (e) {
      if (!enabled()) return;
      report('error', undefined, e instanceof Error ? e.message : String(e));
      scheduleReconnect();
    } finally {
      connecting = false;
    }
  }

  function scheduleReconnect(): void {
    clearTimeout(reconnectTimer);
    // Extension reloaded/uninstalled: this content script is orphaned, stop trying.
    if (!chrome.runtime?.id) return;
    reconnectTimer = setTimeout(() => void connect(), reconnectDelay);
    reconnectDelay = Math.min(RECONNECT_MAX_MS, reconnectDelay * 2);
  }

  function disconnect(): void {
    clearTimeout(reconnectTimer);
    settle(null);
    const p = port;
    port = null;
    sentLoad = null;
    try {
      p?.disconnect();
    } catch {
      // ignore
    }
  }

  function request(prefix: string, suffix: string, token: Monaco.CancellationToken): Promise<string | null> {
    cancelInFlight(); // only one request in flight
    const id = nextId++;
    return new Promise((resolve) => {
      let sub: Monaco.IDisposable | undefined;
      inFlight = {
        id,
        resolve: (text) => {
          sub?.dispose();
          resolve(text);
        },
      };
      sub = token.onCancellationRequested(() => {
        if (inFlight?.id === id) cancelInFlight();
      });
      if (!send({ type: 'complete', id, prefix, suffix, maxTokens: MAX_TOKENS })) settle(null);
    });
  }

  function registerProvider(): Monaco.IDisposable {
    return monaco.languages.registerInlineCompletionsProvider('c', {
      displayName: t('slm.displayName'),
      debounceDelayMs: DEBOUNCE_MS,
      async provideInlineCompletions(m, position, _context, token) {
        if (m !== model || !enabled() || status !== 'ready' || !port) return undefined;
        if (opts.isSuppressed(position)) return undefined;
        const lastLine = m.getLineCount();
        const lf = monaco.editor.EndOfLinePreference.LF;
        const ctx = trimContext(
          m.getValueInRange(new monaco.Range(1, 1, position.lineNumber, position.column), lf),
          m.getValueInRange(
            new monaco.Range(position.lineNumber, position.column, lastLine, m.getLineMaxColumn(lastLine)),
            lf,
          ),
          // The host trims to the same budget again.
          settings.slmContextTokens,
        );
        if (!ctx.prefix.trim()) return undefined;
        const version = m.getVersionId();
        const text = await request(ctx.prefix, ctx.suffix, token);
        if (!text || token.isCancellationRequested || m.getVersionId() !== version || !enabled()) return undefined;
        if (opts.isSuppressed(position)) return undefined;

        // Multi-line items must replace up to the end of the line: re-append the rest of the line.
        const endCol = m.getLineMaxColumn(position.lineNumber);
        const rest = m.getValueInRange(
          new monaco.Range(position.lineNumber, position.column, position.lineNumber, endCol),
        );
        const multiLine = text.includes('\n');
        return {
          items: [
            {
              insertText: multiLine ? text + rest : text,
              range: new monaco.Range(
                position.lineNumber,
                position.column,
                position.lineNumber,
                multiLine ? endCol : position.column,
              ),
            },
          ],
        };
      },
      disposeInlineCompletions() {},
    });
  }

  function apply(): void {
    if (enabled()) {
      provider ??= registerProvider();
      if (port) sendLoad();
      else void connect();
    } else {
      provider?.dispose();
      provider = null;
      disconnect();
      report('idle');
    }
  }

  apply();

  return {
    updateSettings(next: Settings) {
      settings = next;
      apply();
    },
    dispose() {
      disposed = true;
      apply();
    },
  };
}
