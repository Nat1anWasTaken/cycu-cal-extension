// Real-inference end-to-end test of the local SLM (src/slm/host.ts) inside the offscreen document.
//
//   node scripts/e2e-slm.mjs            # build into /tmp/cal-dist-slm, then test
//   SKIP_BUILD=1 node scripts/e2e-slm.mjs
//   MODEL=qwen2.5-coder-1.5b node scripts/e2e-slm.mjs
//   OFFLINE=1 node scripts/e2e-slm.mjs   # offline build bundling MODEL; Hugging Face is unreachable, nothing may download
//
// Launches a separate headless Brave with a fresh temp profile and the built extension,
// connects SLM_PORT from the background service worker (an extension context, so the
// connection reaches the offscreen document), loads the model (real Hugging Face download on
// the first run, ~400 MB for 0.5B), runs FIM completions, then relaunches the browser on the
// same profile to check that the model is served from the OPFS cache.

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.OUT_DIR || '/tmp/cal-dist-slm';
const MODEL = process.env.MODEL || 'qwen2.5-coder-0.5b';
const PORT = Number(process.env.CDP_PORT || 9357);
const OFFLINE = process.env.OFFLINE === '1';
const BRAVE = process.env.BRAVE || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ` - ${info}` : ''}`);
};

if (!process.env.SKIP_BUILD) {
  execFileSync('node', [join(root, 'scripts/build.mjs'), ...(OFFLINE ? [`--offline=${MODEL}`] : [])], { stdio: 'inherit', env: { ...process.env, OUT_DIR } });
}

async function cdp(wsUrl, label) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else if (m.method === 'Runtime.consoleAPICalled' && label) {
      const text = m.params.args.map((a) => a.value ?? a.description).join(' ');
      if (m.params.type === 'error' || m.params.type === 'warning') console.log(`  [${label} ${m.params.type}] ${text.slice(0, 300)}`);
    } else if (m.method === 'Runtime.exceptionThrown' && label) {
      console.log(`  [${label} exception] ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
    }
  };
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send('Runtime.enable');
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.error) throw new Error(r.error.message);
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
    return r.result.result.value;
  };
  return { evaluate, close: () => ws.close() };
}

async function targets() {
  return (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
}

async function waitTarget(pred, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = (await targets().catch(() => [])).find(pred);
    if (t) return t;
    await sleep(250);
  }
  throw new Error('target not found');
}

async function launch(profile) {
  const proc = spawn(
    BRAVE,
    [
      '--headless=new',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${PORT}`,
      `--load-extension=${OUT_DIR}`,
      `--disable-extensions-except=${OUT_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...(OFFLINE ? ['--host-resolver-rules=MAP huggingface.co ~NOTFOUND, MAP *.huggingface.co ~NOTFOUND, MAP *.hf.co ~NOTFOUND'] : []),
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/json/version`);
      break;
    } catch {
      await sleep(200);
    }
  }
  const swT = await waitTarget((t) => t.type === 'service_worker' && t.url.endsWith('/background.js'));
  const sw = await cdp(swT.webSocketDebuggerUrl, 'sw');
  await sw.evaluate('globalThis.__calEnsureOffscreen()');
  const offT = await waitTarget((t) => t.url.includes('/offscreen.html'));
  const off = await cdp(offT.webSocketDebuggerUrl, 'offscreen');
  // Port from the service worker to the offscreen doc's attachSlmPort().
  await sw.evaluate(`(() => {
    globalThis.slmLog = [];
    globalThis.slm = chrome.runtime.connect({ name: 'cal-slm' });
    slm.onMessage.addListener((m) => slmLog.push({ t: Date.now(), ...m }));
    slm.onDisconnect.addListener(() => slmLog.push({ t: Date.now(), type: 'disconnected' }));
    globalThis.slmWait = (pred, ms) => new Promise((res, rej) => {
      const end = Date.now() + ms;
      const tick = () => {
        const hit = slmLog.find(pred);
        if (hit) return res(hit);
        if (Date.now() > end) return rej(new Error('timeout'));
        setTimeout(tick, 50);
      };
      tick();
    });
    globalThis.slmComplete = async (id, prefix, suffix, maxTokens = 64) => {
      const t0 = performance.now();
      slm.postMessage({ type: 'complete', id, prefix, suffix, maxTokens });
      const m = await slmWait((x) => (x.type === 'completion' || x.type === 'completionError') && x.id === id, 120000);
      return { ...m, ms: Math.round(performance.now() - t0) };
    };
    return true;
  })()`);
  return { proc, sw, off };
}

async function load(sw, label) {
  const t0 = Date.now();
  await sw.evaluate(`slmLog.length = 0; slm.postMessage({ type: 'load', modelId: ${JSON.stringify(MODEL)} }); true`);
  let lastPct = -1;
  let sawDownload = false;
  for (;;) {
    const log = await sw.evaluate('slmLog.filter((m) => m.type === "status")');
    for (const m of log) if (m.status === 'downloading') sawDownload = true;
    const last = log.at(-1);
    if (last?.status === 'downloading' && last.progress !== lastPct && last.progress % 10 === 0) {
      lastPct = last.progress;
      console.log(`  ${label}: downloading ${last.progress}% (${Math.round((Date.now() - t0) / 1000)} s)`);
    }
    if (last?.status === 'ready' || last?.status === 'error') {
      const statuses = [...new Set(log.map((m) => m.status))].join(' -> ');
      return { ms: Date.now() - t0, last, sawDownload, statuses };
    }
    if (Date.now() - t0 > 30 * 60_000) throw new Error('load timeout');
    await sleep(500);
  }
}

const profile = mkdtempSync(join(tmpdir(), 'cal-slm-e2e-'));
let browser;
try {
  // ---- run 1: fresh profile, real download (or bundled model when OFFLINE) -------------
  browser = await launch(profile);
  const { sw, off } = browser;
  check('offscreen crossOriginIsolated', (await off.evaluate('self.crossOriginIsolated')) === true);

  const first = await load(sw, 'run 1');
  check('first load reaches ready', first.last.status === 'ready', `${first.statuses}; ${(first.ms / 1000).toFixed(1)} s; ${first.last.detail ?? ''}`);
  if (OFFLINE) check('first load does not download', !first.sawDownload, first.statuses);
  else check('first load reports downloading progress', first.sawDownload);
  if (first.last.status !== 'ready') throw new Error(`load failed: ${first.last.detail}`);

  const cases = [
    ['for loop body', 'int sum(int *a, int n) {\n\tint s = 0;\n\tfor (int i = 0; i < n; i++) {', '\n\treturn s;\n}\n'],
    ['printf line', '#include <stdio.h>\n\nint main(void) {\n\tint n = 5;\n\t', '\n\treturn 0;\n}\n'],
    ['swap function', '#include <stdio.h>\n\nvoid swap(int *a, int *b) {\n\t', '\n}\n\nint main(void) {\n\tint x = 1, y = 2;\n\tswap(&x, &y);\n\treturn 0;\n}\n'],
  ];
  let id = 1;
  for (const [name, prefix, suffix] of cases) {
    const cold = await sw.evaluate(`slmComplete(${id++}, ${JSON.stringify(prefix)}, ${JSON.stringify(suffix)})`);
    const warm = await sw.evaluate(`slmComplete(${id++}, ${JSON.stringify(prefix)}, ${JSON.stringify(suffix)})`);
    console.log(`  [${name}] first ${cold.ms} ms, repeat ${warm.ms} ms -> ${JSON.stringify(cold.text ?? cold.error)}`);
    check(`completion "${name}" non-empty`, cold.type === 'completion' && cold.text.trim().length > 0);
    check(`completion "${name}" has no FIM tokens`, !/<\|/.test(cold.text ?? ''));
    check(`completion "${name}" deterministic`, cold.text === warm.text);
  }

  // Cancel: a request cancelled right away answers completionError 'cancelled'.
  const cancelled = await sw.evaluate(`(async () => {
    slm.postMessage({ type: 'complete', id: 900, prefix: 'int main(void) {\\n\\t', suffix: '\\n}', maxTokens: 64 });
    slm.postMessage({ type: 'cancel', id: 900 });
    return slmWait((x) => x.id === 900, 60000);
  })()`);
  check('cancel -> completionError cancelled', cancelled.type === 'completionError' && cancelled.error === 'cancelled', JSON.stringify(cancelled));

  // Supersede: a newer request aborts the older one; only the newer one completes.
  const superseded = await sw.evaluate(`(async () => {
    slm.postMessage({ type: 'complete', id: 901, prefix: 'int f(int x) {\\n\\t', suffix: '\\n}', maxTokens: 64 });
    const r = await slmComplete(902, 'int g(int y) {\\n\\treturn', '\\n}');
    const old = await slmWait((x) => x.id === 901, 60000);
    return { old, r };
  })()`);
  check('newer request supersedes older', superseded.old.type === 'completionError' && superseded.r.type === 'completion', `${superseded.old.error}; new: ${JSON.stringify(superseded.r.text)} in ${superseded.r.ms} ms`);

  browser.proc.kill();
  await sleep(1500);

  // ---- run 2: same profile, model must come from the OPFS cache ------------------------
  browser = await launch(profile);
  const second = await load(browser.sw, 'run 2');
  check('cached load reaches ready without downloading', second.last.status === 'ready' && !second.sawDownload, `${second.statuses}; ${(second.ms / 1000).toFixed(1)} s`);
  const [name, prefix, suffix] = cases[0];
  const after = await browser.sw.evaluate(`slmComplete(1, ${JSON.stringify(prefix)}, ${JSON.stringify(suffix)})`);
  console.log(`  [${name}] after cached load: ${after.ms} ms -> ${JSON.stringify(after.text)}`);
  check('completion after cached load', after.type === 'completion' && after.text.trim().length > 0);
} catch (e) {
  check('e2e run', false, e instanceof Error ? e.message : String(e));
} finally {
  browser?.proc.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
