// End-to-end test of the page integration (Monaco over Ace) against the local harness.
//
//   node scripts/e2e-page.mjs            # build into /tmp/cal-dist-page (HARNESS=1) and test
//   SKIP_BUILD=1 node scripts/e2e-page.mjs
//
// Launches a separate headless Brave with a fresh profile and drives it over CDP with real input
// events (Input.insertText / dispatchKeyEvent / dispatchMouseEvent). Never touches port 9222 or
// the real site. Screenshots go to /tmp/cal-page-*.png.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HTTPS_PORT, PRECODE, startHarness } from '../test/harness/serve.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = '/tmp/cal-dist-page';
const BRAVE = process.env.BRAVE ?? '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const BASE = 'http://localhost:5179/cal/topic/1001';
const DRAFT_KEY = 'cal_draft:u42:1001';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  — ${info}` : ''}`);
}

// ---------------------------------------------------------------------------
// CDP plumbing
// ---------------------------------------------------------------------------

class CDP {
  #id = 0;
  #pending = new Map();
  #handlers = new Map();
  constructor(ws) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) {
        const p = this.#pending.get(m.id);
        this.#pending.delete(m.id);
        if (m.error) p?.reject(new Error(`${p.method}: ${m.error.message}`));
        else p?.resolve(m.result);
      } else {
        for (const h of this.#handlers.get(m.method) ?? []) h(m.params, m.sessionId);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, fail) => {
      ws.addEventListener('open', ok, { once: true });
      ws.addEventListener('error', fail, { once: true });
    });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.#id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject, method }));
  }
  on(method, fn) {
    if (!this.#handlers.has(method)) this.#handlers.set(method, []);
    this.#handlers.get(method).push(fn);
  }
}

function freePort() {
  return new Promise((ok) => {
    const s = createServer();
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

async function waitFor(fn, { timeout = 15000, interval = 100, label = 'condition' } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (!process.env.SKIP_BUILD) {
  console.log('building…');
  const r = spawnSync(process.execPath, [join(root, 'scripts/build.mjs')], {
    cwd: root,
    env: { ...process.env, OUT_DIR, HARNESS: '1' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (r.status !== 0) {
    console.error('build failed');
    process.exit(1);
  }
}

// Other slices may already be serving the same harness on :5179 — reuse it if so.
let server = null;
try {
  server = await startHarness();
} catch (err) {
  if (err.code !== 'EADDRINUSE') throw err;
  const html = await fetch(BASE).then((r) => r.text(), () => '');
  if (!html.includes('HAND-WRITTEN mock')) throw err;
  console.log('reusing harness server already listening on :5179');
}
let httpsServer = null;
try {
  const dir = mkdtempSync(join(tmpdir(), 'cal-page-tls-'));
  spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  httpsServer = await startHarness(HTTPS_PORT, { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) });
  rmSync(dir, { recursive: true, force: true });
} catch (err) {
  console.warn('https harness unavailable:', err.message);
}
const port = await freePort();
const profile = mkdtempSync(join(tmpdir(), 'cal-page-e2e-'));
const brave = spawn(
  BRAVE,
  [
    '--headless=new',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    `--load-extension=${OUT_DIR}`,
    `--disable-extensions-except=${OUT_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1400,900',
    '--ignore-certificate-errors', // self-signed https harness only
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let exitCode = 1;
const errors = [];
try {
  const version = await waitFor(
    async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).json(),
    { label: 'Brave DevTools endpoint' },
  );
  const cdp = await CDP.connect(version.webSocketDebuggerUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => cdp.send(m, p, sid);

  const contexts = new Map();
  cdp.on('Runtime.executionContextCreated', ({ context }, s) => s === sid && contexts.set(context.id, context));
  cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }, s) => s === sid && contexts.delete(executionContextId));
  cdp.on('Runtime.executionContextsCleared', (_p, s) => s === sid && contexts.clear());
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: d }, s) => {
    if (s === sid) errors.push(`exception: ${d.exception?.description ?? d.text}`);
  });
  cdp.on('Runtime.consoleAPICalled', ({ type, args }, s) => {
    if (s === sid && (type === 'error' || type === 'warning'))
      errors.push(`console.${type}: ${args.map((a) => a.value ?? a.description).join(' ')}`);
  });
  await S('Runtime.enable');
  await S('Page.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });

  const evalIn = async (expression, contextId) => {
    const r = await S('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const page = (expr) => evalIn(expr); // MAIN world (page)
  const extCtx = () =>
    [...contexts.values()].find((c) => c.auxData?.type === 'isolated' && c.origin?.startsWith('chrome-extension://'));
  const ext = async (expr) => {
    const c = await waitFor(extCtx, { label: 'extension isolated world' });
    return evalIn(expr, c.id);
  };

  const navigate = async (url) => {
    const loaded = new Promise((ok) => cdp.on('Page.loadEventFired', (_p, s) => s === sid && ok()));
    await S('Page.navigate', { url });
    await loaded;
    await waitFor(() => ext('!!globalThis.__calExt?.session'), { label: 'Monaco session', timeout: 20000 });
    await sleep(300);
  };
  const insertText = (text) => S('Input.insertText', { text });
  const key = async (k, { code = k, keyCode, modifiers = 0, text } = {}) => {
    const base = { key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
    await S('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, text });
    await S('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };
  const click = async (selector) => {
    const r = await page(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased'])
      await S('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
  };
  const shot = async (file) => {
    const { data } = await S('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`      screenshot ${file}`);
  };
  const model = () => ext('__calExt.session.model.getValue()');
  const ace = () => page('editor.getValue()');
  const focusAt = (line, col) =>
    ext(`(() => { const e = __calExt.session.editor; e.focus(); e.setPosition({ lineNumber: ${line}, column: ${col} }); return true; })()`);
  const lineEnd = (line) => ext(`__calExt.session.model.getLineMaxColumn(${line})`);

  // ---- 1. mount ----------------------------------------------------------
  await navigate(BASE);
  const mounted = await page(`(() => ({
    host: !!document.querySelector('#coding > .cal-monaco-host .monaco-editor'),
    afterEditor: document.getElementById('editor').nextElementSibling?.classList.contains('cal-monaco-host'),
    aceVis: getComputedStyle(document.getElementById('editor')).visibility,
    toolbar: !!document.querySelector('.coding-toolbar > .cal-ext-toolbar'),
    outsideButtons: !document.querySelector('#button-container .cal-ext-toolbar'),
  }))()`);
  check('Monaco mounted after #editor inside #coding', mounted.host && mounted.afterEditor, JSON.stringify(mounted));
  check('Ace hidden (visibility:hidden)', mounted.aceVis === 'hidden');
  check('toolbar in .coding-toolbar, outside #button-container', mounted.toolbar && mounted.outsideButtons);
  check('initial Monaco text equals Ace', (await model()) === (await ace()));
  const rects = await page(`(() => { const a = document.getElementById('editor').getBoundingClientRect(); const m = document.querySelector('.cal-monaco-host').getBoundingClientRect(); return [a.x, a.y, a.width, a.height, m.x, m.y, m.width, m.height].map(Math.round); })()`);
  check('Monaco host overlays #editor exactly', rects.slice(0, 4).join() === rects.slice(4).join(), rects.join(','));
  const font = await ext(`__calExt.session.editor.getOption(__calExt.monaco.editor.EditorOption.fontInfo)`);
  check('font: --cal-font-mono at 16px', font.fontSize === 16 && /cal-font-mono/.test(font.fontFamily), `${font.fontFamily} ${font.fontSize}px w=${font.typicalHalfwidthCharacterWidth}`);
  const opts = await ext(`(() => { const e = __calExt.session.editor, O = __calExt.monaco.editor.EditorOption, m = __calExt.session.model.getOptions(); return { tab: m.tabSize, spaces: m.insertSpaces, dnd: e.getOption(O.dragAndDrop) }; })()`);
  check('tabSize 2, hard tabs, no drag&drop', opts.tab === 2 && !opts.spaces && !opts.dnd, JSON.stringify(opts));

  // ---- 2. typing → Ace + draft --------------------------------------------
  await focusAt(5, 2);
  await insertText('printf("hi");');
  await sleep(350);
  const [m2, a2, d2] = [await model(), await ace(), await page(`localStorage.getItem(${JSON.stringify(DRAFT_KEY)})`)];
  check('typing reaches Monaco', m2.includes('printf("hi");'));
  check('typing syncs to Ace getValue()', m2 === a2);
  check('typing updates localStorage draft', d2 === m2);

  // ---- 3. RUN immediately after typing ----------------------------------
  await insertText(' int run1;');
  const aceBefore = await ace();
  await click('#submitbtn');
  await sleep(50);
  const run1 = await page('window.__runs.at(-1)');
  const m3 = await model();
  check('RUN right after typing submits latest text', run1 === m3 && m3.includes('int run1;'), aceBefore === m3 ? '(debounce had already fired)' : '(Ace was stale before click)');

  // ---- 4. Cmd/Ctrl-Enter --------------------------------------------------
  await focusAt(5, await lineEnd(5));
  await insertText(' int run2;');
  const runsBefore = await page('window.__runs.length');
  await key('Enter', { keyCode: 13, modifiers: process.platform === 'darwin' ? 4 : 2 });
  await sleep(100);
  const runsAfter = await page('window.__runs.length');
  const run2 = await page('window.__runs.at(-1)');
  check('Cmd/Ctrl-Enter clicks RUN with latest text', runsAfter === runsBefore + 1 && run2 === (await model()) && run2.includes('int run2;'));

  // ---- 5. locks ---------------------------------------------------------------
  const locked0 = await model();
  const locks = await ext('__calExt.session.guard.getLocks()');
  check('locks received from arr2', locks.length === 1 && locks[0].start.row === 0 && locks[0].end.row === 2, JSON.stringify(locks));
  const deco = await page(`document.querySelectorAll('.cal-locked-line').length`);
  check('locked lines decorated', deco >= 3, `${deco} line decorations`);
  await focusAt(1, 1);
  await insertText('X');
  await key('a', { keyCode: 65, text: 'a' });
  await sleep(50);
  check('typing inside lock rejected', (await model()) === locked0 && (await ace()) === locked0, JSON.stringify([locked0.slice(0, 60), (await model()).slice(0, 60), (await ace()).slice(0, 60)]));
  await focusAt(2, 5);
  await key('Enter', { keyCode: 13, text: '\r' });
  await key('Delete', { keyCode: 46 });
  await sleep(50);
  check('Enter/Delete inside lock rejected', (await model()) === locked0);
  await focusAt(3, await lineEnd(3));
  await key('Backspace', { keyCode: 8 });
  await sleep(50);
  check('Backspace at lock end rejected', (await model()) === locked0);
  // Site rule: an empty caret just after the lock does not intersect it, so Ace allows this.
  await focusAt(4, 1);
  await key('Backspace', { keyCode: 8 });
  await sleep(50);
  const joined = await model();
  await ext(`__calExt.session.editor.trigger('test', 'undo', null)`);
  await sleep(50);
  check('Backspace at start of the line after a lock allowed (mirrors Ace), undo restores', joined !== locked0 && (await model()) === locked0);
  await focusAt(3, await lineEnd(3));
  await key('Enter', { keyCode: 13, text: '\r' });
  await sleep(50);
  const afterEnter = await model();
  check('Enter at lock end allowed (site rule)', afterEnter !== locked0 && afterEnter.split('\n').length === locked0.split('\n').length + 1);
  await ext(`__calExt.session.editor.trigger('test', 'undo', null)`);
  await sleep(50);
  check('undo of allowed edit works', (await model()) === locked0);
  await focusAt(5, 2);
  await key('a', { keyCode: 65, modifiers: process.platform === 'darwin' ? 4 : 2 });
  const sel = await ext('__calExt.session.editor.getSelection().toString()');
  await insertText('Z');
  await sleep(50);
  check('select-all + type rejected', (await model()) === locked0 && (await ace()) === locked0, `selection ${sel}`);
  await key('a', { keyCode: 65, text: 'a' });
  await key('Backspace', { keyCode: 8 });
  await sleep(50);
  check('select-all + key / Backspace rejected', (await model()) === locked0);
  await ext(`(() => { const e = __calExt.session.editor; e.focus(); e.setSelections([new __calExt.monaco.Selection(5, 2, 5, 2), new __calExt.monaco.Selection(1, 1, 1, 1)]); })()`);
  await insertText('M');
  await sleep(50);
  check('multi-cursor touching lock rejected', (await model()) === locked0);
  await ext(`(() => { const e = __calExt.session.editor; e.setPosition({ lineNumber: 2, column: 3 }); e.trigger('keyboard', 'paste', { text: 'PASTE' }); e.trigger('keyboard', 'editor.action.deleteLines', null); })()`);
  await sleep(100);
  check('paste / delete-line commands in lock reverted (safety net)', (await model()) === locked0 && (await ace()) === locked0);
  await ext(`(() => { const e = __calExt.session.editor; e.setPosition({ lineNumber: 1, column: 1 }); e.trigger('keyboard', 'type', { text: 'IME' }); })()`);
  await sleep(100);
  check('programmatic type in lock reverted', (await model()) === locked0);

  // IME composition (Input.imeSetComposition + commit)
  const ime = async (line, col) => {
    await focusAt(line, col);
    await S('Input.imeSetComposition', { text: 'ㄓ', selectionStart: 1, selectionEnd: 1 });
    await S('Input.imeSetComposition', { text: 'ㄓㄨㄥ', selectionStart: 3, selectionEnd: 3 });
    await insertText('中');
    await sleep(150);
  };
  await ime(2, 3);
  check('IME composition inside lock reverted', (await model()) === locked0 && (await ace()) === locked0);
  await ime(5, 2);
  await sleep(200);
  check('IME composition outside lock commits and syncs (CJK)', (await model()).includes('\t中') && (await ace()) === (await model()));

  // ---- 6. reset ------------------------------------------------------------------
  await click('#reset-button');
  await waitFor(async () => (await model()) === PRECODE, { label: 'Monaco shows precode after reset' }).then(
    () => check('reset updates Monaco', true),
    (e) => check('reset updates Monaco', false, e.message),
  );
  check('reset: Ace and Monaco agree', (await ace()) === PRECODE);
  check('locks re-read after reset', (await ext('__calExt.session.guard.getLocks().length')) === 1);
  // Lock changes without a text change: picked up by the poll; initializeForbiddenAreas() is wrapped.
  check('page initializeForbiddenAreas() wrapped', await page('window.initializeForbiddenAreas.__calWrapped === true'));
  await page('arr2.push(new Range(6, 0, 6, 3)); arrE.push(arr2[arr2.length - 1].end); true');
  await waitFor(async () => (await ext('__calExt.session.guard.getLocks().length')) === 2, { label: 'polled locks', timeout: 3000 }).then(
    () => check('lock change picked up by poll', true),
    () => check('lock change picked up by poll', false),
  );
  await page('initializeForbiddenAreas(); true');
  await sleep(150); // well under the 1 s poll: must come from the wrapper
  check('initializeForbiddenAreas() → locks re-sent immediately', (await ext('__calExt.session.guard.getLocks().length')) === 1);
  await focusAt(5, 2);
  await insertText('int afterReset;');
  await sleep(300);
  check('editing after reset still syncs (re-initialised Ace)', (await ace()) === (await model()) && (await ace()).includes('afterReset'));

  // ---- 7. editor worker + icons (suggest widget) --------------------------------
  await focusAt(5, await lineEnd(5));
  await insertText('\n\tprin');
  await ext(`__calExt.session.editor.trigger('test', 'editor.action.triggerSuggest', {})`);
  const rows = await waitFor(() => page(`document.querySelectorAll('.suggest-widget .monaco-list-row').length`), { label: 'suggest rows', timeout: 5000 }).catch(() => 0);
  check('suggest widget opens', rows > 0, `${rows} rows`);
  check('editor worker (blob → importScripts) answered on http', (await ext('__calExt.editorWorkerState()')) === 'ok');
  const iconFont = await page(`(() => { const i = document.querySelector('.suggest-widget .codicon'); return i ? getComputedStyle(i, '::before').fontFamily : null; })()`);
  const fontOk = await page(`document.fonts.check('16px codicon')`);
  check('codicon font available', fontOk && /codicon/.test(iconFont ?? ''), `${iconFont}`);
  await shot('/tmp/cal-page-suggest.png');
  await key('Escape', { keyCode: 27 });

  // ---- 8. read-only mirroring ------------------------------------------------------
  await page('editor.setReadOnly(true)');
  await waitFor(() => ext(`__calExt.session.editor.getOption(__calExt.monaco.editor.EditorOption.readOnly)`), { label: 'readOnly', timeout: 3000 }).then(
    () => check('Ace setReadOnly(true) → Monaco read-only', true),
    () => check('Ace setReadOnly(true) → Monaco read-only', false),
  );
  await page('editor.setReadOnly(false)');
  await sleep(200);

  // ---- 9. Ace toggle --------------------------------------------------------------
  await shot('/tmp/cal-page-monaco.png');
  await click('.cal-ext-toolbar .cal-ext-btn');
  await sleep(300);
  const tog = await page(`(() => ({ host: document.querySelector('.cal-monaco-host').hidden, vis: getComputedStyle(document.getElementById('editor')).visibility, label: document.querySelector('.cal-ext-toolbar .cal-ext-btn').textContent.trim() }))()`);
  const stored = await ext(`chrome.storage.sync.get('settings').then((r) => r.settings?.useMonaco)`);
  check('toggle → Ace visible, Monaco hidden', tog.host && tog.vis === 'visible' && tog.label === 'Ace', JSON.stringify(tog));
  check('toggle persists settings.useMonaco=false', stored === false);
  await page('editor.focus(); editor.gotoLine(5, 1)');
  await insertText('/*ace*/');
  await sleep(100);
  check('typing in Ace updates hidden Monaco model', (await model()) === (await ace()) && (await model()).includes('/*ace*/'));
  await shot('/tmp/cal-page-ace.png');
  await click('.cal-ext-toolbar .cal-ext-btn');
  await sleep(300);
  const back = await page(`(() => ({ host: document.querySelector('.cal-monaco-host').hidden, vis: getComputedStyle(document.getElementById('editor')).visibility }))()`);
  check('toggle back → Monaco visible again', !back.host && back.vis === 'hidden' && (await ext(`chrome.storage.sync.get('settings').then((r) => r.settings?.useMonaco)`)) === true);

  // ---- 9b. settings changed elsewhere (options page) apply live --------------------------
  const setSettings = (patch) =>
    ext(`chrome.storage.sync.get('settings').then((r) => chrome.storage.sync.set({ settings: { ...(r.settings ?? {}), ...${JSON.stringify(patch)} } }))`);
  await setSettings({ theme: 'dark', minimap: true });
  await sleep(300);
  const dark = await page(`(() => ({ dark: !!document.querySelector('.cal-monaco-host .monaco-editor.vs-dark'), minimap: !!document.querySelector('.cal-monaco-host .minimap canvas') }))()`);
  check('settings change → dark theme + minimap live', dark.dark && dark.minimap, JSON.stringify(dark));
  await shot('/tmp/cal-page-dark.png');
  await setSettings({ theme: 'light', minimap: false, useMonaco: false });
  await sleep(300);
  check('settings useMonaco=false from elsewhere → Ace shown', await page(`document.querySelector('.cal-monaco-host').hidden && getComputedStyle(document.getElementById('editor')).visibility === 'visible'`));
  await setSettings({ useMonaco: true });
  await sleep(300);
  check('settings useMonaco=true → Monaco back', await page(`!document.querySelector('.cal-monaco-host').hidden`));

  // ---- 10. ?passed=1 read-only -------------------------------------------------------
  await navigate(`${BASE}?passed=1`);
  const ro = await ext(`__calExt.session.editor.getOption(__calExt.monaco.editor.EditorOption.readOnly)`);
  const bg = await page(`getComputedStyle(document.querySelector('.cal-monaco-host .monaco-editor-background')).backgroundColor`);
  const before = await model();
  await focusAt(5, 1);
  await insertText('nope');
  await key('a', { keyCode: 65, text: 'a' });
  await sleep(100);
  check('?passed=1 → Monaco read-only', ro === true && (await model()) === before && (await ace()) === before);
  check('read-only background #e6e6e6', bg === 'rgb(230, 230, 230)', bg);
  check('toolbar visible although #button-container hidden', await page(`!!document.querySelector('.cal-ext-toolbar').offsetParent`));
  await focusAt(5, 1);
  await key('Enter', { keyCode: 13, modifiers: process.platform === 'darwin' ? 4 : 2 });
  await sleep(100);
  check('Cmd-Enter does not RUN while read-only', (await page('window.__runs.length')) === 0);
  await shot('/tmp/cal-page-passed.png');

  // ---- 11. https origin: editor worker still loads ------------------------------------
  if (httpsServer) {
    await navigate(`https://127.0.0.1:${HTTPS_PORT}/cal/topic/2002`).catch(async (err) => {
      throw new Error(`${err.message}; page=${await page('location.href + " | " + document.title + " | " + document.body.innerText.slice(0, 120)')}`);
    });
    await focusAt(5, 2);
    await insertText('in');
    await ext(`__calExt.session.editor.trigger('test', 'editor.action.triggerSuggest', {})`);
    const st = await waitFor(async () => ((await ext('__calExt.editorWorkerState()')) === 'pending' ? false : ext('__calExt.editorWorkerState()')), { label: 'https worker', timeout: 8000 }).catch(() => 'pending');
    check('editor worker answered on an https origin', st === 'ok', st);
  } else {
    check('editor worker answered on an https origin', false, 'openssl not available, https harness not started');
  }

  const relevant = errors.filter((e) => !/favicon|Failed to load resource|ERR_/.test(e));
  check('no page/extension errors logged', relevant.length === 0, relevant.slice(0, 5).join(' | '));
  exitCode = results.every((r) => r.ok) ? 0 : 1;
  cdp.ws.close();
} catch (err) {
  console.error('E2E aborted:', err);
  console.error(errors.slice(0, 20).join('\n'));
} finally {
  brave.kill('SIGTERM');
  for (const srv of [server, httpsServer]) {
    srv?.closeAllConnections?.();
    srv?.close();
  }
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(exitCode);
