// Folding ranges from clangd (replaces Monaco's indentation-based folding for this model).

import type * as Monaco from 'monaco-editor/editor/editor.api.js';
import type * as P from 'vscode-languageserver-protocol';
import type { FeatureContext } from '../monaco-bridge';
import { toMonacoFoldingRanges } from './convert';

export function register(ctx: FeatureContext): Monaco.IDisposable {
  const { monaco, bridge } = ctx;
  return monaco.languages.registerFoldingRangeProvider(ctx.selector, {
    async provideFoldingRanges(model, _context, token) {
      if (!bridge.isOurs(model)) return undefined;
      return toMonacoFoldingRanges(
        monaco,
        await bridge.request<P.FoldingRange[]>(
          'textDocument/foldingRange',
          { textDocument: bridge.textDocument } satisfies P.FoldingRangeParams,
          token,
        ),
      );
    },
  });
}
