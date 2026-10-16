// LSP e2e: harness page + real clangd, exercises providers via
// Monaco's internal _execute* commands, the header peek, reconnect and the options page.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const EXT = process.env.OUT_DIR ?? '/tmp/cal-dist-lsp';
//   node scripts/e2e-lsp.mjs   # builds with HARNESS=1 into $OUT_DIR, then tests
const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ` — ${String(info).slice(0, 400)}` : ''}`);
};
const freePort = () =>
  new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
const portBusy = (port) =>
  new Promise((res) => {
    const s = createServer();
    s.once('error', () => res(true));
    s.listen(port, '127.0.0.1', () => s.close(() => res(false)));
  });

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
        m.error ? rej(new Error(m.error.message)) : res(m.result);
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
}

async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch (e) {
      v = undefined;
    }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(250);
  }
}

import { execFileSync } from 'node:child_process';
execFileSync('node', [`${REPO}/scripts/build.mjs`], {
  stdio: 'inherit',
  env: { ...process.env, OUT_DIR: EXT, HARNESS: '1' },
});

let harness;
if (!(await portBusy(5179))) {
  const { startHarness } = await import(`${REPO}/test/harness/serve.mjs`);
  harness = await startHarness();
  console.log('started harness on 5179');
} else console.log('reusing harness already on 5179');

const port = await freePort();
const profile = mkdtempSync(join(tmpdir(), 'cal-e2e-lsp-'));
const browser = spawn(
  BROWSER,
  [
    '--headless=new',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    `--load-extension=${EXT}`,
    `--disable-extensions-except=${EXT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1400,1000',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const cleanup = () => {
  try {
    browser.kill('SIGKILL');
  } catch {}
  try {
    harness?.close();
  } catch {}
  setTimeout(() => rmSync(profile, { recursive: true, force: true }), 300);
};
process.on('exit', cleanup);

try {
  const version = await waitFor(
    () => fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()),
    20000,
    'devtools',
  );
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
  const targets = async () => (await cdp.send('Target.getTargets')).targetInfos;
  const sw = await waitFor(async () => (await targets()).find((t) => t.type === 'service_worker'), 10000, 'sw');
  const extId = new URL(sw.url).host;

  // --- topic page -----------------------------------------------------------------------
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: S } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const contexts = new Map();
  cdp.handlers.push((m) => {
    if (m.sessionId !== S) return;
    if (m.method === 'Runtime.executionContextCreated') contexts.set(m.params.context.id, m.params.context);
    if (m.method === 'Runtime.exceptionThrown')
      console.log(
        '  [exception]',
        m.params.exceptionDetails.exception?.description?.slice(0, 500) ?? m.params.exceptionDetails.text,
      );
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'log', 'info', 'debug'].includes(m.params.type))
      console.log(
        `  [page ${m.params.type}]`,
        m.params.args
          .map((a) => a.value ?? a.description)
          .join(' ')
          .slice(0, 300),
      );
  });
  await cdp.send('Runtime.enable', {}, S);
  await cdp.send('Page.enable', {}, S);
  await cdp.send('Page.navigate', { url: 'http://localhost:5179/cal/topic/1001' }, S);
  const iso = await waitFor(
    () =>
      [...contexts.values()].find(
        (c) => c.auxData?.type === 'isolated' && c.origin?.includes(extId) !== false && c.name?.includes('CYCU'),
      ),
    20000,
    'isolated world',
  );
  const ev = async (expr, ms = 60000) => {
    const r = await Promise.race([
      cdp.send(
        'Runtime.evaluate',
        { expression: `(async () => { ${expr} })()`, contextId: iso.id, awaitPromise: true, returnByValue: true },
        S,
      ),
      sleep(ms).then(() => ({ exceptionDetails: { text: 'timeout' } })),
    ]);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };

  console.log(
    '  contexts:',
    [...contexts.values()].map((c) => `${c.id}:${c.name}:${c.auxData?.type}:${c.origin}`).join(' | '),
  );
  console.log('  iso:', iso.id, iso.name);
  await waitFor(() => ev(`return !!globalThis.__calExt?.session?.lsp`), 30000, 'lsp session').catch(async (e) => {
    console.log(
      '  debug:',
      await ev(
        `return JSON.stringify({ ext: typeof globalThis.__calExt, s: !!globalThis.__calExt?.session, mon: globalThis.__calExt?.useMonaco, started: globalThis.__calExtStarted })`,
      ).catch(String),
    );
    throw e;
  });
  const PRE = `
    const M = __calExt.monaco; const ed = M.editor.getEditors()[0]; const model = ed.getModel();
    const cs = ed._commandService; const exec = (id, ...a) => cs.executeCommand(id, ...a);
    const P = (l, c) => new M.Position(l, c);
    const pill = () => [...document.querySelectorAll('.coding-toolbar *')].map(e => e.textContent).find(t => /clangd/i.test(t || ''));
  `;
  const t0 = Date.now();
  // Write a program below the locked lines (1-3).
  const SRC = [
    '#include <stdio.h>',
    '#include <stdlib.h>',
    '// 以上三行不可修改 (locked)',
    'struct point { int x; int y; };',
    'static int add(int a, int b) { return a + b; }',
    'int main(void) {',
    '\t/* 中文註解 😀 */ int x = "a";',
    '\tstruct point s;',
    '\tint total = add(1, 2);',
    '    printf("%d\\n", total + x + s.x);',
    '\treturn 0;',
    '}',
    '',
  ].join('\n');
  await ev(`${PRE}
    const full = model.getFullModelRange();
    const r = new M.Range(4, 1, full.endLineNumber, full.endColumn);
    ed.executeEdits('e2e', [{ range: r, text: ${JSON.stringify(SRC.split('\n').slice(3).join('\n'))} }]);
    return model.getValue();`);
  const val = await ev(`${PRE} return model.getValue();`);
  check('program written into Monaco', val === SRC, JSON.stringify(val.slice(0, 80)));

  const markers = await waitFor(
    () => ev(`${PRE} const m = M.editor.getModelMarkers({ owner: 'clangd' }); return m.length ? m : null;`),
    180000,
    'clangd markers',
  ).catch((e) => String(e));
  console.log(`  clangd ready + diagnostics after ${Date.now() - t0} ms`);
  const intConv = Array.isArray(markers) && markers.find((m) => /char|int/i.test(m.message) && m.startLineNumber === 7);
  check('diagnostics: int x = "a" marker on line 7', !!intConv, JSON.stringify(markers).slice(0, 300));
  if (intConv) {
    // CJK + emoji before `x`: UTF-16 columns must line up with Monaco.
    const line = SRC.split('\n')[6];
    check(
      'diagnostic column is UTF-16 correct',
      intConv.startColumn - 1 === line.indexOf('x =') || intConv.startColumn - 1 === line.indexOf('"a"'),
      `col ${intConv.startColumn}`,
    );
  }
  check(
    'status pill shows ready',
    /ready/i.test((await ev(`${PRE} return pill() || ''`)) ?? ''),
    await ev(`${PRE} return pill() || ''`),
  );

  const actions = await ev(`${PRE}
    const res = await exec('_executeCodeActionProvider', model.uri, new M.Range(7, 1, 7, 40), 'quickfix');
    return (res ?? []).map(a => a.title);`).catch((e) => String(e));
  check('code actions callable (fix-its, may be empty)', Array.isArray(actions), JSON.stringify(actions));

  // completion on s.
  const comp = await ev(`${PRE}
    ed.executeEdits('e2e', [{ range: new M.Range(10, 34, 10, 35), text: '' }]); // "s.x" -> "s."
    await new Promise(r => setTimeout(r, 50));
    const list = await exec('_executeCompletionItemProvider', model.uri, P(10, 34), '.');
    ed.executeEdits('e2e', [{ range: new M.Range(10, 34, 10, 34), text: 'x' }]);
    return list.suggestions.map(s => typeof s.label === 'string' ? s.label : s.label.label);`).catch((e) => String(e));
  check(
    'completion: s. lists struct members',
    Array.isArray(comp) && comp.includes('x') && comp.includes('y'),
    JSON.stringify(comp).slice(0, 200),
  );

  const compPf = await ev(`${PRE}
    const list = await exec('_executeCompletionItemProvider', model.uri, P(10, 9));
    const pf = list.suggestions.find(s => (s.filterText || s.label.label || s.label) .toString().startsWith('printf'));
    return pf && { label: pf.label, rules: pf.insertTextRules, insert: pf.insertText, kind: pf.kind, docType: typeof pf.documentation };`).catch(
    (e) => String(e),
  );
  check(
    'completion: printf is a snippet with trimmed label',
    compPf?.rules === 4 && !/^\s/.test(JSON.stringify(compPf.label).slice(1)),
    JSON.stringify(compPf),
  );

  const hover = await ev(`${PRE}
    const h = await exec('_executeHoverProvider', model.uri, P(10, 7));
    return h.flatMap(x => x.contents.map(c => c.value)).join('\\n');`).catch((e) => String(e));
  check(
    'hover: printf prototype',
    /printf/.test(hover) && /int/.test(hover),
    hover.slice(0, 160).replace(/\n/g, ' | '),
  );

  const sig = await ev(`${PRE}
    const s = await exec('_executeSignatureHelpProvider', model.uri, P(9, 19), '(');
    return s && s.signatures.map(x => x.label);`).catch((e) => String(e));
  check('signature help: add(int a, int b)', JSON.stringify(sig).includes('add('), JSON.stringify(sig));

  const syms = await ev(`${PRE}
    const s = await exec('_executeDocumentSymbolProvider', model.uri);
    return s.map(x => x.name + ':' + x.kind + ':' + (x.children?.length ?? 0));`).catch((e) => String(e));
  check(
    'outline: point, add, main',
    JSON.stringify(syms).includes('main') && JSON.stringify(syms).includes('add'),
    JSON.stringify(syms),
  );

  const folds = await ev(
    `${PRE} const f = await exec('_executeFoldingRangeProvider', model.uri); return f?.length ?? JSON.stringify(f);`,
  ).catch((e) => String(e));
  check('folding ranges returned', typeof folds === 'number' && folds > 0, folds);

  const hl = await ev(
    `${PRE} const h = await exec('_executeDocumentHighlights', model.uri, P(9, 7)); return h?.map(x => x.range.startLineNumber + ':' + x.kind);`,
  ).catch((e) => String(e));
  check('document highlights for `total`', Array.isArray(hl) && hl.length === 2, JSON.stringify(hl));

  const inlay = await ev(
    `${PRE} const h = await exec('_executeInlayHintProvider', model.uri, model.getFullModelRange()); return h.map(x => typeof x.label === 'string' ? x.label : x.label.map(p => p.label).join(''));`,
  ).catch((e) => String(e));
  check('inlay hints: parameter names for add(1, 2)', JSON.stringify(inlay).includes('a:'), JSON.stringify(inlay));

  const sem = await ev(`${PRE}
    const legend = await exec('_provideDocumentSemanticTokensLegend', model.uri);
    const t = await exec('_provideDocumentSemanticTokens', model.uri);
    return { types: legend?.tokenTypes?.length, bytes: t?.byteLength ?? t?.length };`).catch((e) => String(e));
  check('semantic tokens: legend + data', sem?.types > 0 && sem?.bytes > 0, JSON.stringify(sem));

  const links = await ev(
    `${PRE} const l = await exec('_executeLinkProvider', model.uri, 5); return l.map(x => String(x.url));`,
  ).catch((e) => String(e));
  check('document links for #include', JSON.stringify(links).includes('stdio.h'), JSON.stringify(links));

  const def = await ev(`${PRE}
    const local = await exec('_executeDefinitionProvider', model.uri, P(9, 15));
    const ext = await exec('_executeDefinitionProvider', model.uri, P(10, 7));
    const extUri = ext[0] && String(ext[0].uri);
    return { local: local.map(l => String(l.uri) === String(model.uri) && l.range.startLineNumber), extUri, extModel: !!(extUri && M.editor.getModel(ext[0].uri)), lines: extUri && M.editor.getModel(ext[0].uri)?.getLineCount() };`).catch(
    (e) => String(e),
  );
  check('definition: add -> line 5 of our model', JSON.stringify(def?.local) === '[5]', JSON.stringify(def));
  check(
    'definition: printf -> header model created via cal/readFile',
    def?.extModel === true && def?.lines > 10,
    JSON.stringify(def),
  );

  const refs = await ev(
    `${PRE} const r = await exec('_executeReferenceProvider', model.uri, P(9, 7)); return r.length;`,
  ).catch((e) => String(e));
  check('references for `total`', refs === 2, refs);

  // F12 on printf → peek widget with the header; main model unchanged.
  const peek = await ev(`${PRE}
    const before = String(model.uri);
    console.log('actions', ed.getSupportedActions().map(a => a.id).filter(i => /efinition|peek/i.test(i)).join(','));
    ed.setPosition(P(10, 7)); ed.focus();
    ed.trigger('e2e', 'editor.action.revealDefinition', {});
    await new Promise(r => setTimeout(r, 1500));
    const zone = document.querySelector('.peekview-widget');
    const title = zone?.querySelector('.peekview-title')?.textContent;
    const embedded = M.editor.getEditors().find(e => e !== ed && String(e.getModel()?.uri).includes('/usr/include'));
    const ro = embedded?.getOption(M.editor.EditorOption.readOnly);
    return { sameModel: String(ed.getModel().uri) === before, zone: !!zone, title, ro };`).catch((e) => String(e));
  check('F12 into header opens peek, main model unchanged', peek?.zone && peek?.sameModel, JSON.stringify(peek));
  check('peeked header editor is read-only', peek?.ro === true, JSON.stringify(peek));
  await ev(
    `${PRE} ed.trigger('e2e', 'closeReferenceSearch', {}); ed.trigger('e2e', 'closeMarkersNavigation', {}); document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'})); return 1;`,
  );

  // Link click (Cmd/Ctrl-click on stdio.h in #include) → opener → peek.
  const pos = await ev(`${PRE}
    ed.trigger('e2e','closeReferenceSearch',{});
    await new Promise(r => setTimeout(r, 300));
    ed.setPosition(P(4, 1));
    const v = ed.getScrolledVisiblePosition(P(1, 13)); const rect = ed.getDomNode().getBoundingClientRect();
    return { x: rect.left + v.left + 2, y: rect.top + v.top + v.height / 2, zones: document.querySelectorAll('.peekview-widget').length };`);
  // isolated world coordinates are page coordinates
  await cdp.send(
    'Input.dispatchKeyEvent',
    { type: 'rawKeyDown', key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, modifiers: 4 },
    S,
  );
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x - 5, y: pos.y, modifiers: 4 }, S);
  await sleep(200);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y, modifiers: 4 }, S);
  await sleep(500);
  console.log(
    '  link decorations:',
    await ev(
      `return [document.querySelectorAll('.detected-link').length, document.querySelectorAll('.detected-link-active').length, JSON.stringify(${JSON.stringify(pos)})]`,
    ),
  );
  for (const type of ['mousePressed', 'mouseReleased'])
    await cdp.send(
      'Input.dispatchMouseEvent',
      {
        type,
        x: pos.x,
        y: pos.y,
        button: 'left',
        buttons: type === 'mousePressed' ? 1 : 0,
        clickCount: 1,
        modifiers: 4,
      },
      S,
    );
  await cdp.send(
    'Input.dispatchKeyEvent',
    { type: 'keyUp', key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, modifiers: 0 },
    S,
  );
  await sleep(1500);
  const linkPeek = await ev(
    `${PRE} return { zones: document.querySelectorAll('.peekview-widget').length, title: document.querySelector('.peekview-widget .peekview-title')?.textContent, uri: String(model.uri) };`,
  );
  check(
    'Cmd-click #include link opens header peek',
    linkPeek.zones > 0 && /stdio/.test(linkPeek.title ?? ''),
    JSON.stringify(linkPeek),
  );
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, S);
  writeFileSync('/tmp/cal-e2e-lsp/peek.png', Buffer.from(shot.data, 'base64'));
  await ev(`${PRE} ed.trigger('e2e','closeReferenceSearch',{}); return 1;`);

  // Rename
  const ren = await ev(`${PRE}
    const pr = await exec('_executePrepareRename', model.uri, P(9, 7));
    const we = await exec('_executeDocumentRenameProvider', model.uri, P(9, 7), 'sum');
    return { pr: pr && pr.text, n: we?.edits?.length, reject: we?.rejectReason };`).catch((e) => String(e));
  check('rename total -> sum gives 2 edits', ren?.n === 2 && !ren.reject, JSON.stringify(ren));

  const fix = await ev(`${PRE}
    ed.executeEdits('e2e', [{ range: new M.Range(9, 1, 9, 1), text: '\\tif (total = 3) {}\\n' }]);
    // the line above inserts before "int total", so use a fresh var name scope: put after instead
    ed.trigger('e2e', 'undo', {});
    const ln = model.getLinesContent().findIndex(l => l.includes('int total')) + 2;
    ed.executeEdits('e2e', [{ range: new M.Range(ln, 1, ln, 1), text: '\\tif (total = 3) {}\\n' }]);
    let mk;
    for (let i = 0; i < 40 && !mk; i++) { await new Promise(r => setTimeout(r, 250)); mk = M.editor.getModelMarkers({ owner: 'clangd' }).find(m => m.startLineNumber === ln); }
    const acts = mk ? await exec('_executeCodeActionProvider', model.uri, new M.Range(mk.startLineNumber, mk.startColumn, mk.endLineNumber, mk.endColumn), 'quickfix') : [];
    const out = { marker: mk?.message, actions: (acts ?? []).map(a => a.title + ' edits=' + (a.edit?.edits?.length ?? 0)) };
    ed.executeEdits('e2e', [{ range: new M.Range(ln, 1, ln + 1, 1), text: '' }]);
    return out;`).catch(String);
  check(
    'quick fix: clang fix-it offered as code action with edits',
    fix?.actions?.some((a) => /edits=[1-9]/.test(a)),
    JSON.stringify(fix),
  );
  // Formatting: messy line → tabs; locked lines untouched.
  const fmt = await ev(`${PRE}
    const edits = await exec('_executeFormatDocumentProvider', model.uri, { tabSize: 2, insertSpaces: false });
    return (edits ?? []).map(e => [e.range.startLineNumber, e.range.endLineNumber, JSON.stringify(e.text)]);`).catch(
    (e) => String(e),
  );
  check(
    'formatting: edits returned, none on locked lines 1-3',
    Array.isArray(fmt) && fmt.length > 0 && fmt.every((e) => e[0] > 3 || (e[1] > 3 && e[0] >= 3)),
    JSON.stringify(fmt).slice(0, 300),
  );
  const fmtLine = await ev(`${PRE}
    await ed.getAction('editor.action.formatDocument').run();
    await new Promise(r => setTimeout(r, 500));
    return model.getLinesContent().find(l => l.includes('printf('));`).catch((e) => String(e));
  check('formatDocument indents printf line with a tab', /^\tprintf/.test(fmtLine), JSON.stringify(fmtLine));

  // --- reconnect: kill offscreen doc ------------------------------------------------------
  const off = (await targets()).find((t) => t.url.includes('offscreen'));
  if (off) {
    await cdp.send('Target.closeTarget', { targetId: off.targetId });
    console.log('  closed offscreen document');
    await sleep(1000);
    console.log('  offscreen targets now:', (await targets()).filter((t) => t.url.includes('offscreen')).length);
    const { sessionId: swS } = await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
    const r = await cdp.send(
      'Runtime.evaluate',
      {
        expression: `chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}).then(c => c.length)`,
        awaitPromise: true,
        returnByValue: true,
      },
      swS,
    );
    console.log('  SW sees offscreen contexts:', JSON.stringify(r.result?.value ?? r));
    console.log(
      '  probe port:',
      await ev(
        `return await new Promise(res => { const p = chrome.runtime.connect({name:'cal-lsp'}); let n=[]; p.onMessage.addListener(m => n.push(m.type+':'+(m.status||''))); p.onDisconnect.addListener(() => res('disconnected ' + JSON.stringify(n) + ' ' + chrome.runtime.lastError?.message)); p.postMessage({type:'hello', compileFlags:[]}); setTimeout(() => { p.disconnect(); res('alive ' + JSON.stringify(n)); }, 3000); });`,
      ).catch(String),
    );
    const t1 = Date.now();
    const poll = setInterval(
      async () => console.log('   pill:', await ev(`${PRE} return pill()`, 5000).catch(String)),
      3000,
    );
    const hover2 = await waitFor(
      () =>
        ev(
          `${PRE} const ln = model.getLinesContent().findIndex(l => l.includes('printf(')) + 1; const h = await exec('_executeHoverProvider', model.uri, P(ln, model.getLineContent(ln).indexOf('printf') + 2)); const s = h.flatMap(x => x.contents.map(c => c.value)).join(' '); return /printf/.test(s) ? s : null;`,
          20000,
        ),
      45000,
      'hover after reconnect',
    ).catch((e) => String(e));
    clearInterval(poll);
    check('reconnect after offscreen restart: hover works again', /printf/.test(hover2), `${Date.now() - t1} ms`);
    const m2 = await waitFor(
      () => ev(`${PRE} const m = M.editor.getModelMarkers({ owner: 'clangd' }); return m.length || null;`),
      60000,
      'markers',
    ).catch(() => 0);
    check('reconnect: diagnostics republished', m2 > 0, m2);
  } else check('offscreen target found for reconnect test', false);

  // --- options page -----------------------------------------------------------------------
  const { targetId: optT } = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${extId}/src/options/options.html`,
  });
  const { sessionId: O } = await cdp.send('Target.attachToTarget', { targetId: optT, flatten: true });
  await cdp.send('Page.enable', {}, O);
  await cdp.send('Runtime.enable', {}, O);
  const dialogs = [];
  cdp.handlers.push((m) => {
    if (m.sessionId === O && m.method === 'Page.javascriptDialogOpening') {
      dialogs.push(m.params.message);
      void cdp.send('Page.handleJavaScriptDialog', { accept: dialogs.length > 1 }, O);
    }
  });
  const evO = async (expr) => {
    const r = await cdp.send(
      'Runtime.evaluate',
      { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true },
      O,
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  await waitFor(
    () =>
      evO(
        `return document.querySelectorAll('[data-feature]').length === 13 && document.getElementById('compileFlags').value.includes('-std')`,
      ),
    10000,
    'options rendered',
  );
  const optInfo = await evO(
    `return { n: document.querySelectorAll('[data-feature]').length, models: [...document.querySelectorAll('#slmModel .model')].map(o => o.textContent), flags: document.getElementById('compileFlags').value };`,
  );
  check(
    'options: 13 feature toggles, models with sizes, flags',
    optInfo.n === 13 && optInfo.models.every((t) => /MB|GB/.test(t)),
    JSON.stringify(optInfo),
  );
  // inlineCompletion: first confirm dismissed -> stays off; second accepted -> on
  await evO(`document.getElementById('feature-inlineCompletion').click(); return 1;`);
  await sleep(300);
  const afterDismiss = await evO(`return document.getElementById('feature-inlineCompletion').checked`);
  await evO(`document.getElementById('feature-inlineCompletion').click(); return 1;`);
  await sleep(300);
  const afterAccept = await evO(`return document.getElementById('feature-inlineCompletion').checked`);
  check(
    'options: enabling SLM asks to confirm the download size',
    dialogs.length === 2 && /400 MB/.test(dialogs[0]) && !afterDismiss && afterAccept,
    JSON.stringify({ dialogs, afterDismiss, afterAccept }),
  );
  await evO(`document.getElementById('feature-inlineCompletion').click(); return 1;`); // back off

  // toggle diagnostics + hover off (autosaved) → live in page
  await evO(
    `document.getElementById('feature-diagnostics').click(); document.getElementById('feature-hover').click(); return 1;`,
  );
  await sleep(800);
  const saved = await evO(
    `return { status: document.getElementById('status').textContent, s: (await chrome.storage.sync.get('settings')).settings.features }`,
  );
  check(
    'options: toggles autosave',
    saved.status === 'Saved' && saved.s.diagnostics === false && saved.s.hover === false,
    JSON.stringify(saved),
  );
  const live = await ev(`${PRE}
    await new Promise(r => setTimeout(r, 500));
    const ln = model.getLinesContent().findIndex(l => l.includes('printf(')) + 1;
    const h = await exec('_executeHoverProvider', model.uri, P(ln, model.getLineContent(ln).indexOf('printf') + 2));
    return { markers: M.editor.getModelMarkers({ owner: 'clangd' }).length, hover: h.length };`);
  check(
    'toggles apply live: markers cleared, hover provider gone',
    live.markers === 0 && live.hover === 0,
    JSON.stringify(live),
  );
  await evO(
    `document.getElementById('feature-diagnostics').click(); document.getElementById('feature-hover').click(); return 1;`,
  );
  const back = await waitFor(
    () => ev(`${PRE} const n = M.editor.getModelMarkers({ owner: 'clangd' }).length; return n || null;`),
    15000,
    'markers back',
  ).catch(() => 0);
  check('re-enabling diagnostics restores markers', back > 0, back);
  const oshot = await cdp.send('Page.captureScreenshot', { format: 'png' }, O);
  writeFileSync('/tmp/cal-e2e-lsp/options.png', Buffer.from(oshot.data, 'base64'));
} catch (e) {
  check('e2e run', false, e.stack);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
cleanup();
process.exit(failed ? 1 : 0);
