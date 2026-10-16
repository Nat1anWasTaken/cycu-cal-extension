// One shared clangd worker for every tab. Each content script connects a Port (LSP_PORT);
// this host multiplexes them onto clangd's single JSON-RPC stream:
//  - client request ids are rewritten to unique server ids and mapped back on response;
//  - only the first `initialize` reaches clangd, later clients get the cached result and
//    their `initialized` is swallowed;
//  - publishDiagnostics is routed to the port that opened the URI, other notifications are
//    broadcast; server→client requests are answered here (refreshes are also broadcast);
//  - cal/readFile is served from the worker's Emscripten FS;
//  - a disconnecting port gets didClose for its documents; idle shutdown after IDLE_MS.

import { getLocale, setLocale, t } from '../shared/i18n';
import {
  READ_FILE_METHOD,
  type LspPortIn,
  type LspPortOut,
  type ReadFileParams,
  type ReadFileResult,
  type ServerStatus,
} from '../shared/protocol';
import { DEFAULT_SETTINGS } from '../shared/settings';
import type { FromClangdWorker, ToClangdWorker } from './clangd-worker';

type Id = number | string;
interface RpcMessage {
  jsonrpc?: '2.0';
  id?: Id | null;
  method?: string;
  params?: any;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface Client {
  port: chrome.runtime.Port;
  /** Client request id → server request id (for $/cancelRequest). */
  ids: Map<Id, number>;
  openUris: Set<string>;
  connected: boolean;
}

type Pending = { kind: 'init' } | { kind: 'client'; client: Client; id: Id };

const IDLE_MS = 10 * 60_000;
const REFRESH_METHODS = new Set([
  'workspace/inlayHint/refresh',
  'workspace/semanticTokens/refresh',
  'workspace/codeLens/refresh',
  'workspace/diagnostic/refresh',
  'workspace/inlineValue/refresh',
  'workspace/foldingRange/refresh',
]);
const LOCAL_NULL_METHODS = new Set([
  'window/workDoneProgress/create',
  'client/registerCapability',
  'client/unregisterCapability',
  'window/showMessageRequest',
  'window/showDocument',
]);

export class LspHost {
  private clients = new Set<Client>();
  private worker: Worker | null = null;
  private status: ServerStatus = 'stopped';
  private detail: string | undefined;
  private flags: string[] | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private init:
    | { state: 'none' }
    | { state: 'pending'; waiters: { client: Client; id: Id }[] }
    | { state: 'done'; result: unknown } = {
    state: 'none',
  };
  private initializedSent = false;
  private uriOwner = new Map<string, Client>();
  private readFiles = new Map<number, { client: Client; id: Id }>();
  /** Host id of a server→client request forwarded to one client → clangd's id. */
  private serverReqs = new Map<string, { client: Client; serverId: Id; fallback: unknown }>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private startedAt = 0;

  attach(port: chrome.runtime.Port): void {
    const client: Client = { port, ids: new Map(), openUris: new Set(), connected: true };
    this.clients.add(client);
    clearTimeout(this.idleTimer);
    port.onMessage.addListener((m: LspPortIn) => {
      if (m?.type === 'hello') {
        setLocale(m.locale);
        this.onHello(client, m.compileFlags);
      } else if (m?.type === 'rpc') this.fromClient(client, m.message as RpcMessage);
    });
    port.onDisconnect.addListener(() => this.onDisconnect(client));
  }

  // ---- lifecycle -------------------------------------------------------------------------

  private onHello(client: Client, compileFlags: string[] | undefined) {
    const flags = Array.isArray(compileFlags) ? compileFlags : DEFAULT_SETTINGS.compileFlags;
    if (this.worker && JSON.stringify(flags) !== JSON.stringify(this.flags)) {
      this.flags = flags;
      this.toWorker({ type: 'config', compileFlags: flags });
    }
    this.ensureWorker(flags);
    this.sendTo(client, { type: 'status', status: this.status, detail: this.detail });
  }

  private ensureWorker(flags: string[] = this.flags ?? DEFAULT_SETTINGS.compileFlags) {
    if (this.worker) return;
    this.flags = flags;
    this.startedAt = performance.now();
    const w = new Worker(new URL('./clangd-worker.ts', import.meta.url), { type: 'module', name: 'cal-clangd' });
    this.worker = w;
    w.onmessage = (e: MessageEvent<FromClangdWorker>) => {
      if (this.worker === w) this.fromWorker(e.data);
    };
    w.onerror = (e) => {
      if (this.worker === w)
        this.stopWorker('error', t('clangd.detail.workerError', e.message || t('clangd.detail.failedToLoad')));
    };
    this.toWorker({ type: 'start', compileFlags: flags, locale: getLocale() });
    this.setStatus('loading', t('clangd.detail.loading'));
  }

  private stopWorker(status: ServerStatus, detail?: string) {
    this.worker?.terminate();
    this.worker = null;
    const err = { code: -32099, message: detail ?? t('clangd.detail.stopped') };
    for (const p of this.pending.values()) if (p.kind === 'client') this.reply(p.client, p.id, undefined, err);
    if (this.init.state === 'pending') for (const w of this.init.waiters) this.reply(w.client, w.id, undefined, err);
    for (const r of this.readFiles.values()) this.reply(r.client, r.id, { text: null } satisfies ReadFileResult);
    for (const c of this.clients) {
      c.ids.clear();
      c.openUris.clear();
    }
    this.pending.clear();
    this.readFiles.clear();
    this.serverReqs.clear();
    this.uriOwner.clear();
    this.init = { state: 'none' };
    this.initializedSent = false;
    this.setStatus(status, detail);
  }

  private onDisconnect(client: Client) {
    client.connected = false;
    this.clients.delete(client);
    for (const uri of client.openUris) {
      if (this.uriOwner.get(uri) === client) this.uriOwner.delete(uri);
      this.toServer({ jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri } } });
    }
    for (const [sid, p] of this.pending) {
      if (p.kind === 'client' && p.client === client) {
        this.pending.delete(sid);
        this.toServer({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: sid } });
      }
    }
    if (this.init.state === 'pending') this.init.waiters = this.init.waiters.filter((w) => w.client !== client);
    for (const [rid, r] of this.readFiles) if (r.client === client) this.readFiles.delete(rid);
    for (const [hid, r] of this.serverReqs) {
      if (r.client === client) {
        this.serverReqs.delete(hid);
        this.toServer({ jsonrpc: '2.0', id: r.serverId, result: r.fallback });
      }
    }
    if (this.clients.size === 0 && this.worker) {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        if (this.clients.size === 0) this.stopWorker('stopped', t('clangd.detail.idle'));
      }, IDLE_MS);
    }
  }

  private setStatus(status: ServerStatus, detail?: string) {
    this.status = status;
    this.detail = detail;
    for (const c of this.clients) this.sendTo(c, { type: 'status', status, detail });
  }

  // ---- client → server -------------------------------------------------------------------

  private fromClient(client: Client, msg: RpcMessage) {
    if (!msg || typeof msg !== 'object') return;
    this.ensureWorker();
    const isRequest = typeof msg.method === 'string' && msg.id !== undefined && msg.id !== null;

    if (isRequest) {
      const id = msg.id as Id;
      switch (msg.method) {
        case 'initialize':
          if (this.init.state === 'done') this.reply(client, id, this.init.result);
          else if (this.init.state === 'pending') this.init.waiters.push({ client, id });
          else {
            this.init = { state: 'pending', waiters: [{ client, id }] };
            const sid = this.nextId++;
            this.pending.set(sid, { kind: 'init' });
            this.toServer({ ...msg, id: sid });
          }
          return;
        case 'shutdown':
          this.reply(client, id, null); // the server is shared; never shut it down for one tab
          return;
        case READ_FILE_METHOD: {
          const rid = this.nextId++;
          this.readFiles.set(rid, { client, id });
          this.toWorker({ type: 'readFile', id: rid, path: uriToPath((msg.params as ReadFileParams)?.uri) });
          return;
        }
      }
      const sid = this.nextId++;
      this.pending.set(sid, { kind: 'client', client, id });
      client.ids.set(id, sid);
      this.toServer({ ...msg, id: sid });
      return;
    }

    if (typeof msg.method === 'string') {
      switch (msg.method) {
        case 'initialized':
          if (this.initializedSent) return;
          this.initializedSent = true;
          break;
        case 'exit':
          return;
        case '$/cancelRequest': {
          const sid = client.ids.get(msg.params?.id);
          if (sid === undefined) return;
          this.toServer({ ...msg, params: { id: sid } });
          return;
        }
        case 'textDocument/didOpen': {
          const uri = msg.params?.textDocument?.uri;
          if (typeof uri === 'string') {
            client.openUris.add(uri);
            this.uriOwner.set(uri, client);
          }
          break;
        }
        case 'textDocument/didClose': {
          const uri = msg.params?.textDocument?.uri;
          client.openUris.delete(uri);
          if (this.uriOwner.get(uri) === client) this.uriOwner.delete(uri);
          break;
        }
      }
      this.toServer(msg);
      return;
    }

    // Response to a server→client request we forwarded.
    if (typeof msg.id === 'string') {
      const r = this.serverReqs.get(msg.id);
      if (!r || r.client !== client) return; // broadcast requests: responses are dropped
      this.serverReqs.delete(msg.id);
      this.toServer({ jsonrpc: '2.0', id: r.serverId, result: msg.result, error: msg.error });
    }
  }

  // ---- server → client -------------------------------------------------------------------

  private fromWorker(m: FromClangdWorker) {
    switch (m.type) {
      case 'progress':
        if (this.status === 'loading') this.setStatus('loading', m.detail);
        break;
      case 'started':
        console.info(`[cal] clangd ready in ${Math.round(performance.now() - this.startedAt)} ms`);
        this.setStatus('ready', t('clangd.detail.started', (m.ms / 1000).toFixed(1)));
        break;
      case 'lsp':
        this.fromServer(m.message as RpcMessage);
        break;
      case 'readFile': {
        const r = this.readFiles.get(m.id);
        if (!r) break;
        this.readFiles.delete(m.id);
        this.reply(r.client, r.id, { text: m.text } satisfies ReadFileResult);
        break;
      }
      case 'exit':
        this.stopWorker(m.code === 0 ? 'stopped' : 'error', t('clangd.detail.exited', m.code));
        break;
      case 'error':
        console.error('[cal]', m.error);
        this.stopWorker('error', m.error);
        break;
    }
  }

  private fromServer(msg: RpcMessage) {
    const hasId = msg.id !== undefined && msg.id !== null;
    if (typeof msg.method !== 'string') {
      if (!hasId) return;
      const p = this.pending.get(msg.id as number);
      if (!p) return;
      this.pending.delete(msg.id as number);
      if (p.kind === 'init') {
        const waiters = this.init.state === 'pending' ? this.init.waiters : [];
        if (msg.error) {
          this.init = { state: 'none' };
          for (const w of waiters) this.reply(w.client, w.id, undefined, msg.error);
        } else {
          this.init = { state: 'done', result: msg.result };
          for (const w of waiters) this.reply(w.client, w.id, msg.result);
        }
        return;
      }
      p.client.ids.delete(p.id);
      this.sendRpc(p.client, { ...msg, id: p.id });
      return;
    }

    if (hasId) {
      this.serverRequest(msg);
      return;
    }

    if (msg.method === 'textDocument/publishDiagnostics') {
      const owner = this.uriOwner.get(msg.params?.uri);
      if (owner) this.sendRpc(owner, msg);
      return;
    }
    for (const c of this.clients) this.sendRpc(c, msg);
  }

  private serverRequest(msg: RpcMessage) {
    const id = msg.id as Id;
    const answer = (result: unknown) => this.toServer({ jsonrpc: '2.0', id, result });
    const method = msg.method!;
    if (REFRESH_METHODS.has(method)) {
      answer(null);
      for (const c of this.clients) this.sendRpc(c, { ...msg, id: `host:${this.nextId++}` });
      return;
    }
    if (LOCAL_NULL_METHODS.has(method)) return answer(null);
    if (method === 'workspace/configuration') return answer((msg.params?.items ?? []).map(() => null));
    if (method === 'workspace/applyEdit') {
      const owner = editOwner(msg.params?.edit, this.uriOwner);
      if (!owner) return answer({ applied: false, failureReason: 'document not open' });
      const hid = `host:${this.nextId++}`;
      this.serverReqs.set(hid, { client: owner, serverId: id, fallback: { applied: false } });
      this.sendRpc(owner, { ...msg, id: hid });
      return;
    }
    this.toServer({ jsonrpc: '2.0', id, error: { code: -32601, message: `${method} not supported` } });
  }

  // ---- plumbing --------------------------------------------------------------------------

  private toWorker(m: ToClangdWorker) {
    this.worker?.postMessage(m);
  }

  private toServer(msg: RpcMessage) {
    this.toWorker({ type: 'lsp', message: msg });
  }

  private reply(client: Client, id: Id, result: unknown, error?: RpcMessage['error']) {
    this.sendRpc(client, error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result: result ?? null });
  }

  private sendRpc(client: Client, message: RpcMessage) {
    this.sendTo(client, { type: 'rpc', message });
  }

  private sendTo(client: Client, m: LspPortOut) {
    if (!client.connected) return;
    try {
      client.port.postMessage(m);
    } catch {
      /* port went away; onDisconnect cleans up */
    }
  }
}

function uriToPath(uri: unknown): string {
  if (typeof uri !== 'string') return '';
  if (!uri.startsWith('file://')) return uri;
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return '';
  }
}

function editOwner(edit: any, owners: Map<string, Client>): Client | undefined {
  const uris: string[] = [
    ...Object.keys(edit?.changes ?? {}),
    ...((edit?.documentChanges ?? []) as any[]).map((d) => d?.textDocument?.uri).filter(Boolean),
  ];
  for (const u of uris) {
    const c = owners.get(u);
    if (c) return c;
  }
  return undefined;
}
