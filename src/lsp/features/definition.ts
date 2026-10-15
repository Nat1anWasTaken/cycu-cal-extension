// Definition, declaration and references. Locations in other files (system headers) get a
// read-only model first so peek and the editor opener can show them (see headers.ts).

import type * as Monaco from 'monaco-editor/editor/editor.api.js';
import type * as P from 'vscode-languageserver-protocol';
import type { FeatureContext } from '../monaco-bridge';
import { locationUris, toLspPosition, toMonacoLocations } from './convert';

type LocResult = P.Location | P.Location[] | P.LocationLink[] | null;

export function register(ctx: FeatureContext): Monaco.IDisposable {
  const { monaco, bridge, headers } = ctx;

  async function resolve(result: LocResult): Promise<Monaco.languages.LocationLink[]> {
    const external = locationUris(result).filter((u) => u !== bridge.uri);
    const missing = new Set<string>();
    await Promise.all(external.map(async (u) => ((await headers.ensure(u)) ? undefined : missing.add(u))));
    const links = toMonacoLocations(result, bridge.toModelUri);
    return missing.size ? links.filter((l) => !missing.has(l.uri.toString())) : links;
  }

  const query = (method: string) => async (model: Monaco.editor.ITextModel, position: Monaco.Position, token: Monaco.CancellationToken) => {
    if (!bridge.isOurs(model)) return undefined;
    const r = await bridge.request<LocResult>(
      method,
      { textDocument: bridge.textDocument, position: toLspPosition(position) } satisfies P.TextDocumentPositionParams,
      token,
    );
    return resolve(r);
  };

  const subs = [
    monaco.languages.registerDefinitionProvider(ctx.selector, { provideDefinition: query('textDocument/definition') }),
    monaco.languages.registerDeclarationProvider(ctx.selector, { provideDeclaration: query('textDocument/declaration') }),
    monaco.languages.registerReferenceProvider(ctx.selector, {
      async provideReferences(model, position, context, token) {
        if (!bridge.isOurs(model)) return undefined;
        const r = await bridge.request<P.Location[]>(
          'textDocument/references',
          {
            textDocument: bridge.textDocument,
            position: toLspPosition(position),
            context: { includeDeclaration: context.includeDeclaration },
          } satisfies P.ReferenceParams,
          token,
        );
        return (await resolve(r)).map((l) => ({ uri: l.uri, range: l.range }));
      },
    }),
  ];
  return { dispose: () => subs.forEach((s) => s.dispose()) };
}
