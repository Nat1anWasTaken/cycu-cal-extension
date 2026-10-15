// Semantic tokens (full + full/delta). The legend comes from the initialize result, so the
// provider is (re)registered once the server is initialized. Colors: semanticTokenRules() in
// ../index.ts, merged into the editor theme by the content script.

import type * as Monaco from 'monaco-editor/editor/editor.api.js';
import type * as P from 'vscode-languageserver-protocol';
import type { FeatureContext } from '../monaco-bridge';
import { toMonacoSemanticTokens } from './convert';

export function register(ctx: FeatureContext): Monaco.IDisposable {
  const { monaco, bridge } = ctx;
  const changed = new monaco.Emitter<void>();
  let provider: Monaco.IDisposable | null = null;
  let legendKey = '';

  const install = (result: P.InitializeResult | null) => {
    const sp = result?.capabilities.semanticTokensProvider;
    if (!sp) return;
    const legend = sp.legend;
    const key = JSON.stringify(legend);
    if (provider && key === legendKey) return changed.fire();
    provider?.dispose();
    legendKey = key;
    const delta = typeof sp.full === 'object' && !!sp.full.delta;
    provider = monaco.languages.registerDocumentSemanticTokensProvider(ctx.selector, {
      onDidChange: changed.event,
      getLegend: () => legend,
      async provideDocumentSemanticTokens(model, lastResultId, token) {
        if (!bridge.isOurs(model)) return null;
        const r =
          delta && lastResultId
            ? await bridge.request<P.SemanticTokens | P.SemanticTokensDelta>(
                'textDocument/semanticTokens/full/delta',
                { textDocument: bridge.textDocument, previousResultId: lastResultId } satisfies P.SemanticTokensDeltaParams,
                token,
              )
            : await bridge.request<P.SemanticTokens>(
                'textDocument/semanticTokens/full',
                { textDocument: bridge.textDocument } satisfies P.SemanticTokensParams,
                token,
              );
        return r ? toMonacoSemanticTokens(r) : null;
      },
      releaseDocumentSemanticTokens() {},
    });
  };

  install(bridge.initializeResult);
  const subs: Monaco.IDisposable[] = [
    bridge.onDidInitialize(install),
    bridge.onServerRequest('workspace/semanticTokens/refresh', () => {
      changed.fire();
      return null;
    }),
  ];
  return {
    dispose() {
      subs.forEach((s) => s.dispose());
      provider?.dispose();
      changed.dispose();
    },
  };
}
