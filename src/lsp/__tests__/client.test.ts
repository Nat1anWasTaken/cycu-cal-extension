import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonRpcClient, RpcError, type RpcMessage } from '../client.ts';

/** Fake port: records what the client sends. */
function fakePort() {
  const sent: RpcMessage[] = [];
  const client = new JsonRpcClient((m: RpcMessage) => sent.push(m));
  return { sent, client };
}

function fakeToken() {
  const listeners: Array<() => void> = [];
  return {
    isCancellationRequested: false,
    onCancellationRequested(l: () => void) {
      listeners.push(l);
      return { dispose: () => listeners.splice(listeners.indexOf(l), 1) };
    },
    cancel() {
      this.isCancellationRequested = true;
      for (const l of [...listeners]) l();
    },
    get listenerCount() {
      return listeners.length;
    },
  };
}

test('requests get increasing ids and resolve by id, out of order', async () => {
  const { sent, client } = fakePort();
  const a = client.request('textDocument/hover', { a: 1 });
  const b = client.request('textDocument/completion', { b: 2 });
  assert.deepEqual(sent.map((m) => [m.id, m.method]), [[1, 'textDocument/hover'], [2, 'textDocument/completion']]);
  client.handleMessage({ jsonrpc: '2.0', id: 2, result: 'B' });
  client.handleMessage({ jsonrpc: '2.0', id: 1, result: null });
  assert.equal(await b, 'B');
  assert.equal(await a, null);
  assert.equal(client.pendingCount, 0);
  client.handleMessage({ jsonrpc: '2.0', id: 1, result: 'late' }); // ignored
});

test('error responses reject with RpcError', async () => {
  const { client } = fakePort();
  const p = client.request('x');
  client.handleMessage({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'nope' } });
  await assert.rejects(p, (e: unknown) => e instanceof RpcError && e.code === -32601 && e.message === 'nope');
});

test('notifications are dispatched; handlers can be disposed', () => {
  const { client } = fakePort();
  const got: unknown[] = [];
  const sub = client.onNotification('textDocument/publishDiagnostics', (p) => got.push(p));
  client.handleMessage({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'u' } });
  sub.dispose();
  client.handleMessage({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'v' } });
  assert.deepEqual(got, [{ uri: 'u' }]);
});

test('server requests: handled ones reply with the result, unknown ones with null', async () => {
  const { sent, client } = fakePort();
  let refreshed = 0;
  client.onRequest('workspace/inlayHint/refresh', () => {
    refreshed++;
    return null;
  });
  client.onRequest('workspace/configuration', async (p: { items: unknown[] }) => p.items.map(() => 42));
  client.onRequest('boom', () => {
    throw new Error('bad');
  });
  client.handleMessage({ jsonrpc: '2.0', id: 'r1', method: 'workspace/inlayHint/refresh' });
  client.handleMessage({ jsonrpc: '2.0', id: 7, method: 'workspace/configuration', params: { items: [{}, {}] } });
  client.handleMessage({ jsonrpc: '2.0', id: 8, method: 'window/somethingNew', params: {} });
  client.handleMessage({ jsonrpc: '2.0', id: 9, method: 'boom' });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(refreshed, 1);
  const byId = Object.fromEntries(sent.map((m) => [String(m.id), m]));
  assert.equal(byId.r1.result, null);
  assert.deepEqual(byId['7'].result, [42, 42]);
  assert.equal(byId['8'].result, null);
  assert.equal(byId['8'].error, undefined);
  assert.equal(byId['9'].error!.code, -32603);
});

test('cancellation sends $/cancelRequest and rejects', async () => {
  const { sent, client } = fakePort();
  const token = fakeToken();
  const p = client.request('textDocument/completion', {}, token);
  token.cancel();
  await assert.rejects(p, (e: unknown) => e instanceof RpcError && e.code === -32800);
  assert.deepEqual(sent[1], { jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 1 } });
  assert.equal(client.pendingCount, 0);
  client.handleMessage({ jsonrpc: '2.0', id: 1, result: [] }); // late response ignored

  // Already-cancelled token: nothing is sent.
  const before = sent.length;
  await assert.rejects(client.request('x', {}, token));
  assert.equal(sent.length, before);

  // A resolved request disposes its cancellation listener.
  const t2 = fakeToken();
  const q = client.request('y', {}, t2);
  assert.equal(t2.listenerCount, 1);
  client.handleMessage({ jsonrpc: '2.0', id: 2, result: 1 });
  assert.equal(await q, 1);
  assert.equal(t2.listenerCount, 0);
});

test('rejectAll on disconnect; reconnect keeps handlers and continues ids', async () => {
  const sentA: RpcMessage[] = [];
  const client = new JsonRpcClient((m: RpcMessage) => sentA.push(m));
  let notes = 0;
  client.onNotification('n', () => notes++);
  const p = client.request('initialize', {});
  client.setSender(null);
  client.rejectAll();
  await assert.rejects(p, (e: unknown) => e instanceof RpcError && e.code === -32099);
  await assert.rejects(client.request('while-disconnected'));

  const sentB: RpcMessage[] = [];
  client.setSender((m: RpcMessage) => sentB.push(m));
  const q = client.request('initialize', {});
  assert.equal(sentB[0].id, 2);
  client.handleMessage({ jsonrpc: '2.0', id: 2, result: { capabilities: {} } });
  assert.deepEqual(await q, { capabilities: {} });
  client.handleMessage({ jsonrpc: '2.0', method: 'n' });
  assert.equal(notes, 1);
});
