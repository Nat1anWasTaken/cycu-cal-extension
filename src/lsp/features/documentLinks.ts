// `#include` links. Each link's URL is a `command:` URI for PEEK_HEADER_COMMAND, so a
// Cmd/Ctrl-click opens the header read-only in a peek widget anchored at the #include line
// (headers.ts). A command is used instead of the file:// target because Monaco's file opener
// needs a focused editor and would otherwise try to swap the main editor's model.

import type * as Monaco from 'monaco-editor/editor/editor.api.js';
import type * as P from 'vscode-languageserver-protocol';
import type { FeatureContext } from '../monaco-bridge';
import { toMonacoRange } from './convert';

export const PEEK_HEADER_COMMAND = 'cal.peekHeader';

export function linkCommandUri(target: string, line: number, column: number): string {
  return `command:${PEEK_HEADER_COMMAND}?${encodeURIComponent(JSON.stringify([target, line, column]))}`;
}

export function register(ctx: FeatureContext): Monaco.IDisposable {
  const { monaco, bridge, headers, editor } = ctx;
  const origin = new WeakMap<Monaco.languages.ILink, P.DocumentLink>();

  const command = monaco.editor.registerCommand(
    PEEK_HEADER_COMMAND,
    (_accessor, target: unknown, line: unknown, column: unknown) => {
      if (typeof target !== 'string') return;
      const anchor = typeof line === 'number' && typeof column === 'number' ? { lineNumber: line, column } : undefined;
      void headers.peek(editor, target, undefined, anchor);
    },
  );

  const toLink = (l: P.DocumentLink): Monaco.languages.ILink => {
    const range = toMonacoRange(l.range);
    const link: Monaco.languages.ILink = {
      range,
      url: l.target ? monaco.Uri.parse(linkCommandUri(l.target, range.startLineNumber, range.startColumn)) : undefined,
      tooltip:
        l.tooltip ?? (l.target ? `查看 ${decodeURIComponent(l.target.replace(/^file:\/\//, ''))}（唯讀）` : undefined),
    };
    origin.set(link, l);
    return link;
  };

  const provider = monaco.languages.registerLinkProvider(ctx.selector, {
    async provideLinks(model, token) {
      if (!bridge.isOurs(model)) return undefined;
      const r = await bridge.request<P.DocumentLink[]>(
        'textDocument/documentLink',
        { textDocument: bridge.textDocument } satisfies P.DocumentLinkParams,
        token,
      );
      const links = (r ?? []).map(toLink);
      // Warm header models in the background so a click opens instantly.
      for (const l of r ?? []) if (l.target) void headers.ensure(l.target);
      return { links };
    },
    async resolveLink(link, token) {
      const l = origin.get(link);
      if (!l || link.url) return link;
      const r = await bridge.request<P.DocumentLink>('documentLink/resolve', l, token);
      return r?.target ? toLink(r) : link;
    },
  });

  return {
    dispose() {
      provider.dispose();
      command.dispose();
    },
  };
}
