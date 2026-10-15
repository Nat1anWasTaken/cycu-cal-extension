// Tiny JSON-RPC 2.0 client. Transport-agnostic: the bridge plugs in a `send` function and
// feeds incoming messages to handleMessage(). Handlers survive transport swaps, so the
// bridge can reconnect without re-registering anything. No runtime imports (testable
// under `node --test`).

export interface CancellationTokenLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface Disposable {
  dispose(): void;
}

export interface RpcMessage {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const ErrorCodes = {
  MethodNotFound: -32601,
  InternalError: -32603,
  ConnectionClosed: -32099,
  RequestCancelled: -32800,
  ContentModified: -32801,
} as const;

export class RpcError extends Error {
  code: number;
  data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

type NotificationHandler = (params: any) => void;
type RequestHandler = (params: any) => unknown | Promise<unknown>;

interface Pending {
  method: string;
  resolve: (v: any) => void;
  reject: (e: unknown) => void;
  cancelSub?: { dispose(): void };
}

export class JsonRpcClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private requestHandlers = new Map<string, RequestHandler>();
  private sender: ((msg: RpcMessage) => void) | null;

  constructor(send: ((msg: RpcMessage) => void) | null = null) {
    this.sender = send;
  }

  /** Replace the transport (null = disconnected; outgoing messages are dropped). */
  setSender(send: ((msg: RpcMessage) => void) | null): void {
    this.sender = send;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  request<R = unknown>(method: string, params?: unknown, token?: CancellationTokenLike): Promise<R> {
    if (token?.isCancellationRequested) {
      return Promise.reject(new RpcError(ErrorCodes.RequestCancelled, 'Request cancelled'));
    }
    if (!this.sender) return Promise.reject(new RpcError(ErrorCodes.ConnectionClosed, 'Not connected'));
    const id = this.nextId++;
    return new Promise<R>((resolve, reject) => {
      const p: Pending = { method, resolve, reject };
      if (token) {
        p.cancelSub = token.onCancellationRequested(() => {
          if (!this.pending.has(id)) return;
          this.settle(id);
          this.notify('$/cancelRequest', { id });
          reject(new RpcError(ErrorCodes.RequestCancelled, 'Request cancelled'));
        });
      }
      this.pending.set(id, p);
      this.sender?.({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.sender?.({ jsonrpc: '2.0', method, params });
  }

  onNotification(method: string, handler: NotificationHandler): Disposable {
    let set = this.notificationHandlers.get(method);
    if (!set) this.notificationHandlers.set(method, (set = new Set()));
    set.add(handler);
    return { dispose: () => void set.delete(handler) };
  }

  /** Handle a server -> client request. Unhandled methods are answered with `null`. */
  onRequest(method: string, handler: RequestHandler): Disposable {
    this.requestHandlers.set(method, handler);
    return {
      dispose: () => {
        if (this.requestHandlers.get(method) === handler) this.requestHandlers.delete(method);
      },
    };
  }

  /** Reject every in-flight request (e.g. the port disconnected). */
  rejectAll(message = 'Connection closed'): void {
    for (const [id, p] of [...this.pending]) {
      this.settle(id);
      p.reject(new RpcError(ErrorCodes.ConnectionClosed, message));
    }
  }

  handleMessage(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const msg = raw as RpcMessage;
    if (typeof msg.method === 'string') {
      if (msg.id !== undefined && msg.id !== null) void this.answer(msg.id, msg.method, msg.params);
      else for (const h of this.notificationHandlers.get(msg.method) ?? []) safeCall(() => h(msg.params));
      return;
    }
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return; // cancelled or unknown: ignore late responses
    this.settle(msg.id);
    if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
    else p.resolve(msg.result ?? null);
  }

  private settle(id: number): void {
    this.pending.get(id)?.cancelSub?.dispose();
    this.pending.delete(id);
  }

  private async answer(id: number | string, method: string, params: unknown): Promise<void> {
    const handler = this.requestHandlers.get(method);
    try {
      const result = handler ? await handler(params) : null;
      this.sender?.({ jsonrpc: '2.0', id, result: result ?? null });
    } catch (e) {
      this.sender?.({
        jsonrpc: '2.0',
        id,
        error: { code: ErrorCodes.InternalError, message: e instanceof Error ? e.message : String(e) },
      });
    }
  }
}

function safeCall(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.error('[cal-lsp] notification handler failed', e);
  }
}
