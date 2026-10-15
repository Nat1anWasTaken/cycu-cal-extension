// Completion with resolve (documentation) and snippet insertion.

import type * as Monaco from 'monaco-editor/editor/editor.api.js';
import type * as P from 'vscode-languageserver-protocol';
import type { FeatureContext } from '../monaco-bridge';
import { completionItems, toLspPosition, toMarkdown, toMonacoCompletion, toMonacoTextEdit } from './convert';

export const TRIGGER_CHARACTERS = ['.', '>', ':', '"', '<', '/', '#'];

export function register(ctx: FeatureContext): Monaco.IDisposable {
  const { monaco, bridge } = ctx;
  const origin = new WeakMap<Monaco.languages.CompletionItem, P.CompletionItem>();

  return monaco.languages.registerCompletionItemProvider(ctx.selector, {
    triggerCharacters: TRIGGER_CHARACTERS,
    async provideCompletionItems(model, position, context, token) {
      if (!bridge.isOurs(model)) return undefined;
      const result = await bridge.request<P.CompletionItem[] | P.CompletionList>(
        'textDocument/completion',
        {
          textDocument: bridge.textDocument,
          position: toLspPosition(position),
          context: {
            triggerKind: (context.triggerKind + 1) as P.CompletionTriggerKind,
            triggerCharacter: context.triggerCharacter,
          },
        } satisfies P.CompletionParams,
        token,
      );
      const { items, incomplete, defaults } = completionItems(result);
      const word = model.getWordUntilPosition(position);
      const defaultRange: Monaco.IRange = {
        startLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      };
      const suggestions = items.map((it) => {
        const s = toMonacoCompletion(monaco, it, defaultRange, defaults);
        origin.set(s, defaults?.data !== undefined && it.data === undefined ? { ...it, data: defaults.data } : it);
        return s;
      });
      return { suggestions, incomplete };
    },
    async resolveCompletionItem(item, token) {
      const lsp = origin.get(item);
      if (!lsp || item.documentation) return item;
      const r = await bridge.request<P.CompletionItem>('completionItem/resolve', lsp, token);
      if (!r) return item;
      const doc = toMarkdown(r.documentation);
      if (doc !== undefined) item.documentation = doc;
      if (r.detail && !item.detail) item.detail = r.detail;
      if (r.additionalTextEdits?.length && !item.additionalTextEdits) {
        item.additionalTextEdits = r.additionalTextEdits.map(toMonacoTextEdit);
      }
      return item;
    },
  });
}
