// Pure LSP <-> Monaco conversions. No runtime imports (type-only), so the module runs
// under `node --test` with type stripping. Monaco enums are read from the namespace that
// the caller passes in, which lets tests use small fakes.
//
// Coordinates:
//   LSP     0-based line, 0-based UTF-16 code-unit `character`
//   Monaco  1-based lineNumber, 1-based UTF-16 `column`
//   Ace     0-based row, 0-based UTF-16 `column` (lock ranges)
// All three count UTF-16 code units, so CJK (1 unit) and astral chars such as emoji
// (2 units) line up without any re-encoding; only the 0/1 base differs.

import type * as Monaco from 'monaco-editor/editor/editor.api.js';
import type * as P from 'vscode-languageserver-protocol';
import type { LockRange } from '../../shared/protocol';

export type MonacoNS = typeof Monaco;
type IRange = Monaco.IRange;
type IPosition = Monaco.IPosition;
type MUri = Monaco.Uri;
/** Maps an LSP document URI to a Monaco URI (our model's URI for our document). */
export type UriMapper = (lspUri: string) => MUri;

// ---------------------------------------------------------------------------
// Positions and ranges
// ---------------------------------------------------------------------------

export function toLspPosition(p: IPosition): P.Position {
  return { line: p.lineNumber - 1, character: p.column - 1 };
}

export function toMonacoPosition(p: P.Position): IPosition {
  return { lineNumber: p.line + 1, column: p.character + 1 };
}

export function toLspRange(r: IRange): P.Range {
  return {
    start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
    end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
  };
}

export function toMonacoRange(r: P.Range): IRange {
  return {
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1,
  };
}

/** UTF-16 offset in `text` -> LSP position (reference implementation used by tests). */
export function offsetToLspPosition(text: string, offset: number): P.Position {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: Math.min(offset, text.length) - lineStart };
}

// ---------------------------------------------------------------------------
// Locked ranges (Ace coordinates, which equal LSP coordinates)
// ---------------------------------------------------------------------------

function cmp(aRow: number, aCol: number, bRow: number, bCol: number): number {
  return aRow !== bRow ? aRow - bRow : aCol - bCol;
}

/**
 * True if an edit over `r` would modify a locked region. Mirrors the site's rule
 * ("reject when the edit starts before the lock end"), restricted to edits that reach the
 * lock: an edit starting exactly at the lock end is allowed; one ending exactly at the lock
 * start is rejected (it would join or move the first locked line).
 */
export function rangeTouchesLock(r: P.Range, lock: LockRange): boolean {
  return (
    cmp(r.start.line, r.start.character, lock.end.row, lock.end.column) < 0 &&
    cmp(r.end.line, r.end.character, lock.start.row, lock.start.column) >= 0
  );
}

export function rangeTouchesLocks(r: P.Range, locks: readonly LockRange[]): LockRange | undefined {
  return locks.find((l) => rangeTouchesLock(r, l));
}

/** Splits text edits into those that are safe and those that touch a lock. */
export function filterEditsByLocks<T extends { range: P.Range }>(
  edits: readonly T[],
  locks: readonly LockRange[],
): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const e of edits) (rangeTouchesLocks(e.range, locks) ? dropped : kept).push(e);
  return { kept, dropped };
}

export function toMonacoTextEdit(e: P.TextEdit): Monaco.languages.TextEdit {
  return { range: toMonacoRange(e.range), text: e.newText };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

export function toMarkdown(
  doc: string | P.MarkupContent | P.MarkedString | undefined | null,
): string | Monaco.IMarkdownString | undefined {
  if (doc == null) return undefined;
  if (typeof doc === 'string') return doc;
  if ('kind' in doc) return doc.kind === 'markdown' ? { value: doc.value } : doc.value;
  return { value: '```' + doc.language + '\n' + doc.value + '\n```' };
}

export function hoverContents(c: P.Hover['contents']): Monaco.IMarkdownString[] {
  const list = Array.isArray(c) ? c : [c];
  const out: Monaco.IMarkdownString[] = [];
  for (const item of list) {
    if (typeof item === 'string') out.push({ value: item }); // MarkedString strings are markdown
    else if ('kind' in item) out.push({ value: item.kind === 'markdown' ? item.value : escapeMarkdown(item.value) });
    else out.push({ value: '```' + item.language + '\n' + item.value + '\n```' });
  }
  return out.filter((m) => m.value.trim() !== '');
}

function escapeMarkdown(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

/** LSP CompletionItemKind (1-based) -> Monaco enum member name. */
const COMPLETION_KIND_NAMES = [
  '', 'Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module',
  'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder',
  'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter',
] as const;

export function toMonacoCompletionKind(m: MonacoNS, kind: number | undefined): Monaco.languages.CompletionItemKind {
  const K = m.languages.CompletionItemKind as unknown as Record<string, number>;
  const name = (kind && COMPLETION_KIND_NAMES[kind]) || 'Text';
  return (K[name] ?? K.Text) as Monaco.languages.CompletionItemKind;
}

/** clangd prefixes labels with a space, or a bullet when an #include would be inserted. */
export function trimCompletionLabel(label: string): string {
  return label.replace(/^[\s•·]+/, '');
}

type MRangeOrRanges = IRange | Monaco.languages.CompletionItemRanges;

function editRange(r: P.Range | { insert: P.Range; replace: P.Range }): MRangeOrRanges {
  return 'insert' in r ? { insert: toMonacoRange(r.insert), replace: toMonacoRange(r.replace) } : toMonacoRange(r);
}

export function toMonacoCompletion(
  m: MonacoNS,
  item: P.CompletionItem,
  defaultRange: MRangeOrRanges,
  defaults?: P.CompletionList['itemDefaults'],
): Monaco.languages.CompletionItem {
  const name = trimCompletionLabel(item.label);
  const label: string | Monaco.languages.CompletionItemLabel = item.labelDetails
    ? { label: name, detail: item.labelDetails.detail, description: item.labelDetails.description }
    : name;

  let insertText: string;
  let range: MRangeOrRanges;
  const te = item.textEdit;
  if (te) {
    insertText = te.newText;
    range = editRange('range' in te ? te.range : te);
  } else {
    insertText = item.textEditText ?? item.insertText ?? name;
    range = defaults?.editRange ? editRange(defaults.editRange) : defaultRange;
  }

  const format = item.insertTextFormat ?? defaults?.insertTextFormat;
  const out: Monaco.languages.CompletionItem = {
    label,
    kind: toMonacoCompletionKind(m, item.kind),
    insertText,
    range,
  };
  if (format === 2) out.insertTextRules = m.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  if (item.detail) out.detail = item.detail;
  const doc = toMarkdown(item.documentation);
  if (doc !== undefined) out.documentation = doc;
  if (item.filterText) out.filterText = item.filterText;
  else if (name !== item.label) out.filterText = name;
  if (item.sortText) out.sortText = item.sortText;
  if (item.preselect) out.preselect = true;
  const commit = item.commitCharacters ?? defaults?.commitCharacters;
  if (commit) out.commitCharacters = commit;
  if (item.additionalTextEdits?.length) out.additionalTextEdits = item.additionalTextEdits.map(toMonacoTextEdit);
  if (item.deprecated || item.tags?.includes(1)) out.tags = [m.languages.CompletionItemTag.Deprecated];
  return out;
}

export function completionItems(result: P.CompletionItem[] | P.CompletionList | null | undefined): {
  items: P.CompletionItem[];
  incomplete: boolean;
  defaults?: P.CompletionList['itemDefaults'];
} {
  if (!result) return { items: [], incomplete: false };
  if (Array.isArray(result)) return { items: result, incomplete: false };
  return { items: result.items, incomplete: result.isIncomplete, defaults: result.itemDefaults };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export function toMarkerSeverity(m: MonacoNS, s: P.DiagnosticSeverity | undefined): Monaco.MarkerSeverity {
  switch (s) {
    case 2: return m.MarkerSeverity.Warning;
    case 3: return m.MarkerSeverity.Info;
    case 4: return m.MarkerSeverity.Hint;
    default: return m.MarkerSeverity.Error;
  }
}

export function diagnosticMessage(d: P.Diagnostic): string {
  return typeof d.message === 'string' ? d.message : d.message.value;
}

export function toMarker(m: MonacoNS, d: P.Diagnostic, mapUri: UriMapper): Monaco.editor.IMarkerData {
  const r = toMonacoRange(d.range);
  const marker: Monaco.editor.IMarkerData = {
    severity: toMarkerSeverity(m, d.severity),
    message: diagnosticMessage(d),
    source: d.source,
    ...r,
  };
  if (d.code !== undefined) {
    marker.code = d.codeDescription
      ? { value: String(d.code), target: m.Uri.parse(d.codeDescription.href) }
      : String(d.code);
  }
  if (d.tags?.length) {
    marker.tags = d.tags.map((t) => (t === 1 ? m.MarkerTag.Unnecessary : m.MarkerTag.Deprecated));
  }
  if (d.relatedInformation?.length) {
    marker.relatedInformation = d.relatedInformation.map((ri) => ({
      resource: mapUri(ri.location.uri),
      message: ri.message,
      ...toMonacoRange(ri.location.range),
    }));
  }
  return marker;
}

/** Finds the LSP diagnostic a Monaco marker was created from (for code action context). */
export function diagnosticForMarker(
  marker: Monaco.editor.IMarkerData,
  diagnostics: readonly P.Diagnostic[],
): P.Diagnostic | undefined {
  return diagnostics.find((d) => {
    const r = toMonacoRange(d.range);
    return (
      diagnosticMessage(d) === marker.message &&
      r.startLineNumber === marker.startLineNumber &&
      r.startColumn === marker.startColumn &&
      r.endLineNumber === marker.endLineNumber &&
      r.endColumn === marker.endColumn
    );
  });
}

// ---------------------------------------------------------------------------
// Workspace edits
// ---------------------------------------------------------------------------

export interface FlatEdit {
  uri: string;
  edit: P.TextEdit;
  version?: number | null;
}

/** Flattens `changes` / `documentChanges`. File operations (create/rename/delete) are reported separately. */
export function flattenWorkspaceEdit(we: P.WorkspaceEdit): { edits: FlatEdit[]; fileOps: number } {
  const edits: FlatEdit[] = [];
  let fileOps = 0;
  if (we.documentChanges) {
    for (const dc of we.documentChanges) {
      if ('textDocument' in dc) {
        for (const e of dc.edits) {
          // SnippetTextEdit (3.18) carries `snippet` instead of `newText`; apply its text literally.
          const edit: P.TextEdit = 'snippet' in e ? { range: e.range, newText: e.snippet.value } : e;
          edits.push({ uri: dc.textDocument.uri, edit, version: dc.textDocument.version });
        }
      } else fileOps++;
    }
  } else if (we.changes) {
    for (const [uri, list] of Object.entries(we.changes)) for (const e of list) edits.push({ uri, edit: e });
  }
  return { edits, fileOps };
}

/**
 * Why a workspace edit can't be applied to our document, or undefined if it can.
 * Edits outside `docUri` (e.g. system headers) and edits touching locks are rejected.
 */
export function workspaceEditRejection(
  we: P.WorkspaceEdit,
  docUri: string,
  locks: readonly LockRange[],
): string | undefined {
  const { edits, fileOps } = flattenWorkspaceEdit(we);
  if (fileOps) return 'This change would create, rename or delete files.';
  for (const { uri, edit } of edits) {
    if (uri !== docUri) return `This change would modify another file (${uri.replace(/^file:\/\//, '')}).`;
    const lock = rangeTouchesLocks(edit.range, locks);
    if (lock) {
      const a = lock.start.row + 1;
      const b = lock.end.row + 1;
      return `This change would modify locked line${a === b ? ` ${a}` : `s ${a}-${b}`}.`;
    }
  }
  return undefined;
}

export function toMonacoWorkspaceEdit(
  we: P.WorkspaceEdit,
  mapUri: UriMapper,
  versionId?: number,
): Monaco.languages.WorkspaceEdit {
  return {
    edits: flattenWorkspaceEdit(we).edits.map(
      ({ uri, edit }): Monaco.languages.IWorkspaceTextEdit => ({
        resource: mapUri(uri),
        textEdit: toMonacoTextEdit(edit),
        versionId,
      }),
    ),
  };
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

export function toMonacoLocations(
  result: P.Location | P.Location[] | P.LocationLink[] | null | undefined,
  mapUri: UriMapper,
): Monaco.languages.LocationLink[] {
  if (!result) return [];
  const list = (Array.isArray(result) ? result : [result]) as Array<P.Location | P.LocationLink>;
  return list.map((l) =>
    'targetUri' in l
      ? {
          uri: mapUri(l.targetUri),
          range: toMonacoRange(l.targetRange),
          targetSelectionRange: toMonacoRange(l.targetSelectionRange),
          originSelectionRange: l.originSelectionRange && toMonacoRange(l.originSelectionRange),
        }
      : { uri: mapUri(l.uri), range: toMonacoRange(l.range) },
  );
}

export function locationUris(result: P.Location | P.Location[] | P.LocationLink[] | null | undefined): string[] {
  if (!result) return [];
  const list = (Array.isArray(result) ? result : [result]) as Array<P.Location | P.LocationLink>;
  return [...new Set(list.map((l) => ('targetUri' in l ? l.targetUri : l.uri)))];
}

// ---------------------------------------------------------------------------
// Symbols, highlights, folding, inlay hints, signature help, semantic tokens
// ---------------------------------------------------------------------------

export function toMonacoSymbols(
  result: P.DocumentSymbol[] | P.SymbolInformation[] | null | undefined,
): Monaco.languages.DocumentSymbol[] {
  if (!result) return [];
  return (result as Array<P.DocumentSymbol | P.SymbolInformation>).map(function conv(s): Monaco.languages.DocumentSymbol {
    const tags = s.tags?.includes(1) || s.deprecated ? [1] : [];
    if ('location' in s) {
      const r = toMonacoRange(s.location.range);
      return { name: s.name, detail: '', kind: s.kind - 1, tags, containerName: s.containerName, range: r, selectionRange: r };
    }
    return {
      name: s.name,
      detail: s.detail ?? '',
      kind: s.kind - 1,
      tags,
      range: toMonacoRange(s.range),
      selectionRange: toMonacoRange(s.selectionRange),
      children: s.children?.map(conv),
    };
  });
}

export function toMonacoHighlights(result: P.DocumentHighlight[] | null | undefined): Monaco.languages.DocumentHighlight[] {
  return (result ?? []).map((h) => ({ range: toMonacoRange(h.range), kind: (h.kind ?? 1) - 1 }));
}

export function toMonacoFoldingRanges(
  m: MonacoNS,
  result: P.FoldingRange[] | null | undefined,
): Monaco.languages.FoldingRange[] {
  const out: Monaco.languages.FoldingRange[] = [];
  for (const r of result ?? []) {
    if (r.endLine <= r.startLine) continue;
    const fr: Monaco.languages.FoldingRange = { start: r.startLine + 1, end: r.endLine + 1 };
    if (r.kind) fr.kind = m.languages.FoldingRangeKind.fromValue(r.kind);
    out.push(fr);
  }
  return out;
}

export function toMonacoInlayHint(h: P.InlayHint, mapUri: UriMapper): Monaco.languages.InlayHint {
  const label =
    typeof h.label === 'string'
      ? h.label
      : h.label.map((p) => ({
          label: p.value,
          tooltip: toMarkdown(p.tooltip),
          location: p.location && { uri: mapUri(p.location.uri), range: toMonacoRange(p.location.range) },
        }));
  return {
    label,
    position: toMonacoPosition(h.position),
    kind: h.kind,
    paddingLeft: h.paddingLeft,
    paddingRight: h.paddingRight,
    tooltip: toMarkdown(h.tooltip),
    textEdits: h.textEdits?.map(toMonacoTextEdit),
  };
}

export function toMonacoSignatureHelp(sh: P.SignatureHelp): Monaco.languages.SignatureHelp {
  return {
    signatures: sh.signatures.map((s) => ({
      label: s.label,
      documentation: toMarkdown(s.documentation),
      parameters: (s.parameters ?? []).map((p) => ({ label: p.label, documentation: toMarkdown(p.documentation) })),
      activeParameter: s.activeParameter ?? undefined,
    })),
    activeSignature: sh.activeSignature ?? 0,
    activeParameter: sh.activeParameter ?? 0,
  };
}

export function toMonacoSemanticTokens(
  r: P.SemanticTokens | P.SemanticTokensDelta,
): Monaco.languages.SemanticTokens | Monaco.languages.SemanticTokensEdits {
  if ('edits' in r) {
    return {
      resultId: r.resultId,
      edits: r.edits.map((e) => ({ start: e.start, deleteCount: e.deleteCount, data: e.data && new Uint32Array(e.data) })),
    };
  }
  return { resultId: r.resultId, data: new Uint32Array(r.data) };
}
