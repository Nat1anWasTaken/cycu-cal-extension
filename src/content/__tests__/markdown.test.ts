import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToMarkdown, type MdNode } from '../markdown.ts';

type Child = MdNode | string;

function h(tag: string, attrs: Record<string, string> | null, ...children: Child[]): MdNode {
  return {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    nodeValue: null,
    childNodes: children.map((c) =>
      typeof c === 'string' ? { nodeType: 3, nodeName: '#text', nodeValue: c, childNodes: [] } : c,
    ),
    getAttribute: (name) => attrs?.[name] ?? null,
  };
}

const md = (...children: Child[]) =>
  htmlToMarkdown(h('div', null, ...children), { baseUrl: 'https://cal.test/cal/topic/1' });

test('headings, paragraphs and inline formatting', () => {
  assert.equal(
    md(
      '\n  ',
      h('h5', null, '題目說明'),
      h(
        'p',
        null,
        '讀入 ',
        h('b', null, '兩個 '),
        '整數，',
        h('em', null, 'n'),
        ' 用 ',
        h('code', null, 'scanf'),
        '。',
      ),
    ),
    '##### 題目說明\n\n讀入 **兩個** 整數，*n* 用 `scanf`。\n',
  );
});

test('loose text and line breaks', () => {
  assert.equal(md('line one', h('br', null), '\n line two', h('br', null)), 'line one  \nline two\n');
});

test('escapes Markdown syntax in text but not in code', () => {
  assert.equal(
    md(h('p', null, 'a*b_c [x] #include <stdio.h>, 1 < 2 ', h('code', null, 'a*b'))),
    'a\\*b\\_c \\[x\\] #include \\<stdio.h>, 1 < 2 `a*b`\n',
  );
});

test('pre blocks keep their whitespace', () => {
  assert.equal(
    md(h('p', null, 'Input:'), h('pre', null, h('code', { class: 'language-c' }, 'int main() {\n  return 0;\n}\n'))),
    'Input:\n\n```c\nint main() {\n  return 0;\n}\n```\n',
  );
  assert.equal(md(h('pre', null, 'a ```\nb')), '````\na ```\nb\n````\n');
});

test('nested and ordered lists', () => {
  assert.equal(
    md(h('ol', { start: '3' }, h('li', null, 'first'), h('li', null, 'second', h('ul', null, h('li', null, 'inner'))))),
    '3. first\n4. second\n   - inner\n',
  );
});

test('tables', () => {
  assert.equal(
    md(
      h(
        'table',
        null,
        h('thead', null, h('tr', null, h('th', null, 'in'), h('th', null, 'out'))),
        h('tbody', null, h('tr', null, h('td', null, '1 2'), h('td', null, 'a|b', h('br', null), 'c'))),
      ),
    ),
    '| in | out |\n| --- | --- |\n| 1 2 | a\\|b<br>c |\n',
  );
});

test('links, images, blockquotes and skipped elements', () => {
  assert.equal(
    md(
      h('p', null, 'see ', h('a', { href: '/doc' }, 'docs'), ' ', h('img', { src: 'x.png', alt: 'fig' })),
      h('blockquote', null, h('p', null, 'note'), h('p', null, 'more')),
      h('script', null, 'alert(1)'),
      h('div', { hidden: '' }, 'hidden'),
      h('button', null, 'Copy'),
    ),
    'see [docs](https://cal.test/doc) ![fig](https://cal.test/cal/topic/x.png)\n\n> note\n>\n> more\n',
  );
});

test('MathJax formulas use the TeX source when main-world provided it', () => {
  const mjx = (tex: string | null, display: boolean) =>
    h(
      'mjx-container',
      { ...(tex ? { 'data-cal-tex': tex } : {}), ...(display ? { display: 'true' } : {}) },
      h('mjx-math', { 'aria-hidden': 'true' }, 'glyphs'),
      h('mjx-assistive-mml', null, h('math', null, h('mn', null, '2'), h('mo', null, '×'), h('mn', null, '3'))),
    );
  assert.equal(
    md(
      h('p', null, '介於 ', h('code', null, '0'), ' (', mjx('2\\times 3', false), ')'),
      h('p', null, '得到', mjx('a_1 \\\\\n b', true), mjx('c', true)),
      h('p', null, mjx(null, false)),
    ),
    '介於 `0` ($2\\times 3$)\n\n得到\n$$a_1 \\\\ b$$\n$$c$$\n\n2×3\n',
  );
});
