// Signature help: triggers `(` `,`, retrigger `)`.

import type * as Monaco from 'monaco-editor/editor/editor.api.js';
import type * as P from 'vscode-languageserver-protocol';
import type { FeatureContext } from '../monaco-bridge';
import { toLspPosition, toMonacoSignatureHelp } from './convert';

export function register(ctx: FeatureContext): Monaco.IDisposable {
  const { monaco, bridge } = ctx;
  return monaco.languages.registerSignatureHelpProvider(ctx.selector, {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [')'],
    async provideSignatureHelp(model, position, token, context) {
      if (!bridge.isOurs(model)) return undefined;
      const r = await bridge.request<P.SignatureHelp>(
        'textDocument/signatureHelp',
        {
          textDocument: bridge.textDocument,
          position: toLspPosition(position),
          context: {
            triggerKind: context.triggerKind as unknown as P.SignatureHelpTriggerKind,
            triggerCharacter: context.triggerCharacter,
            isRetrigger: context.isRetrigger,
          },
        } satisfies P.SignatureHelpParams,
        token,
      );
      if (!r || !r.signatures.length) return undefined;
      return { value: toMonacoSignatureHelp(r), dispose() {} };
    },
  });
}
