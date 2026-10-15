// monaco-editor 0.57 ships no typings for the raw Monarch definitions.
declare module 'monaco-editor/languages/definitions/cpp/cpp.js' {
  import type { languages } from 'monaco-editor/editor/editor.api.js';
  export const conf: languages.LanguageConfiguration;
  export const language: languages.IMonarchLanguage;
}
