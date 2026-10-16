// Connection + document sync between one Monaco model and clangd (via the offscreen host).
//
// - Connects with `ensureOffscreen` + chrome.runtime.connect(LSP_PORT), sends LspHello, then
//   wraps JSON-RPC in `{type:'rpc'}` frames.
// - Reconnects with exponential backoff when the port drops (service worker / offscreen doc
//   restart) or the host reports error/stopped; every connection re-runs initialize/didOpen.
// - The document gets its own LSP URI (file:///workspace/<topic>-<random>.c). The Monaco
//   model keeps the URI the content script gave it; toModelUri()/isOurs() map between them.
// - didChange is full-sync, debounced 150 ms, and always flushed before a request.

import type * as Monaco from 'monaco-editor/editor/editor.api.js';
import type * as P from 'vscode-languageserver-protocol';
import {
  LSP_PORT,
  type EnsureOffscreenResponse,
  type LockRange,
  type LspHello,
  type LspPortIn,
  type LspPortOut,
  type ServerStatus,
  type ToBackground,
} from '../shared/protocol';
import { getLocale, t } from '../shared/i18n';
import { JsonRpcClient, type CancellationTokenLike, type Disposable } from './client';

export interface PortLike {
  postMessage(msg: unknown): void;
  disconnect(): void;
  onMessage: { addListener(cb: (msg: any) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
}

export interface BridgeOptions {
  monaco: typeof Monaco;
  model: Monaco.editor.ITextModel;
  topicId: string;
  compileFlags: string[];
  onStatus: (status: ServerStatus, detail?: string) => void;
  /** Override for tests; defaults to ensureOffscreen + chrome.runtime.connect. */
  connect?: () => Promise<PortLike>;
}

/** Everything a feature module needs. Features must use `monaco` from here (never import it). */
export interface FeatureContext {
  monaco: typeof Monaco;
  editor: Monaco.editor.IStandaloneCodeEditor;
  model: Monaco.editor.ITextModel;
  bridge: LspBridge;
  headers: HeaderModelsLike;
  getLocks: () => LockRange[];
  /** Language selector for provider registration. Providers must also check `bridge.isOurs(model)`. */
  selector: string;
}

export interface HeaderModelsLike {
  /** Returns (creating if needed) a read-only model for a non-workspace file such as a system header. */
  ensure(lspUri: string): Promise<Monaco.editor.ITextModel | null>;
  /** Shows a header read-only in a peek widget in `editor`, anchored at `anchor` (default: cursor). */
  peek(
    editor: Monaco.editor.ICodeEditor,
    lspUri: string,
    range?: Monaco.IRange,
    anchor?: Monaco.IPosition,
  ): Promise<boolean>;
}

export type FeatureRegister = (ctx: FeatureContext) => Monaco.IDisposable;

const DEBOUNCE_MS = 150;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 30_000;

export const SEMANTIC_TOKEN_TYPES = [
  'namespace',
  'type',
  'class',
  'enum',
  'interface',
  'struct',
  'typeParameter',
  'parameter',
  'variable',
  'property',
  'enumMember',
  'event',
  'function',
  'method',
  'macro',
  'keyword',
  'modifier',
  'comment',
  'string',
  'number',
  'regexp',
  'operator',
  'decorator',
  'label',
  'concept',
  'bracket',
];
export const SEMANTIC_TOKEN_MODIFIERS = [
  'declaration',
  'definition',
  'readonly',
  'static',
  'deprecated',
  'abstract',
  'async',
  'modification',
  'documentation',
  'defaultLibrary',
  'deduced',
  'virtual',
  'dependentName',
  'usedAsMutableReference',
  'usedAsMutablePointer',
  'constructorOrDestructor',
  'userDefined',
  'functionScope',
  'classScope',
  'fileScope',
  'globalScope',
];

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

export function clientCapabilities(): P.ClientCapabilities {
  return {
    general: { positionEncodings: ['utf-16'] },
    window: { workDoneProgress: true, showMessage: {} },
    workspace: {
      workspaceEdit: { documentChanges: true },
      inlayHint: { refreshSupport: true },
      semanticTokens: { refreshSupport: true },
    },
    textDocument: {
      synchronization: { dynamicRegistration: false, didSave: false, willSave: false, willSaveWaitUntil: false },
      publishDiagnostics: {
        relatedInformation: true,
        tagSupport: { valueSet: [1, 2] },
        codeDescriptionSupport: true,
        versionSupport: true,
      },
      completion: {
        contextSupport: true,
        completionItem: {
          snippetSupport: true,
          documentationFormat: ['markdown', 'plaintext'],
          deprecatedSupport: true,
          preselectSupport: true,
          tagSupport: { valueSet: [1] },
          insertReplaceSupport: true,
          labelDetailsSupport: true,
          resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] },
        },
        completionItemKind: { valueSet: range(25) as P.CompletionItemKind[] },
        completionList: { itemDefaults: ['commitCharacters', 'editRange', 'insertTextFormat', 'data'] },
      },
      hover: { contentFormat: ['markdown', 'plaintext'] },
      signatureHelp: {
        contextSupport: true,
        signatureInformation: {
          documentationFormat: ['markdown', 'plaintext'],
          parameterInformation: { labelOffsetSupport: true },
          activeParameterSupport: true,
        },
      },
      definition: { linkSupport: true },
      declaration: { linkSupport: true },
      references: {},
      documentHighlight: {},
      documentSymbol: {
        hierarchicalDocumentSymbolSupport: true,
        symbolKind: { valueSet: range(26) as P.SymbolKind[] },
        tagSupport: { valueSet: [1] },
      },
      codeAction: {
        codeActionLiteralSupport: {
          codeActionKind: {
            valueSet: ['', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source'],
          },
        },
        isPreferredSupport: true,
      },
      formatting: {},
      rangeFormatting: {},
      onTypeFormatting: {},
      rename: { prepareSupport: true },
      documentLink: { tooltipSupport: true },
      foldingRange: { lineFoldingOnly: true, foldingRangeKind: { valueSet: ['comment', 'imports', 'region'] } },
      inlayHint: {},
      semanticTokens: {
        requests: { full: { delta: true } },
        tokenTypes: SEMANTIC_TOKEN_TYPES,
        tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
        formats: ['relative'],
        overlappingTokenSupport: false,
        multilineTokenSupport: false,
        augmentsSyntaxTokens: true,
      },
    },
  };
}

async function chromeConnect(): Promise<PortLike> {
  const msg: ToBackground = { type: 'ensureOffscreen' };
  const res = (await chrome.runtime.sendMessage(msg)) as EnsureOffscreenResponse | undefined;
  if (res && !res.ok) throw new Error(res.error ?? 'offscreen document unavailable');
  return chrome.runtime.connect({ name: LSP_PORT });
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export class LspBridge {
  readonly uri: string;
  readonly client = new JsonRpcClient();
  initializeResult: P.InitializeResult | null = null;
  /** Last diagnostics clangd published for our document (kept while the feature is off). */
  lastDiagnostics: P.Diagnostic[] = [];

  private opts: BridgeOptions;
  private port: PortLike | null = null;
  private ready = false;
  private readyWaiters: Array<() => void> = [];
  private initListeners = new Set<(r: P.InitializeResult) => void>();
  private version = 0;
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private changePending = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private generation = 0;
  private disposed = false;
  private subs: Disposable[] = [];

  constructor(opts: BridgeOptions) {
    this.opts = opts;
    const topic = opts.topicId.replace(/[^\w-]/g, '_') || 'topic';
    this.uri = `file:///workspace/${topic}-${randomId()}.c`;

    this.subs.push(
      opts.model.onDidChangeContent(() => this.scheduleChange()),
      this.client.onNotification('textDocument/publishDiagnostics', (p: P.PublishDiagnosticsParams) => {
        if (p.uri === this.uri) this.lastDiagnostics = p.diagnostics;
      }),
      this.client.onNotification('window/showMessage', (p: P.ShowMessageParams) => {
        if (p.type === 1) console.warn('[cal-lsp] clangd:', p.message);
      }),
      this.client.onRequest('window/workDoneProgress/create', () => null),
      this.client.onRequest('workspace/applyEdit', () => ({ applied: false }) satisfies P.ApplyWorkspaceEditResult),
      this.client.onRequest('workspace/configuration', (p: P.ConfigurationParams) => p.items.map(() => null)),
    );
    void this.connect();
  }

  // -- public API for features ----------------------------------------------------------

  get isReady(): boolean {
    return this.ready;
  }

  get textDocument(): P.TextDocumentIdentifier {
    return { uri: this.uri };
  }

  isOurs(model: Monaco.editor.ITextModel): boolean {
    return model === this.opts.model;
  }

  /** LSP URI -> Monaco URI (our model for our document, a parsed URI otherwise). */
  toModelUri = (lspUri: string): Monaco.Uri =>
    lspUri === this.uri ? this.opts.model.uri : this.opts.monaco.Uri.parse(lspUri);

  /**
   * Sends a request once initialized, after flushing pending didChange. Resolves to null on
   * cancellation, disconnect or server error, so providers can return the result directly.
   */
  async request<R>(method: string, params: unknown, token?: CancellationTokenLike): Promise<R | null> {
    if (!(await this.whenReady(token))) return null;
    this.flush();
    try {
      return await this.client.request<R>(method, params, token);
    } catch (e) {
      const code = (e as { code?: number }).code;
      if (code !== -32800 && code !== -32801 && code !== -32099) console.debug('[cal-lsp]', method, 'failed:', e);
      return null;
    }
  }

  onNotification<T>(method: string, handler: (params: T) => void): Disposable {
    return this.client.onNotification(method, handler);
  }

  onServerRequest<T>(method: string, handler: (params: T) => unknown): Disposable {
    return this.client.onRequest(method, handler);
  }

  /** Called after every successful (re)initialize + didOpen. */
  onDidInitialize(cb: (r: P.InitializeResult) => void): Disposable {
    this.initListeners.add(cb);
    return { dispose: () => void this.initListeners.delete(cb) };
  }

  /** Sends a pending didChange immediately. */
  flush(): void {
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = null;
    if (!this.changePending || !this.ready) return;
    this.changePending = false;
    const params: P.DidChangeTextDocumentParams = {
      textDocument: { uri: this.uri, version: ++this.version },
      contentChanges: [{ text: this.opts.model.getValue() }],
    };
    this.client.notify('textDocument/didChange', params);
  }

  /** Reconnects with new compile flags (the host reads them from LspHello). */
  setCompileFlags(flags: string[]): void {
    if (flags.join('\n') === this.opts.compileFlags.join('\n')) return;
    this.opts.compileFlags = [...flags];
    this.attempt = 0;
    this.drop();
    void this.connect();
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.ready) {
      this.flush();
      this.client.notify('textDocument/didClose', {
        textDocument: this.textDocument,
      } satisfies P.DidCloseTextDocumentParams);
    }
    this.disposed = true;
    for (const s of this.subs) s.dispose();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.drop();
    this.initListeners.clear();
  }

  // -- connection lifecycle -------------------------------------------------------------

  private whenReady(token?: CancellationTokenLike): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    if (this.disposed) return Promise.resolve(false);
    return new Promise((resolve) => {
      const sub = token?.onCancellationRequested(() => resolve(false));
      this.readyWaiters.push(() => {
        sub?.dispose();
        resolve(!token?.isCancellationRequested);
      });
    });
  }

  private scheduleChange(): void {
    this.changePending = true;
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => this.flush(), DEBOUNCE_MS);
  }

  private async connect(): Promise<void> {
    if (this.disposed) return;
    const gen = ++this.generation;
    this.opts.onStatus('loading');
    let port: PortLike;
    try {
      port = await (this.opts.connect ?? chromeConnect)();
    } catch (e) {
      if (gen !== this.generation || this.disposed) return;
      if (!extensionAlive()) return this.stop(t('clangd.detail.extensionReloaded'));
      this.opts.onStatus('error', e instanceof Error ? e.message : String(e));
      return this.scheduleReconnect();
    }
    if (gen !== this.generation || this.disposed) {
      port.disconnect();
      return;
    }
    this.port = port;
    port.onMessage.addListener((m: LspPortOut) => {
      if (gen !== this.generation) return;
      if (m?.type === 'rpc') this.client.handleMessage(m.message);
      else if (m?.type === 'status') this.onHostStatus(m.status, m.detail);
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime?.lastError; // silence "Unchecked runtime.lastError"
      if (gen !== this.generation || this.disposed) return;
      this.drop();
      if (!extensionAlive()) return this.stop(t('clangd.detail.extensionReloaded'));
      this.opts.onStatus('loading', t('clangd.detail.reconnecting'));
      this.scheduleReconnect();
    });
    this.client.setSender((message) => port.postMessage({ type: 'rpc', message } satisfies LspPortIn));
    port.postMessage({ type: 'hello', compileFlags: this.opts.compileFlags, locale: getLocale() } satisfies LspHello);

    try {
      const params: P.InitializeParams = {
        processId: null,
        clientInfo: { name: 'cycu-cal-extension' },
        rootUri: 'file:///workspace',
        workspaceFolders: [{ uri: 'file:///workspace', name: 'workspace' }],
        capabilities: clientCapabilities(),
      };
      const result = await this.client.request<P.InitializeResult>('initialize', params);
      if (gen !== this.generation || this.disposed) return;
      this.client.notify('initialized', {});
      this.changePending = false;
      this.client.notify('textDocument/didOpen', {
        textDocument: { uri: this.uri, languageId: 'c', version: ++this.version, text: this.opts.model.getValue() },
      } satisfies P.DidOpenTextDocumentParams);
      this.initializeResult = result;
      this.ready = true;
      this.attempt = 0;
      this.opts.onStatus('ready');
      for (const w of this.readyWaiters.splice(0)) w();
      for (const cb of [...this.initListeners]) {
        try {
          cb(result);
        } catch (e) {
          console.error('[cal-lsp] init listener failed', e);
        }
      }
    } catch (e) {
      if (gen !== this.generation || this.disposed) return;
      this.opts.onStatus('error', t('clangd.detail.initFailed', e instanceof Error ? e.message : String(e)));
      this.drop();
      this.scheduleReconnect();
    }
  }

  private onHostStatus(status: ServerStatus, detail?: string): void {
    // 'ready' is reported by us once initialize completes; the host's 'ready' only means
    // clangd booted, which may precede our handshake.
    if (status === 'ready') {
      if (this.ready) this.opts.onStatus('ready', detail);
      return;
    }
    this.opts.onStatus(status, detail);
    if (status === 'error' || status === 'stopped') {
      this.drop();
      this.scheduleReconnect();
    }
  }

  /** Tear down the current connection without scheduling anything. */
  private drop(): void {
    this.generation++;
    this.ready = false;
    this.client.setSender(null);
    this.client.rejectAll();
    const port = this.port;
    this.port = null;
    try {
      port?.disconnect();
    } catch {
      /* already gone */
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.retryTimer) return;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempt++);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  private stop(detail: string): void {
    this.opts.onStatus('stopped', detail);
    this.disposed = true;
    for (const w of this.readyWaiters.splice(0)) w();
  }
}

function extensionAlive(): boolean {
  try {
    return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
  } catch {
    return false;
  }
}
