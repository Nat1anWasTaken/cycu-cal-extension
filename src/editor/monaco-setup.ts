// Monaco, bundled into the content script with only the contributions we need.
//
// Package layout (monaco-editor 0.57): the `exports` map sends `monaco-editor/<path>.js` to
// `esm/vs/<path>.js`, so `monaco-editor/editor/editor.api.js` is esm/vs/editor/editor.api.js.
// Other slices should `import { monaco } from '../editor/monaco-setup'` (runtime) or
// `import type * as Monaco from 'monaco-editor/editor/editor.api.js'` (types only) — never the full 'monaco-editor'
// entry, which would pull in every language.

import './dom-shims';
import * as monaco from 'monaco-editor/editor/editor.api.js';

// Core
// codicon.css (+ modifiers) — CSS paths can't go through the package `exports` map; this wrapper
// imports codicon.css, and suggestWidget / quick outline import codicon-modifiers.css.
import 'monaco-editor/features/codicon/register.js';
import 'monaco-editor/editor/browser/coreCommands.js';
import 'monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget.js';
import 'monaco-editor/editor/common/standaloneStrings.js';
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js';
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js';
// Find, folding, hover
import 'monaco-editor/features/find/register.js';
import 'monaco-editor/editor/contrib/folding/browser/folding.js';
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js';
// Suggest, inline completions, snippets, parameter hints, rename
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js';
import 'monaco-editor/editor/contrib/suggest/browser/suggestInlineCompletions.js';
import 'monaco-editor/editor/contrib/inlineCompletions/browser/inlineCompletions.contribution.js';
import 'monaco-editor/editor/contrib/snippet/browser/snippetController2.js';
import 'monaco-editor/editor/contrib/parameterHints/browser/parameterHints.js';
import 'monaco-editor/editor/contrib/rename/browser/rename.js';
// Go to symbol / peek, links, code actions, format, diagnostics navigation
import 'monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js';
import 'monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.js';
import 'monaco-editor/editor/standalone/browser/referenceSearch/standaloneReferenceSearch.js';
import 'monaco-editor/editor/contrib/links/browser/links.js';
import 'monaco-editor/editor/contrib/codeAction/browser/codeActionContributions.js';
import 'monaco-editor/editor/contrib/format/browser/formatActions.js';
import 'monaco-editor/editor/contrib/gotoError/browser/gotoError.js';
// Bracket matching, comment, multicursor, word highlighter
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js';
import 'monaco-editor/editor/contrib/comment/browser/comment.js';
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor.js';
import 'monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js';
// Inlay hints, semantic tokens, quick outline, context menu, clipboard
import 'monaco-editor/editor/contrib/inlayHints/browser/inlayHintsContribution.js';
import 'monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens.js';
import 'monaco-editor/editor/contrib/semanticTokens/browser/viewportSemanticTokens.js';
import 'monaco-editor/editor/contrib/documentSymbols/browser/documentSymbols.js';
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess.js';
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js';
// C/C++ Monarch tokenizer (imported statically: content scripts are a single IIFE, no lazy chunks)
import { conf as cppConf, language as cppLanguage } from 'monaco-editor/languages/definitions/cpp/cpp.js';

import { semanticTokenRules } from '../lsp/index';
import type { Settings } from '../shared/settings';

export { monaco };
export type MonacoNS = typeof monaco;

export type EditorWorkerState = 'pending' | 'ok' | 'failed';
let workerState: EditorWorkerState = 'pending';
export const getEditorWorkerState = () => workerState;

let initialised = false;

function setupOnce(): void {
  if (initialised) return;
  initialised = true;

  // Editor worker: a same-origin blob worker that importScripts() the web-accessible IIFE build.
  // If that fails Monaco logs an error and runs the (small) editor-worker features without it.
  (globalThis as any).MonacoEnvironment = {
    getWorker(_id: string, label: string): Worker | undefined {
      try {
        const url = chrome.runtime.getURL('editor.worker.js');
        const src = `importScripts(${JSON.stringify(url)});`;
        const blobUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        const w = new Worker(blobUrl, { name: label });
        w.addEventListener('error', (e) => {
          workerState = 'failed';
          console.warn('[cycu-cal-ext] editor worker failed', e.message);
        });
        w.addEventListener('message', () => (workerState = 'ok'), { once: true });
        return w;
      } catch (err) {
        workerState = 'failed';
        console.warn('[cycu-cal-ext] cannot create editor worker', err);
        return undefined;
      }
    },
  };

  for (const id of ['c', 'cpp']) {
    if (!monaco.languages.getLanguages().some((l) => l.id === id)) {
      monaco.languages.register(
        id === 'c'
          ? { id: 'c', extensions: ['.c', '.h'], aliases: ['C', 'c'] }
          : { id: 'cpp', extensions: ['.cpp', '.cc', '.hpp'], aliases: ['C++', 'cpp'] },
      );
    }
    monaco.languages.setMonarchTokensProvider(id, cppLanguage);
    monaco.languages.setLanguageConfiguration(id, cppConf);
  }

  // Built-in themes plus colours for clangd's semantic token types.
  monaco.editor.defineTheme('cal-light', { base: 'vs', inherit: true, colors: {}, rules: semanticTokenRules('light') });
  monaco.editor.defineTheme('cal-dark', { base: 'vs-dark', inherit: true, colors: {}, rules: semanticTokenRules('dark') });
}

export function themeFor(settings: Settings): string {
  return settings.theme === 'dark' ? 'cal-dark' : 'cal-light';
}

/** The user's fonts first, then the site's mono stack (which also covers CJK). */
function fontFamilyFor(settings: Settings): string {
  const base = 'var(--cal-font-mono, monospace)';
  const custom = settings.fontFamily.trim().replace(/[;,\s]+$/, '');
  return custom ? `${custom}, ${base}` : base;
}

export function createEditor(
  host: HTMLElement,
  model: monaco.editor.ITextModel,
  settings: Settings,
  readOnly: boolean,
): monaco.editor.IStandaloneCodeEditor {
  setupOnce();
  monaco.editor.setTheme(themeFor(settings));
  return monaco.editor.create(host, {
    model,
    readOnly,
    tabSize: 2,
    insertSpaces: true,
    detectIndentation: false,
    fontFamily: fontFamilyFor(settings),
    fontSize: 16,
    automaticLayout: true,
    dragAndDrop: false,
    autoIndent: 'advanced',
    'semanticHighlighting.enabled': true,
    inlayHints: { enabled: 'on' },
    bracketPairColorization: { enabled: true },
    minimap: { enabled: settings.minimap },
    scrollBeyondLastLine: false,
    fixedOverflowWidgets: true, // #editor / #coding clip overflow
    renderValidationDecorations: 'on',
    contextmenu: true,
  });
}

export function createModel(value: string, uri: string): monaco.editor.ITextModel {
  setupOnce();
  return monaco.editor.createModel(value, 'c', monaco.Uri.parse(uri));
}

export function applyEditorSettings(ed: monaco.editor.IStandaloneCodeEditor, settings: Settings): void {
  setupOnce();
  monaco.editor.setTheme(themeFor(settings));
  ed.updateOptions({ minimap: { enabled: settings.minimap }, fontFamily: fontFamilyFor(settings) });
}

/** Replace the model text with one minimal, undoable edit (keeps cursor/scroll where possible). */
export function setModelText(model: monaco.editor.ITextModel, target: string, selections: monaco.Selection[] | null = []): void {
  const cur = model.getValue();
  if (cur === target) return;
  let p = 0;
  const max = Math.min(cur.length, target.length);
  while (p < max && cur.charCodeAt(p) === target.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && cur.charCodeAt(cur.length - 1 - s) === target.charCodeAt(target.length - 1 - s)) s++;
  const a = model.getPositionAt(p);
  const b = model.getPositionAt(cur.length - s);
  model.pushStackElement();
  model.pushEditOperations(
    selections,
    [{ range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column), text: target.slice(p, target.length - s) }],
    () => null,
  );
  model.pushStackElement();
}
