import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFimPrompt, CHARS_PER_TOKEN, FIM_MIDDLE, FIM_PREFIX, FIM_SUFFIX, sanitize, trimContext } from '../fim.ts';

test('builds the Qwen2.5-Coder FIM prompt from prefix and suffix only', () => {
  const p = buildFimPrompt('int main() {\n\t', '\n}\n');
  assert.equal(p, `${FIM_PREFIX}int main() {\n\t${FIM_SUFFIX}\n}\n${FIM_MIDDLE}`);
});

test('strips control tokens typed into the editor', () => {
  assert.equal(sanitize('a<|fim_middle|>b<|endoftext|>c'), 'abc');
  const p = buildFimPrompt('x<|fim_suffix|>', 'y');
  assert.equal(p.split(FIM_SUFFIX).length, 2);
});

test('short context is untouched', () => {
  assert.deepEqual(trimContext('abc\ndef', 'ghi', 100), { prefix: 'abc\ndef', suffix: 'ghi' });
});

test('trims far prefix/suffix lines to the token budget, keeping whole lines', () => {
  const lines = Array.from({ length: 2000 }, (_, i) => `line ${i};`);
  const prefix = lines.join('\n') + '\n\tfor (int i = 0; ';
  const suffix = '\n' + lines.join('\n');
  const { prefix: p, suffix: s } = trimContext(prefix, suffix, 1536);
  const budget = 1536 * CHARS_PER_TOKEN;
  assert.ok(p.length + s.length <= budget, `${p.length + s.length} > ${budget}`);
  assert.ok(p.endsWith('\n\tfor (int i = 0; '), 'cursor line kept');
  assert.ok(p.startsWith('line '), 'prefix starts at a whole line');
  assert.ok(s.startsWith('\nline 0;'), 'near suffix kept');
  assert.ok(s.endsWith(';'), 'suffix ends at a whole line');
  // prefix gets the larger share when both sides are long
  assert.ok(p.length > s.length * 2);
});

test('unused suffix budget goes to the prefix', () => {
  const prefix = Array.from({ length: 3000 }, (_, i) => `p${i}`).join('\n');
  const { prefix: p, suffix: s } = trimContext(prefix, '\n}', 100);
  assert.equal(s, '\n}');
  assert.ok(p.length + s.length <= 100 * CHARS_PER_TOKEN);
  assert.ok(p.length > 100 * CHARS_PER_TOKEN * 0.9);
  assert.ok(p.endsWith('p2999'));
});

test('a single huge cursor line is char-trimmed from the far side', () => {
  const { prefix: p, suffix: s } = trimContext('x'.repeat(10000), 'y'.repeat(10000), 100);
  assert.ok(p.length + s.length <= 300);
  assert.ok(p.length > 0 && s.length > 0);
});
