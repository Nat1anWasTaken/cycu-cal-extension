// MAIN-world content script. Talks to the page's own Ace instance, which stays the source of
// truth: the site's RUN handler, draft autosave and reset all read or write Ace.
//
// The page's classic inline script declares top-level `let editor, Range, arr2, arrE`. Those
// are global *lexical* bindings (not window properties), so they are referenced by bare name.
// Never declare locals with those names in this file.

import {
  BRIDGE_TAG,
  FLUSH_EVENT,
  MATH_TEX_EVENT,
  type AceSnapshot,
  type BridgeEnvelope,
  type ContentToPage,
  type LockRange,
  type PageToContent,
} from '../shared/protocol';

/* eslint-disable no-var */
declare var editor: any;
declare var arr2: any;
declare var arrE: any;

const WAIT_MS = 20_000;
const POLL_MS = 1_000;

function readAce(): any {
  return typeof editor !== 'undefined' ? editor : undefined;
}

function isAce(ace: any): boolean {
  return (
    !!ace &&
    typeof ace === 'object' &&
    typeof ace.getValue === 'function' &&
    typeof ace.on === 'function' &&
    typeof ace.setReadOnly === 'function' &&
    typeof ace.getReadOnly === 'function' &&
    typeof ace.resize === 'function' &&
    !!ace.session?.doc &&
    typeof ace.session.doc.setValue === 'function' &&
    ace.container instanceof HTMLElement
  );
}

function post(msg: PageToContent): void {
  const env: BridgeEnvelope<PageToContent> = { tag: BRIDGE_TAG, dir: 'toContent', msg };
  window.postMessage(env, location.origin);
}

function toPos(p: any): { row: number; column: number } | null {
  if (!p || typeof p.row !== 'number' || typeof p.column !== 'number') return null;
  return { row: p.row, column: p.column };
}

function readLocks(): LockRange[] {
  const ranges = typeof arr2 !== 'undefined' && Array.isArray(arr2) ? arr2 : [];
  const ends = typeof arrE !== 'undefined' && Array.isArray(arrE) ? arrE : [];
  const out: LockRange[] = [];
  ranges.forEach((r: any, i: number) => {
    const start = toPos(r?.start);
    const end = toPos(r?.end) ?? toPos(ends[i]);
    if (start && end) out.push({ start, end });
  });
  return out;
}

let ace: any = null;
let applying = false; // echo suppression for writes coming from the content script
let changeQueued = false;
let lastLocks = '[]';
let lastReadOnly = false;
let ready = false;

function snapshot(): AceSnapshot {
  const locks = readLocks();
  lastLocks = JSON.stringify(locks);
  lastReadOnly = !!ace.getReadOnly();
  return {
    value: ace.getValue(),
    readOnly: lastReadOnly,
    locks,
    tabSize: Number(ace.session.getTabSize?.() ?? 2),
    useSoftTabs: !!ace.session.getUseSoftTabs?.(),
  };
}

function topicId(): string {
  return location.pathname.match(/\/topic\/([^/?#]+)/)?.[1] ?? location.pathname;
}

function checkLocks(): void {
  const locks = readLocks();
  const s = JSON.stringify(locks);
  if (s !== lastLocks) {
    lastLocks = s;
    post({ type: 'locks', locks });
  }
}

function checkReadOnly(): void {
  const ro = !!ace.getReadOnly();
  if (ro !== lastReadOnly) {
    lastReadOnly = ro;
    post({ type: 'readOnly', readOnly: ro });
  }
}

/** Writes text into Ace without echoing it back. The page's own `change` listeners (draft autosave) still run. */
function applyValue(v: unknown): void {
  if (!ace || typeof v !== 'string') return;
  if (ace.getValue() === v) return;
  applying = true;
  try {
    ace.session.doc.setValue(v);
  } finally {
    applying = false;
  }
}

function onAceChange(): void {
  if (applying || changeQueued) return;
  changeQueued = true;
  // Coalesce the remove+insert pair of setValue (and the page's synchronous follow-up work such as
  // `initializeForbiddenAreas()` after a reset) into one message.
  queueMicrotask(() => {
    changeQueued = false;
    if (!ace) return;
    post({ type: 'aceChanged', value: ace.getValue() });
    checkLocks();
  });
}

function hook(a: any): void {
  ace = a;
  a.on('change', onAceChange);
  const origSetReadOnly = a.setReadOnly;
  if (!origSetReadOnly.__calWrapped) {
    const wrapped = function (this: any, ro: boolean) {
      const r = origSetReadOnly.apply(this, arguments as any);
      try {
        checkReadOnly();
      } catch {
        /* ignore */
      }
      return r;
    };
    (wrapped as any).__calWrapped = true;
    a.setReadOnly = wrapped;
  }
}

function wrapGlobalFn(name: string, after: () => void): void {
  const w = window as any;
  const orig = w[name];
  if (typeof orig !== 'function' || orig.__calWrapped) return;
  const wrapped = function (this: any) {
    const r = orig.apply(this, arguments);
    try {
      after();
    } catch {
      /* ignore */
    }
    return r;
  };
  (wrapped as any).__calWrapped = true;
  w[name] = wrapped;
}

function handle(msg: ContentToPage): void {
  switch (msg.type) {
    case 'hello':
      if (ready) post({ type: 'init', topicId: topicId(), snapshot: snapshot() });
      break;
    case 'setValue':
      applyValue(msg.value);
      break;
    case 'showAce':
      ace.container.style.visibility = msg.show ? '' : 'hidden';
      if (msg.show) ace.resize(true);
      break;
    case 'focusAce':
      ace.focus();
      break;
  }
}

function start(a: any): void {
  try {
    hook(a);
    // Function declarations in the page's classic script are window properties, so wrapping them
    // intercepts the page's own unqualified calls. Locks are also re-read after every aceChanged.
    wrapGlobalFn('initializeForbiddenAreas', checkLocks);
    wrapGlobalFn('resetEditorWithCode', () => queueMicrotask(checkLocks));
    window.addEventListener('message', (e) => {
      if (e.source !== window || e.origin !== location.origin) return;
      const env = e.data as BridgeEnvelope<ContentToPage> | undefined;
      if (!env || env.tag !== BRIDGE_TAG || env.dir !== 'toPage' || !env.msg || typeof env.msg.type !== 'string')
        return;
      try {
        handle(env.msg);
      } catch (err) {
        console.warn('[cycu-cal-ext] bridge error', err);
      }
    });
    document.addEventListener(FLUSH_EVENT, (e) => applyValue((e as CustomEvent).detail));
    ready = true;
    post({ type: 'init', topicId: topicId(), snapshot: snapshot() });
    // Safety polls: read-only set through setOption, locks rebuilt without a text change,
    // or the page re-creating its editor object.
    setInterval(() => {
      try {
        const cur = readAce();
        if (cur !== ace && isAce(cur)) {
          hook(cur);
          post({ type: 'aceChanged', value: cur.getValue() });
        }
        checkReadOnly();
        checkLocks();
      } catch {
        /* ignore */
      }
    }, POLL_MS);
  } catch (err) {
    ready = false;
    post({ type: 'unavailable', reason: `hook failed: ${String(err)}` });
  }
}

function waitForEditor(): void {
  const t0 = Date.now();
  const tick = () => {
    let a: any;
    try {
      a = readAce();
    } catch {
      a = undefined; // TDZ: binding declared but not initialised yet
    }
    if (isAce(a)) return start(a);
    if (Date.now() - t0 > WAIT_MS) {
      post({ type: 'unavailable', reason: a === undefined ? 'no Ace editor on page' : 'unexpected Ace API' });
      return;
    }
    setTimeout(tick, 100);
  };
  tick();
}

/** Tags each MathJax 3 typeset formula with its TeX source (see MATH_TEX_EVENT). */
function annotateMathTex(): void {
  try {
    const math = (window as any).MathJax?.startup?.document?.math;
    if (!math || typeof math[Symbol.iterator] !== 'function') return;
    for (const item of math) {
      const root = item?.typesetRoot;
      if (root instanceof HTMLElement && typeof item.math === 'string') root.dataset.calTex = item.math.trim();
    }
  } catch (err) {
    console.warn('[cycu-cal-ext] cannot read MathJax', err);
  }
}

if (!(window as any).__cycuCalExtMain) {
  (window as any).__cycuCalExtMain = true;
  document.addEventListener(MATH_TEX_EVENT, annotateMathTex);
  waitForEditor();
}
