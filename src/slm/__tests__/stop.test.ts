import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cursorContext, indentWidth, postprocess } from '../fim.ts';

const run = (prefix: string, suffix: string, raw: string, final = true) =>
  postprocess(raw, cursorContext(prefix, suffix, 2), final);

test('indentWidth counts tabs to tab stops', () => {
  assert.equal(indentWidth('\t\tx', 2), 4);
  assert.equal(indentWidth('  \tx', 4), 4);
  assert.equal(indentWidth('x', 2), 0);
});

test('stops at FIM / special tokens', () => {
  assert.deepEqual(run('int x = ', '', '42;<|endoftext|>junk', false), { text: '42;', done: true });
  assert.equal(run('a', '', 'b<|fim_pad|>c').text, 'b');
  assert.equal(run('a', '', 'b<|file_sep|>c').text, 'b');
  assert.equal(run('a', '', 'b<|fim_prefix|>c').text, 'b');
});

test('stops at a blank line (also whitespace-only)', () => {
  const pre = 'int main() {\n\tint a = 1;';
  assert.deepEqual(run(pre, '\n}', '\n\tint b = 2;\n\n\tint c;', false), { text: '\n\tint b = 2;', done: true });
  assert.equal(run(pre, '\n}', '\n\tint b = 2;\n\t \n\tint c;').text, '\n\tint b = 2;');
  // trailing blank line while streaming is not yet definitive
  assert.equal(run(pre, '\n}', '\n\tint b = 2;\n', false).done, false);
});

test('stops when indentation drops below the cursor line', () => {
  const pre = 'int main() {\n\tfor (int i = 0; i < n; i++) {\n\t\t';
  const raw = 'sum += i;\n\t\tcount++;\n\t}\n\treturn sum;';
  assert.deepEqual(run(pre, '', raw, false), { text: 'sum += i;\n\t\tcount++;', done: true });
});

test('same indentation as the cursor line is allowed (closing brace of a for)', () => {
  const pre = 'int main() {\n\tfor (int i = 0; i < n; i++) {';
  const raw = '\n\t\tsum += i;\n\t}\n}';
  assert.deepEqual(run(pre, '', raw), { text: '\n\t\tsum += i;\n\t}', done: true });
});

test('indent of a partial line is unknown until a non-space char arrives', () => {
  const pre = '\t\tx = 1;';
  assert.equal(run(pre, '', '\n\t', false).done, false);
  assert.equal(run(pre, '', '\n\ty', false).done, true);
});

test('single line when real code follows the cursor', () => {
  assert.deepEqual(run('printf(', '"%d", x);\n', '"%d\\n"\nfoo', false), { text: '"%d\\n"', done: true });
});

test('closing punctuation after the cursor still allows multi-line', () => {
  const pre = 'int main() {\n\tfor (int i = 0; i < n; i++) {';
  const ctx = cursorContext(pre, '}\n}', 2);
  assert.equal(ctx.singleLine, false);
  // keeps the trailing indent so the existing `}` lands on its own line
  assert.equal(postprocess('\n\t\tsum += i;\n\t', ctx, true).text, '\n\t\tsum += i;\n\t');
});

test('drops a trailing line that duplicates the next suffix line', () => {
  const pre = 'int main() {\n\tint a = 1;';
  assert.equal(run(pre, '\n\treturn 0;\n}', '\n\tint b = a;\n\treturn 0;').text, '\n\tint b = a;');
});

test('trims trailing whitespace and whitespace-only results', () => {
  assert.equal(run('int a = ', '', '1;   ').text, '1;');
  assert.equal(run('\tint a;', '', '\n\t').text, '');
  assert.equal(run('x', '', '   ').text, '');
});

test('stops when a line repeats (greedy decoding loop)', () => {
  const pre = 'int main(void) {\n\tint n = 5;\n\t';
  const raw = 'printf("n = %d\\n", n);\n\t++n;\n\tprintf("n = %d\\n", n);\n\t--n;';
  assert.deepEqual(run(pre, '\n\treturn 0;\n}', raw, false), { text: 'printf("n = %d\\n", n);\n\t++n;', done: true });
  // short punctuation lines such as `}` may repeat
  const nested = '\n\t\tfor (;;) {\n\t\t\tx++;\n\t\t}\n\t\t}';
  assert.equal(run('int f() {\n\twhile (1) {', '', nested).text, nested);
});

test('code before the cursor + a finished statement completes just that statement', () => {
  const pre = 'int g(int y) {\n\treturn';
  assert.deepEqual(run(pre, '\n}', ' y * 2;\n\t//return y * 2;', false), { text: ' y * 2;', done: true });
  // a `for (` header continues into its body
  const pre2 = 'int s = 0;\nfor (int i = 0; ';
  assert.equal(run(pre2, '', 'i < n; i++) {\n\ts += i;\n}').text, 'i < n; i++) {\n\ts += i;\n}');
});
