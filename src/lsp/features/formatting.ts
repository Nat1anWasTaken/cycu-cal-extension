// Document, range and on-type formatting. Edits that intersect a locked range are dropped
// (the rest of the format still applies).

import type * as Monaco from 'monaco-editor/editor/editor.api.js';
import type * as P from 'vscode-languageserver-protocol';
import type { FeatureContext } from '../monaco-bridge';
import { filterEditsByLocks, toLspPosition, toLspRange, toMonacoTextEdit } from './convert';

export const ON_TYPE_TRIGGERS = ['}', ';', '\n'];

export function register(ctx: FeatureContext): Monaco.IDisposable {
  const { monaco, bridge } = ctx;
  const opts = (o: Monaco.languages.FormattingOptions): P.FormattingOptions => ({
    tabSize: o.tabSize,
    insertSpaces: o.insertSpaces,
    trimTrailingWhitespace: true,
  });
  const finish = (edits: P.TextEdit[] | null): Monaco.languages.TextEdit[] => {
    const { kept, dropped } = filterEditsByLocks(edits ?? [], ctx.getLocks());
    if (dropped.length) console.debug(`[cal-lsp] format: skipped ${dropped.length} edit(s) touching locked lines`);
    return kept.map(toMonacoTextEdit);
  };

  const subs = [
    monaco.languages.registerDocumentFormattingEditProvider(ctx.selector, {
      displayName: 'clang-format',
      async provideDocumentFormattingEdits(model, options, token) {
        if (!bridge.isOurs(model)) return undefined;
        return finish(
          await bridge.request<P.TextEdit[]>(
            'textDocument/formatting',
            { textDocument: bridge.textDocument, options: opts(options) } satisfies P.DocumentFormattingParams,
            token,
          ),
        );
      },
    }),
    monaco.languages.registerDocumentRangeFormattingEditProvider(ctx.selector, {
      displayName: 'clang-format',
      async provideDocumentRangeFormattingEdits(model, range, options, token) {
        if (!bridge.isOurs(model)) return undefined;
        return finish(
          await bridge.request<P.TextEdit[]>(
            'textDocument/rangeFormatting',
            { textDocument: bridge.textDocument, range: toLspRange(range), options: opts(options) } satisfies P.DocumentRangeFormattingParams,
            token,
          ),
        );
      },
    }),
    monaco.languages.registerOnTypeFormattingEditProvider(ctx.selector, {
      autoFormatTriggerCharacters: ON_TYPE_TRIGGERS,
      async provideOnTypeFormattingEdits(model, position, ch, options, token) {
        if (!bridge.isOurs(model)) return undefined;
        return finish(
          await bridge.request<P.TextEdit[]>(
            'textDocument/onTypeFormatting',
            { textDocument: bridge.textDocument, position: toLspPosition(position), ch, options: opts(options) } satisfies P.DocumentOnTypeFormattingParams,
            token,
          ),
        );
      },
    }),
  ];
  return { dispose: () => subs.forEach((s) => s.dispose()) };
}
