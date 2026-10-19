// HTML → Markdown for the question's "Copy" button. Pure (no DOM globals) so unit tests can feed it
// small fake trees; a real DOM Node satisfies `MdNode` structurally.

export interface MdNode {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  childNodes: ArrayLike<MdNode>;
  getAttribute?(name: string): string | null;
}

export interface MarkdownOptions {
  /** Resolves relative link and image URLs. */
  baseUrl?: string;
  /** Extra elements to leave out (the default skips scripts, buttons, `hidden` and `aria-hidden`). */
  skip?: (node: MdNode) => boolean;
}

const ELEMENT = 1;
const TEXT = 3;
/** Stand in for <br> (a hard break) and for a plain line break until a paragraph is cleaned up. */
const BR = '\u0002';
const NL = '\u0003';

const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DD',
  'DETAILS',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'SUMMARY',
  'TABLE',
  'UL',
]);
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);

export function htmlToMarkdown(root: MdNode, opts: MarkdownOptions = {}): string {
  return blocks(root, opts).join('\n\n').trim() + '\n';
}

const tagOf = (n: MdNode) => n.nodeName.toUpperCase();
const attr = (n: MdNode, name: string) => n.getAttribute?.(name) ?? null;

function skipped(n: MdNode, opts: MarkdownOptions): boolean {
  if (n.nodeType !== ELEMENT) return n.nodeType !== TEXT;
  return SKIP_TAGS.has(tagOf(n)) || attr(n, 'hidden') !== null || attr(n, 'aria-hidden') === 'true' || !!opts.skip?.(n);
}

function textOf(n: MdNode): string {
  if (n.nodeType === TEXT) return n.nodeValue ?? '';
  if (tagOf(n) === 'BR') return '\n';
  return Array.from(n.childNodes, textOf).join('');
}

/** Converts `n`'s children into finished Markdown blocks. */
function blocks(n: MdNode, opts: MarkdownOptions): string[] {
  const out: string[] = [];
  let run = '';
  const flush = () => {
    const p = cleanInline(run);
    if (p) out.push(p);
    run = '';
  };
  for (const c of Array.from(n.childNodes)) {
    if (skipped(c, opts)) continue;
    if (c.nodeType === ELEMENT && BLOCK_TAGS.has(tagOf(c))) {
      flush();
      out.push(...block(c, opts));
    } else run += inline(c, opts);
  }
  flush();
  return out;
}

function block(n: MdNode, opts: MarkdownOptions): string[] {
  const tag = tagOf(n);
  switch (tag) {
    case 'H1':
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6': {
      const text = cleanInline(inlineChildren(n, opts)).replace(/\s*\n\s*/g, ' ');
      return text ? [`${'#'.repeat(Number(tag[1]))} ${text}`] : [];
    }
    case 'HR':
      return ['---'];
    case 'PRE': {
      const code = textOf(n).replace(/\n$/, '');
      const fence = '`'.repeat(Math.max(3, longestRun(code, '`') + 1));
      const lang = /(?:^|\s)(?:language|lang)-([\w+#-]+)/.exec(`${attr(n, 'class') ?? ''} ${firstCodeClass(n)}`)?.[1];
      return [`${fence}${lang ?? ''}\n${code}\n${fence}`];
    }
    case 'BLOCKQUOTE': {
      const inner = blocks(n, opts).join('\n\n');
      return inner ? [prefixLines(inner, '> ', '>')] : [];
    }
    case 'UL':
    case 'OL':
      return list(n, opts);
    case 'TABLE':
      return table(n, opts);
    default:
      return blocks(n, opts);
  }
}

function firstCodeClass(pre: MdNode): string {
  const code = Array.from(pre.childNodes).find((c) => c.nodeType === ELEMENT && tagOf(c) === 'CODE');
  return code ? (attr(code, 'class') ?? '') : '';
}

function list(n: MdNode, opts: MarkdownOptions): string[] {
  const ordered = tagOf(n) === 'OL';
  let i = Number(attr(n, 'start') ?? 1);
  if (!Number.isFinite(i)) i = 1;
  const items: string[] = [];
  for (const li of Array.from(n.childNodes)) {
    if (li.nodeType !== ELEMENT || tagOf(li) !== 'LI' || skipped(li, opts)) continue;
    const marker = ordered ? `${i++}.` : '-';
    const body = blocks(li, opts).join('\n');
    const pad = ' '.repeat(marker.length + 1);
    items.push(marker + (body ? ' ' + prefixLines(body, pad, '').slice(pad.length) : ''));
  }
  return items.length ? [items.join('\n')] : [];
}

function table(n: MdNode, opts: MarkdownOptions): string[] {
  const rows: string[][] = [];
  const walk = (e: MdNode) => {
    for (const c of Array.from(e.childNodes)) {
      if (c.nodeType !== ELEMENT || skipped(c, opts)) continue;
      const tag = tagOf(c);
      if (tag === 'TR') {
        const cells = Array.from(c.childNodes).filter(
          (td) => td.nodeType === ELEMENT && (tagOf(td) === 'TD' || tagOf(td) === 'TH') && !skipped(td, opts),
        );
        rows.push(
          cells.map((td) =>
            blocks(td, opts)
              .join('\n')
              .replace(/ *\n */g, '<br>')
              .replace(/\|/g, '\\|'),
          ),
        );
      } else if (tag === 'THEAD' || tag === 'TBODY' || tag === 'TFOOT') walk(c);
    }
  };
  walk(n);
  if (!rows.length) return [];
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, k) => r[k] ?? '').join(' | ')} |`;
  return [[line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n')];
}

function inlineChildren(n: MdNode, opts: MarkdownOptions): string {
  return Array.from(n.childNodes, (c) => (skipped(c, opts) ? '' : inline(c, opts))).join('');
}

function inline(n: MdNode, opts: MarkdownOptions): string {
  if (n.nodeType === TEXT) return escape((n.nodeValue ?? '').replace(/\s+/g, ' '));
  switch (tagOf(n)) {
    case 'BR':
      return BR;
    case 'STRONG':
    case 'B':
      return wrap(inlineChildren(n, opts), '**');
    case 'EM':
    case 'I':
      return wrap(inlineChildren(n, opts), '*');
    case 'DEL':
    case 'S':
    case 'STRIKE':
      return wrap(inlineChildren(n, opts), '~~');
    case 'CODE':
    case 'KBD':
    case 'SAMP':
    case 'TT':
      return codeSpan(textOf(n));
    case 'A': {
      const text = inlineChildren(n, opts);
      const href = resolve(attr(n, 'href'), opts);
      if (!href || !text.trim()) return text;
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
      return `${m[1]}[${m[2]}](${href})${m[3]}`;
    }
    case 'MJX-CONTAINER': {
      // MathJax 3 output; main-world puts the TeX source in data-cal-tex. Without it, fall back to
      // the text of the assistive MathML (the visual mjx-math is aria-hidden and skipped).
      const tex = attr(n, 'data-cal-tex');
      if (!tex) return inlineChildren(n, opts);
      return attr(n, 'display') === 'true' ? `${NL}$$${tex.replace(/\s+/g, ' ')}$$${NL}` : `$${tex}$`;
    }
    case 'IMG': {
      const src = resolve(attr(n, 'src'), opts);
      return src ? `![${escape(attr(n, 'alt') ?? '')}](${src})` : '';
    }
    default:
      // Inline wrappers (span, sup, …) and block elements nested inside inline ones.
      return inlineChildren(n, opts);
  }
}

/** Collapses whitespace in a run of inline Markdown and turns <br> into hard line breaks. */
function cleanInline(s: string): string {
  return s
    .replace(/ {2,}/g, ' ')
    .replace(new RegExp(`[ ${BR}${NL}]+$`), '')
    .replace(new RegExp(`^[ ${BR}${NL}]+`), '')
    .replace(new RegExp(` ?[${BR}${NL}]*${NL}[${BR}${NL}]* ?`, 'g'), '\n')
    .replace(new RegExp(` ?${BR}+ ?`, 'g'), '  \n')
    .trim();
}

function wrap(inner: string, mark: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : inner;
}

function codeSpan(code: string): string {
  code = code.replace(/\s+/g, ' ');
  if (!code.trim()) return code;
  const ticks = '`'.repeat(longestRun(code, '`') + 1);
  const pad = code.startsWith('`') || code.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${code}${pad}${ticks}`;
}

function escape(s: string): string {
  // `<` only before something that would read as an HTML tag (`<stdio.h>`), not in `a < b`.
  return s.replace(/[\\`*_[\]]|<(?=[A-Za-z/!?])/g, '\\$&');
}

function resolve(url: string | null, opts: MarkdownOptions): string | null {
  url = url?.trim() || null;
  if (!url || /^javascript:/i.test(url)) return null;
  try {
    url = new URL(url, opts.baseUrl).href;
  } catch {
    /* keep it as written */
  }
  return url.replace(/[()\s]/g, encodeURIComponent);
}

function longestRun(s: string, ch: string): number {
  let best = 0;
  let cur = 0;
  for (const c of s) {
    cur = c === ch ? cur + 1 : 0;
    best = Math.max(best, cur);
  }
  return best;
}

function prefixLines(s: string, prefix: string, blankPrefix: string): string {
  return s
    .split('\n')
    .map((l) => (l ? prefix + l : blankPrefix))
    .join('\n');
}
