// Hierarchical document symbols (Cmd-Shift-O quick outline, breadcrumbs).

import type * as Monaco from 'monaco-editor/editor/editor.api.js';
import type * as P from 'vscode-languageserver-protocol';
import type { FeatureContext } from '../monaco-bridge';
import { toMonacoSymbols } from './convert';

export function register(ctx: FeatureContext): Monaco.IDisposable {
  const { monaco, bridge } = ctx;
  return monaco.languages.registerDocumentSymbolProvider(ctx.selector, {
    displayName: 'clangd',
    async provideDocumentSymbols(model, token) {
      if (!bridge.isOurs(model)) return undefined;
      return toMonacoSymbols(
        await bridge.request<P.DocumentSymbol[] | P.SymbolInformation[]>(
          'textDocument/documentSymbol',
          { textDocument: bridge.textDocument } satisfies P.DocumentSymbolParams,
          token,
        ),
      );
    },
  });
}
