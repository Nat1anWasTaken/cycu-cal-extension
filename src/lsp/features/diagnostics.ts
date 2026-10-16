// Diagnostics (publishDiagnostics -> markers, owner 'clangd') + clang fix-its as quick fixes.

import type * as Monaco from 'monaco-editor/editor/editor.api.js';
import type * as P from 'vscode-languageserver-protocol';
import type { FeatureContext } from '../monaco-bridge';
import { diagnosticForMarker, toLspRange, toMarker, toMonacoWorkspaceEdit, workspaceEditRejection } from './convert';

export const MARKER_OWNER = 'clangd';

export function register(ctx: FeatureContext): Monaco.IDisposable {
  const { monaco, model, bridge } = ctx;
  let diagnostics: P.Diagnostic[] = [];

  const apply = (list: P.Diagnostic[]) => {
    diagnostics = list;
    if (model.isDisposed()) return;
    monaco.editor.setModelMarkers(
      model,
      MARKER_OWNER,
      list.map((d) => toMarker(monaco, d, bridge.toModelUri)),
    );
  };
  apply(bridge.lastDiagnostics);

  const subs: Monaco.IDisposable[] = [
    bridge.onNotification<P.PublishDiagnosticsParams>('textDocument/publishDiagnostics', (p) => {
      if (p.uri === bridge.uri) apply(p.diagnostics);
    }),
    monaco.languages.registerCodeActionProvider(
      ctx.selector,
      {
        async provideCodeActions(m, range, context, token) {
          if (!bridge.isOurs(m)) return undefined;
          const diags = context.markers
            .filter(
              (mk) =>
                (mk as { owner?: string }).owner === undefined || (mk as { owner?: string }).owner === MARKER_OWNER,
            )
            .map((mk) => diagnosticForMarker(mk, diagnostics))
            .filter((d): d is P.Diagnostic => !!d);
          const result = await bridge.request<Array<P.Command | P.CodeAction>>(
            'textDocument/codeAction',
            {
              textDocument: bridge.textDocument,
              range: toLspRange(range),
              context: {
                diagnostics: diags,
                only: context.only ? [context.only] : undefined,
                triggerKind: context.trigger,
              },
            } satisfies P.CodeActionParams,
            token,
          );
          const locks = ctx.getLocks();
          const actions: Monaco.languages.CodeAction[] = [];
          for (const a of result ?? []) {
            // Only literal actions carrying an edit (clang fix-its). Commands (tweaks) need
            // workspace/executeCommand + applyEdit, which we don't support.
            if (!('edit' in a) || !a.edit) continue;
            if (workspaceEditRejection(a.edit, bridge.uri, locks)) continue;
            actions.push({
              title: a.title,
              kind: a.kind,
              isPreferred: a.isPreferred,
              diagnostics: a.diagnostics?.map((d) => toMarker(monaco, d, bridge.toModelUri)),
              edit: toMonacoWorkspaceEdit(a.edit, bridge.toModelUri, m.getVersionId()),
            });
          }
          return { actions, dispose() {} };
        },
      },
      { providedCodeActionKinds: ['quickfix'] },
    ),
  ];

  return {
    dispose() {
      for (const s of subs) s.dispose();
      if (!model.isDisposed()) monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
    },
  };
}
