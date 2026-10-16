// End-to-end check of the clangd runtime (background → offscreen document → clangd worker).
//
//   OUT_DIR=/tmp/cal-dist-runtime node scripts/build.mjs
//   OUT_DIR=/tmp/cal-dist-runtime node scripts/e2e-runtime.mjs
//
// Launches a separate headless Brave/Chrome with a fresh profile and the built extension,
// then drives the extension's service worker over CDP: it ensures the offscreen document,
// asserts crossOriginIsolated there, connects LSP ports and exercises clangd.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const EXT = resolve(process.env.OUT_DIR ?? '/tmp/cal-dist-runtime');
const BROWSER = process.env.BROWSER ?? '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';

const results = [];
const check = (name, ok, info = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ` — ${info}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
    s.on('error', rej);
  });
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.waiting = new Map();
    this.handlers = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.waiting.has(m.id)) {
        const { res, rej } = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        m.error ? rej(new Error(`${m.error.message} ${m.error.data ?? ''}`)) : res(m.result);
      } else for (const h of this.handlers) h(m);
    };
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
    return new Cdp(ws);
  }
  send(method, params = {}, sessionId) {
    const id = this.id++;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((res, rej) => this.waiting.set(id, { res, rej }));
  }
  async eval(sessionId, expression, timeoutMs = 120_000) {
    const r = await Promise.race([
      this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId),
      sleep(timeoutMs).then(() => {
        throw new Error(`eval timeout: ${expression.slice(0, 80)}`);
      }),
    ]);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
}

async function waitFor(fn, timeoutMs, what) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(200);
  }
}

// Helpers installed into the service worker: a tiny LSP client per named port.
const SW_HELPERS = `
globalThis.T = {
  ports: {}, log: {}, waiters: {}, nextId: 1,
  open(name) {
    const p = chrome.runtime.connect({ name: 'cal-lsp' });
    T.ports[name] = p; T.log[name] = []; T.waiters[name] = new Map();
    p.onMessage.addListener((m) => {
      T.log[name].push({ t: performance.now(), m });
      const id = m.type === 'rpc' && !m.message.method ? m.message.id : undefined;
      if (id !== undefined && T.waiters[name].has(id)) { T.waiters[name].get(id)(m.message); T.waiters[name].delete(id); }
    });
    p.onDisconnect.addListener(() => T.log[name].push({ t: performance.now(), m: { type: 'disconnected' } }));
  },
  hello(name, compileFlags) { T.ports[name].postMessage({ type: 'hello', compileFlags }); },
  notify(name, method, params) { T.ports[name].postMessage({ type: 'rpc', message: { jsonrpc: '2.0', method, params } }); },
  request(name, method, params, timeout = 120000) {
    const id = T.nextId++;
    return new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('request timeout ' + method)), timeout);
      T.waiters[name].set(id, (m) => { clearTimeout(to); res(m); });
      T.ports[name].postMessage({ type: 'rpc', message: { jsonrpc: '2.0', id, method, params } });
    });
  },
  statuses(name) { return T.log[name].filter((e) => e.m.type === 'status').map((e) => ({ t: e.t, ...e.m })); },
  diags(name, uri) { return T.log[name].filter((e) => e.m.type === 'rpc' && e.m.message.method === 'textDocument/publishDiagnostics' && (!uri || e.m.message.params.uri === uri)).map((e) => e.m.message.params); },
  close(name) { T.ports[name].disconnect(); },
};
'ok'`;

const SRC_A = [
  '#include <stdio.h>',
  '// 中文註解：型別錯誤測試 😀',
  'int main(void) {',
  '\t/*中😀*/int x = "a";',
  '\tprintf("%d\\n", x);',
  '    return 0;',
  '}',
  '',
].join('\n');
const SRC_B = 'int f(void) { return undefined_name; }\n';

async function main() {
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'cal-e2e-'));
  const args = [
    '--headless=new',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    `--load-extension=${EXT}`,
    `--disable-extensions-except=${EXT}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ];
  const browser = spawn(BROWSER, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  browser.stderr.on('data', (d) => (stderr += d));
  const cleanup = () => {
    try {
      browser.kill('SIGKILL');
    } catch {}
    setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
  };
  process.on('exit', cleanup);

  try {
    const version = await waitFor(
      () =>
        fetch(`http://127.0.0.1:${port}/json/version`)
          .then((r) => r.json())
          .catch(() => null),
      20_000,
      'DevTools endpoint',
    );
    console.log(`browser: ${version.Browser}`);
    const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    const targets = async () => (await cdp.send('Target.getTargets')).targetInfos;

    let sw = await waitFor(
      async () => (await targets()).find((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://')),
      8_000,
      'extension service worker',
    ).catch(() => null);
    if (!sw) {
      console.log('--load-extension ignored; trying Extensions.loadUnpacked');
      await cdp.send('Extensions.loadUnpacked', { path: EXT });
      sw = await waitFor(
        async () =>
          (await targets()).find((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://')),
        10_000,
        'extension service worker',
      );
    }
    const extId = new URL(sw.url).host;
    console.log(`extension: ${extId}`);
    const { sessionId: swS } = await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });

    // 1. background: ensureOffscreen (twice concurrently to exercise the creation guard).
    await cdp.eval(
      swS,
      `Promise.all([__calEnsureOffscreen(), __calEnsureOffscreen(), __calEnsureOffscreen()]).then(() => 'ok')`,
    );
    const offscreen = await waitFor(
      async () => (await targets()).find((t) => t.url.includes('/src/offscreen/offscreen.html')),
      10_000,
      'offscreen target',
    );
    const offCount = (await targets()).filter((t) => t.url.includes('/src/offscreen/offscreen.html')).length;
    check('ensureOffscreen creates exactly one offscreen document', offCount === 1, `${offCount} found`);
    await cdp.eval(swS, `__calEnsureOffscreen().then(() => 'ok')`);
    const { sessionId: offS } = await cdp.send('Target.attachToTarget', {
      targetId: offscreen.targetId,
      flatten: true,
    });
    await cdp.send('Runtime.enable', {}, offS);
    cdp.handlers.push((m) => {
      if (m.sessionId === offS && m.method === 'Runtime.consoleAPICalled')
        console.log(
          `  [offscreen ${m.params.type}]`,
          m.params.args
            .map((a) => a.value ?? a.description)
            .join(' ')
            .slice(0, 300),
        );
      if (m.sessionId === offS && m.method === 'Runtime.exceptionThrown')
        console.log(
          '  [offscreen exception]',
          m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text,
        );
    });
    const coi = await cdp.eval(offS, `({ coi: self.crossOriginIsolated, sab: typeof SharedArrayBuffer })`);
    check('offscreen document is crossOriginIsolated', coi.coi === true && coi.sab === 'function', JSON.stringify(coi));

    // 2. Port A: hello → status → initialize.
    await cdp.eval(swS, SW_HELPERS);
    const t0 = await cdp.eval(
      swS,
      `(T.open('a'), T.hello('a', ['-xc', '-std=gnu11', '-Wall', '-Wextra']), performance.now())`,
    );
    const init = await cdp.eval(
      swS,
      `T.request('a', 'initialize', { processId: null, rootUri: 'file:///workspace', capabilities: {
        textDocument: { hover: { contentFormat: ['markdown', 'plaintext'] }, completion: { completionItem: { snippetSupport: true } },
          publishDiagnostics: { relatedInformation: true } } } }, 300000)`,
      320_000,
    );
    const st = await cdp.eval(swS, `T.statuses('a')`);
    const ready = st.find((s) => s.status === 'ready');
    check(
      'status loading → ready',
      st[0]?.status === 'loading' && !!ready,
      st
        .map((s) => `${s.status}${s.detail ? `(${s.detail})` : ''}`)
        .filter((v, i, a) => a.indexOf(v) === i)
        .slice(0, 8)
        .join(', ') +
        ' … ' +
        st.at(-1).status,
    );
    const tReady = ready ? ready.t - t0 : NaN;
    const tInit = (await cdp.eval(swS, `performance.now()`)) - t0;
    check(
      'initialize returns clangd capabilities',
      !!init.result?.capabilities?.hoverProvider,
      `serverInfo=${JSON.stringify(init.result?.serverInfo)}`,
    );
    console.log(
      `  time to ready: ${(tReady / 1000).toFixed(2)} s; to initialize result: ${(tInit / 1000).toFixed(2)} s`,
    );
    await cdp.eval(swS, `T.notify('a', 'initialized', {})`);

    // 3. didOpen with a type error + CJK/emoji comment → publishDiagnostics.
    const uriA = 'file:///workspace/520501-a1b2.c';
    await cdp.eval(
      swS,
      `T.notify('a', 'textDocument/didOpen', { textDocument: { uri: '${uriA}', languageId: 'c', version: 1, text: ${JSON.stringify(SRC_A)} } })`,
    );
    const tOpen = Date.now();
    const diagsA = await waitFor(
      async () => (await cdp.eval(swS, `T.diags('a', '${uriA}')`)).at(-1),
      60_000,
      'diagnostics A',
    );
    const d0 = diagsA.diagnostics.find((d) => /int|conversion|char/i.test(d.message));
    check(
      'publishDiagnostics reports the type error at the right UTF-16 column after CJK + emoji (12, not byte 16)',
      !!d0 && d0.range.start.line === 3 && d0.range.start.character === 12,
      `${Date.now() - tOpen} ms; ${diagsA.diagnostics.map((d) => `[${d.range.start.line}:${d.range.start.character}] ${d.message}`).join(' | ')}`,
    );

    // 4. hover on printf (line 4, after a tab).
    const hover = await cdp.eval(
      swS,
      `T.request('a', 'textDocument/hover', { textDocument: { uri: '${uriA}' }, position: { line: 4, character: 3 } })`,
    );
    const hoverText = JSON.stringify(hover.result?.contents ?? '');
    check(
      'hover on printf shows its prototype',
      /printf/.test(hoverText) && /const char/.test(hoverText),
      hoverText.slice(0, 160),
    );

    // 5. completion inside "printf" (prefix "pri").
    const comp = await cdp.eval(
      swS,
      `T.request('a', 'textDocument/completion', { textDocument: { uri: '${uriA}' }, position: { line: 4, character: 4 } })`,
    );
    const items = comp.result?.items ?? comp.result ?? [];
    const labels = items.map((i) => i.filterText ?? i.label);
    check(
      'completion for "pri" includes printf',
      labels.some((l) => /^printf/.test(l.trim())),
      `${items.length} items: ${labels.slice(0, 6).join(', ')}`,
    );

    // 6. definition of printf → header URI, then cal/readFile serves it.
    const def = await cdp.eval(
      swS,
      `T.request('a', 'textDocument/definition', { textDocument: { uri: '${uriA}' }, position: { line: 4, character: 3 } })`,
    );
    const defUri =
      (Array.isArray(def.result) ? def.result[0] : def.result)?.uri ??
      (Array.isArray(def.result) ? def.result[0]?.targetUri : undefined);
    const rf = await cdp.eval(
      swS,
      `T.request('a', 'cal/readFile', { uri: ${JSON.stringify(defUri ?? 'file:///usr/include/stdio.h')} })`,
    );
    check(
      'cal/readFile returns header text for printf definition',
      typeof rf.result?.text === 'string' && rf.result.text.includes('printf'),
      `${defUri} (${rf.result?.text?.length ?? 'null'} chars)`,
    );
    const rfMissing = await cdp.eval(swS, `T.request('a', 'cal/readFile', { uri: 'file:///nope/missing.h' })`);
    check('cal/readFile of a missing file returns null', rfMissing.result?.text === null);

    // 7. formatting uses tabs from .clang-format.
    const fmt = await cdp.eval(
      swS,
      `T.request('a', 'textDocument/formatting', { textDocument: { uri: '${uriA}' }, options: { tabSize: 2, insertSpaces: false } })`,
    );
    check(
      'formatting re-indents with tabs (.clang-format)',
      Array.isArray(fmt.result) &&
        fmt.result.some((e) => e.newText.includes('\t')) &&
        !fmt.result.some((e) => / {2}/.test(e.newText)),
      JSON.stringify(fmt.result),
    );

    // 8. Port B: cached initialize, own diagnostics, routing isolation.
    await cdp.eval(swS, `(T.open('b'), T.hello('b', ['-xc', '-std=gnu11', '-Wall', '-Wextra']), 'ok')`);
    const tB = Date.now();
    const initB = await cdp.eval(
      swS,
      `T.request('b', 'initialize', { processId: null, rootUri: 'file:///workspace', capabilities: {} })`,
    );
    check(
      'second port gets cached initialize result',
      JSON.stringify(initB.result) === JSON.stringify(init.result),
      `${Date.now() - tB} ms`,
    );
    await cdp.eval(swS, `T.notify('b', 'initialized', {})`);
    const uriB = 'file:///workspace/520502-c3d4.c';
    await cdp.eval(
      swS,
      `T.notify('b', 'textDocument/didOpen', { textDocument: { uri: '${uriB}', languageId: 'c', version: 1, text: ${JSON.stringify(SRC_B)} } })`,
    );
    const diagsB = await waitFor(
      async () => (await cdp.eval(swS, `T.diags('b', '${uriB}')`)).at(-1),
      30_000,
      'diagnostics B',
    );
    check(
      'port B receives its diagnostics',
      diagsB.diagnostics.some((d) => /undefined_name|undeclared/.test(d.message)),
      diagsB.diagnostics.map((d) => d.message).join(' | '),
    );
    const leakA = await cdp.eval(swS, `T.diags('a', '${uriB}').length`);
    const leakB = await cdp.eval(swS, `T.diags('b', '${uriA}').length`);
    check(
      'diagnostics are routed only to the owning port',
      leakA === 0 && leakB === 0,
      `a got ${leakA} of B's, b got ${leakB} of A's`,
    );
    const hoverB = await cdp.eval(
      swS,
      `T.request('b', 'textDocument/hover', { textDocument: { uri: '${uriB}' }, position: { line: 0, character: 4 } })`,
    );
    check(
      'requests on port B work (hover on f)',
      /function `f`/.test(JSON.stringify(hoverB.result ?? '')),
      JSON.stringify(hoverB.result?.contents ?? null).slice(0, 100),
    );

    // 9. Disconnect B → host sends didClose for its URI; A keeps working.
    await cdp.eval(swS, `(T.close('b'), 'ok')`);
    await sleep(500);
    const hover2 = await cdp.eval(
      swS,
      `T.request('a', 'textDocument/hover', { textDocument: { uri: '${uriA}' }, position: { line: 4, character: 3 } })`,
    );
    check('port A still works after port B disconnects', /printf/.test(JSON.stringify(hover2.result ?? '')));
    // After didClose clangd clears diagnostics for B's URI; nothing should reach A.
    const leakA2 = await cdp.eval(swS, `T.diags('a', '${uriB}').length`);
    check('no diagnostics for closed URI leak to A', leakA2 === 0);
    const errs = await cdp.eval(swS, `T.log.a.filter((e) => e.m.type === 'status' && e.m.status === 'error').length`);
    check('no error status during the run', errs === 0);

    await cdp.eval(swS, `(T.close('a'), 'ok')`);
    console.log(
      `\nclangd time to ready: ${(tReady / 1000).toFixed(2)} s (initialize result at ${(tInit / 1000).toFixed(2)} s)`,
    );
  } catch (e) {
    check('e2e run completed', false, e.stack ?? String(e));
    if (stderr) console.log(stderr.split('\n').slice(-20).join('\n'));
  } finally {
    cleanup();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

await main();
