// Hover (markdown).

import type * as Monaco from 'monaco-editor/editor/editor.api.js';
import type * as P from 'vscode-languageserver-protocol';
import type { FeatureContext } from '../monaco-bridge';
import { hoverContents, toLspPosition, toMonacoRange } from './convert';

export function register(ctx: FeatureContext): Monaco.IDisposable {
  const { monaco, bridge } = ctx;
  return monaco.languages.registerHoverProvider(ctx.selector, {
    async provideHover(model, position, token) {
      if (!bridge.isOurs(model)) return undefined;
      const h = await bridge.request<P.Hover>(
        'textDocument/hover',
        { textDocument: bridge.textDocument, position: toLspPosition(position) } satisfies P.HoverParams,
        token,
      );
      if (!h) return undefined;
      const contents = hoverContents(h.contents);
      if (!contents.length) return undefined;
      return { contents, range: h.range && toMonacoRange(h.range) };
    },
  });
}
