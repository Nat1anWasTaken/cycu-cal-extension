// Inlay hints (parameter names, deduced types). Refreshed on workspace/inlayHint/refresh and
// after every (re)initialize.

import type * as Monaco from 'monaco-editor/editor/editor.api.js';
import type * as P from 'vscode-languageserver-protocol';
import type { FeatureContext } from '../monaco-bridge';
import { toLspRange, toMonacoInlayHint } from './convert';

export function register(ctx: FeatureContext): Monaco.IDisposable {
  const { monaco, bridge } = ctx;
  const changed = new monaco.Emitter<void>();
  const subs: Monaco.IDisposable[] = [
    bridge.onServerRequest('workspace/inlayHint/refresh', () => {
      changed.fire();
      return null;
    }),
    bridge.onDidInitialize(() => changed.fire()),
    monaco.languages.registerInlayHintsProvider(ctx.selector, {
      displayName: 'clangd',
      onDidChangeInlayHints: changed.event,
      async provideInlayHints(model, range, token) {
        if (!bridge.isOurs(model)) return undefined;
        const r = await bridge.request<P.InlayHint[]>(
          'textDocument/inlayHint',
          { textDocument: bridge.textDocument, range: toLspRange(range) } satisfies P.InlayHintParams,
          token,
        );
        return { hints: (r ?? []).map((h) => toMonacoInlayHint(h, bridge.toModelUri)), dispose() {} };
      },
    }),
  ];
  return {
    dispose() {
      subs.forEach((s) => s.dispose());
      changed.dispose();
    },
  };
}
