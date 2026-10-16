// Monaco's UI strings. Its nls.js reads the global message table set by a monaco-editor/nls/lang/* module, and many
// strings are resolved while Monaco's modules load, so monaco-setup.ts imports this file before any Monaco module.
// With no table, Monaco falls back to its built-in English strings.

import 'monaco-editor/nls/lang/zh-tw.js';
import { getLocale } from '../shared/i18n';

if (getLocale() !== 'zh-TW') {
  const g = globalThis as { _VSCODE_NLS_MESSAGES?: unknown; _VSCODE_NLS_LANGUAGE?: unknown };
  delete g._VSCODE_NLS_MESSAGES;
  delete g._VSCODE_NLS_LANGUAGE;
}
