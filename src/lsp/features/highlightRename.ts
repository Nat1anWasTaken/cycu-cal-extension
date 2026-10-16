// Document highlights + rename. A rename that would touch a locked line or another file is
// rejected with a message (shown by Monaco's rename widget).

import type * as Monaco from 'monaco-editor/editor/editor.api.js';
import type * as P from 'vscode-languageserver-protocol';
import type { FeatureContext } from '../monaco-bridge';
import {
  rangeTouchesLocks,
  toLspPosition,
  toMonacoHighlights,
  toMonacoRange,
  toMonacoWorkspaceEdit,
  workspaceEditRejection,
} from './convert';

export function register(ctx: FeatureContext): Monaco.IDisposable {
  const { monaco, bridge } = ctx;
  const pos = (model: Monaco.editor.ITextModel, position: Monaco.Position): P.TextDocumentPositionParams => ({
    textDocument: bridge.textDocument,
    position: toLspPosition(position),
  });

  const subs = [
    monaco.languages.registerDocumentHighlightProvider(ctx.selector, {
      async provideDocumentHighlights(model, position, token) {
        if (!bridge.isOurs(model)) return undefined;
        return toMonacoHighlights(
          await bridge.request<P.DocumentHighlight[]>('textDocument/documentHighlight', pos(model, position), token),
        );
      },
    }),
    monaco.languages.registerRenameProvider(ctx.selector, {
      async resolveRenameLocation(model, position, token) {
        if (!bridge.isOurs(model)) return undefined;
        const r = await bridge.request<P.PrepareRenameResult>(
          'textDocument/prepareRename',
          pos(model, position),
          token,
        );
        if (!r || 'defaultBehavior' in r) {
          if (r) {
            const w = model.getWordAtPosition(position);
            if (w) {
              return {
                range: {
                  startLineNumber: position.lineNumber,
                  startColumn: w.startColumn,
                  endLineNumber: position.lineNumber,
                  endColumn: w.endColumn,
                },
                text: w.word,
              };
            }
          }
          return {
            range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
            text: '',
            rejectReason: "This symbol can't be renamed.",
          };
        }
        const lspRange = 'range' in r ? r.range : r;
        const range = toMonacoRange(lspRange);
        if (rangeTouchesLocks(lspRange, ctx.getLocks())) {
          return { range, text: '', rejectReason: 'This symbol is on a locked line and cannot be renamed.' };
        }
        return { range, text: 'placeholder' in r ? r.placeholder : model.getValueInRange(range) };
      },
      async provideRenameEdits(model, position, newName, token) {
        if (!bridge.isOurs(model)) return undefined;
        const we = await bridge.request<P.WorkspaceEdit>(
          'textDocument/rename',
          { ...pos(model, position), newName } satisfies P.RenameParams,
          token,
        );
        if (!we) return { edits: [], rejectReason: 'Rename failed.' };
        const reason = workspaceEditRejection(we, bridge.uri, ctx.getLocks());
        if (reason) return { edits: [], rejectReason: `Rename rejected: ${reason}` };
        return toMonacoWorkspaceEdit(we, bridge.toModelUri, model.getVersionId());
      },
    }),
  ];
  return { dispose: () => subs.forEach((s) => s.dispose()) };
}
