import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCALES, localeFor, resolveLocale, setLocale, t, uiLanguage } from '../i18n.ts';

test('resolveLocale: Traditional Chinese tags map to zh-TW, everything else to en', () => {
  for (const tag of ['zh-TW', 'zh_TW', 'zh-HK', 'zh-MO', 'zh-Hant', 'zh-Hant-TW'])
    assert.equal(resolveLocale(tag), 'zh-TW');
  for (const tag of ['en', 'en-US', 'zh-CN', 'zh', 'ja', '', undefined, null]) assert.equal(resolveLocale(tag), 'en');
});

test('localeFor: a fixed language wins, auto follows the browser', () => {
  assert.equal(localeFor('en'), 'en');
  assert.equal(localeFor('zh-TW'), 'zh-TW');
  assert.equal(localeFor('auto'), resolveLocale(uiLanguage()));
});

test('every locale defines the same messages with the same parameters', () => {
  const { en, ...others } = LOCALES;
  for (const [locale, messages] of Object.entries(others)) {
    assert.deepEqual(Object.keys(messages).sort(), Object.keys(en).sort(), locale);
    for (const [key, m] of Object.entries(messages)) {
      const ref = en[key as keyof typeof en];
      assert.equal(typeof m, typeof ref, `${locale} ${key}`);
      if (typeof m === 'function' && typeof ref === 'function') assert.equal(m.length, ref.length, `${locale} ${key}`);
    }
  }
});

test('t formats parameterized messages in the current locale', () => {
  setLocale('en');
  assert.equal(t('edit.locked', 3, 3), 'This change would modify locked line 3.');
  assert.equal(t('edit.locked', 3, 4), 'This change would modify locked lines 3-4.');
  setLocale('zh-TW');
  assert.equal(t('edit.locked', 3, 4), '這項修改會改動不可編輯的第 3-4 行，因此無法套用。');
  assert.equal(t('options.saved'), '已儲存');
  setLocale('en');
});
