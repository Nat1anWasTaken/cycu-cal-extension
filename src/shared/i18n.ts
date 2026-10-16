// UI localization shared by every context (content script, options page, background, offscreen document, workers).
// The locale is the `language` setting, or with 'auto' the browser's UI language (like Chrome's own _locales lookup).
// Settings load asynchronously, so each context starts with the browser language and calls setLocale once they are
// in. The offscreen document and workers can't read settings, so content scripts send the locale on their ports.

import { en, type Messages } from './locales/en.ts';
import { zhTW } from './locales/zh-TW.ts';

export type Locale = 'en' | 'zh-TW';

/** The `language` setting: a fixed locale, or 'auto' to follow the browser. */
export type LanguageSetting = 'auto' | Locale;

export const LOCALES: Record<Locale, Messages> = { en, 'zh-TW': zhTW };

export type MessageKey = keyof Messages;
type Args<K extends MessageKey> = Messages[K] extends (...args: infer A) => string ? A : [];

/** Maps a BCP 47 language tag to a supported locale: Traditional Chinese variants get zh-TW, everything else en. */
export function resolveLocale(lang: string | null | undefined): Locale {
  return /^zh[-_](tw|hk|mo|hant)\b/i.test(lang ?? '') ? 'zh-TW' : 'en';
}

/** The browser's UI language as a language tag (chrome.i18n where available, else navigator.language). */
export function uiLanguage(): string {
  return globalThis.chrome?.i18n?.getUILanguage?.() || globalThis.navigator?.language || 'en';
}

/** The locale a `language` setting selects. */
export function localeFor(language: LanguageSetting): Locale {
  return language === 'auto' ? resolveLocale(uiLanguage()) : language;
}

let locale: Locale = resolveLocale(uiLanguage());

export function getLocale(): Locale {
  return locale;
}

/** Switches the locale; strings already shown are not updated. */
export function setLocale(next: Locale): void {
  if (next in LOCALES) locale = next;
}

/** The localized message for `key`, formatted with `args` when the message takes parameters. */
export function t<K extends MessageKey>(key: K, ...args: Args<K>): string {
  const m = (LOCALES[locale][key] ?? en[key]) as string | ((...a: unknown[]) => string);
  return typeof m === 'function' ? m(...args) : m;
}
