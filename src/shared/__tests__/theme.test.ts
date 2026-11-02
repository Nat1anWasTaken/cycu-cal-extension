import test from 'node:test';
import assert from 'node:assert/strict';
import { isDarkEditorTheme, resolveEditorTheme, resolveTheme } from '../theme.ts';

test('resolveTheme: a fixed theme wins, auto follows the system', () => {
  for (const prefersDark of [true, false]) {
    assert.equal(resolveTheme('light', prefersDark), 'light');
    assert.equal(resolveTheme('dark', prefersDark), 'dark');
  }
  assert.equal(resolveTheme('auto', true), 'dark');
  assert.equal(resolveTheme('auto', false), 'light');
});

test('resolveEditorTheme: page follows the page theme, a built-in theme wins', () => {
  assert.equal(resolveEditorTheme('page', 'light'), 'vs');
  assert.equal(resolveEditorTheme('page', 'dark'), 'vs-dark');
  for (const page of ['light', 'dark'] as const) {
    for (const t of ['vs', 'vs-dark', 'hc-light', 'hc-black'] as const) assert.equal(resolveEditorTheme(t, page), t);
  }
});

test('isDarkEditorTheme', () => {
  assert.deepEqual((['vs', 'vs-dark', 'hc-light', 'hc-black'] as const).filter(isDarkEditorTheme), [
    'vs-dark',
    'hc-black',
  ]);
});
