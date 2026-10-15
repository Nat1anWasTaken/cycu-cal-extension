import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../features/convert.ts';
import { fakeMonaco as m, mapUri } from './fakes.ts';
import type { LockRange } from '../../shared/protocol';

const R = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});

test('positions: LSP 0-based <-> Monaco 1-based, round trip', () => {
  assert.deepEqual(C.toMonacoPosition({ line: 0, character: 0 }), { lineNumber: 1, column: 1 });
  assert.deepEqual(C.toLspPosition({ lineNumber: 3, column: 7 }), { line: 2, character: 6 });
  const r = R(1, 2, 3, 4);
  assert.deepEqual(C.toLspRange(C.toMonacoRange(r)), r);
});

test('positions: CJK and astral characters count as UTF-16 units on both sides', () => {
  const text = 'int main() {\n\t// 中文註解 😀 x\n}';
  const line = text.split('\n')[1];
  // Monaco columns are UTF-16 based: column of `x` = index + 1.
  const idx = line.indexOf('x');
  assert.equal(idx, 12); // \t / / sp 中 文 註 解 sp 😀(2 units) sp
  const lsp = C.offsetToLspPosition(text, text.indexOf('x'));
  assert.deepEqual(lsp, { line: 1, character: 12 });
  assert.deepEqual(C.toMonacoPosition(lsp), { lineNumber: 2, column: 13 });
  // Position just after the emoji (a surrogate pair).
  const afterEmoji = C.offsetToLspPosition(text, text.indexOf('😀') + 2);
  assert.equal(afterEmoji.character, 11);
});

const locks: LockRange[] = [{ start: { row: 0, column: 0 }, end: { row: 2, column: 5 } }];

test('locks: edits intersecting a lock are detected', () => {
  assert.ok(C.rangeTouchesLock(R(1, 0, 1, 3), locks[0]), 'inside');
  assert.ok(C.rangeTouchesLock(R(0, 0, 0, 0), locks[0]), 'insert at lock start');
  assert.ok(C.rangeTouchesLock(R(2, 4, 3, 0), locks[0]), 'straddles lock end');
  assert.ok(!C.rangeTouchesLock(R(2, 5, 2, 5), locks[0]), 'insert exactly at lock end is allowed');
  assert.ok(!C.rangeTouchesLock(R(3, 0, 4, 0), locks[0]), 'after lock');
  const later: LockRange = { start: { row: 5, column: 0 }, end: { row: 6, column: 2 } };
  assert.ok(C.rangeTouchesLock(R(4, 3, 5, 0), later), 'deletion ending at lock start joins lines');
  assert.ok(!C.rangeTouchesLock(R(3, 0, 4, 9), later), 'before lock');
});

test('locks: filterEditsByLocks keeps the safe edits', () => {
  const edits = [
    { range: R(0, 4, 0, 5), newText: '\t' },
    { range: R(4, 0, 4, 2), newText: '\t' },
    { range: R(2, 5, 2, 5), newText: ' ' },
  ];
  const { kept, dropped } = C.filterEditsByLocks(edits, locks);
  assert.deepEqual(kept.map((e) => e.range.start.line), [4, 2]);
  assert.deepEqual(dropped.map((e) => e.range.start.line), [0]);
});

test('completion: snippet, textEdit, label trimming, kinds, additionalTextEdits', () => {
  const item = C.toMonacoCompletion(
    m,
    {
      label: ' printf(const char *restrict format, ...)',
      kind: 3,
      detail: 'int',
      sortText: '0001',
      insertTextFormat: 2,
      textEdit: { range: R(3, 1, 3, 4), newText: 'printf(${1:const char *restrict format, ...})' },
      additionalTextEdits: [{ range: R(0, 0, 0, 0), newText: '#include <stdio.h>\n' }],
      documentation: { kind: 'markdown', value: '**doc**' },
    },
    { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
  );
  assert.equal(item.label, 'printf(const char *restrict format, ...)');
  assert.equal(item.filterText, 'printf(const char *restrict format, ...)');
  assert.equal(item.kind, m.languages.CompletionItemKind.Function);
  assert.equal(item.insertTextRules, 4);
  assert.equal(item.insertText, 'printf(${1:const char *restrict format, ...})');
  assert.deepEqual(item.range, { startLineNumber: 4, startColumn: 2, endLineNumber: 4, endColumn: 5 });
  assert.deepEqual(item.additionalTextEdits, [
    { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: '#include <stdio.h>\n' },
  ]);
  assert.deepEqual(item.documentation, { value: '**doc**' });
  assert.equal(item.sortText, '0001');
  assert.equal(item.detail, 'int');

  const bullet = C.toMonacoCompletion(m, { label: '•strlen(const char *s)', kind: 3, filterText: 'strlen', insertText: 'strlen' }, {
    startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 5,
  });
  assert.equal(bullet.label, 'strlen(const char *s)');
  assert.equal(bullet.filterText, 'strlen');
  assert.equal(bullet.insertTextRules, undefined);
  assert.deepEqual(bullet.range, { startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 5 });

  const ir = C.toMonacoCompletion(m, { label: 'stdio.h>', kind: 17, textEdit: { insert: R(0, 10, 0, 13), replace: R(0, 10, 0, 18), newText: 'stdio.h>' } }, {
    startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1,
  });
  assert.equal(ir.kind, m.languages.CompletionItemKind.File);
  assert.deepEqual(ir.range, {
    insert: { startLineNumber: 1, startColumn: 11, endLineNumber: 1, endColumn: 14 },
    replace: { startLineNumber: 1, startColumn: 11, endLineNumber: 1, endColumn: 19 },
  });

  const kw = C.toMonacoCompletion(m, { label: 'struct', kind: 14, deprecated: true }, { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 });
  assert.equal(kw.kind, m.languages.CompletionItemKind.Keyword);
  assert.equal(kw.insertText, 'struct');
  assert.deepEqual(kw.tags, [1]);
  assert.equal(C.toMonacoCompletionKind(m, 22), m.languages.CompletionItemKind.Struct);
  assert.equal(C.toMonacoCompletionKind(m, 999), m.languages.CompletionItemKind.Text);
});

test('completion: CompletionList itemDefaults', () => {
  const { items, incomplete, defaults } = C.completionItems({
    isIncomplete: true,
    itemDefaults: { editRange: R(0, 0, 0, 2), insertTextFormat: 2 },
    items: [{ label: 'x', insertText: 'x($1)' }],
  });
  assert.equal(incomplete, true);
  const it = C.toMonacoCompletion(m, items[0], { startLineNumber: 9, startColumn: 9, endLineNumber: 9, endColumn: 9 }, defaults);
  assert.deepEqual(it.range, { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 3 });
  assert.equal(it.insertTextRules, 4);
  assert.deepEqual(C.completionItems(null).items, []);
});

test('markers: severity, code, tags, relatedInformation', () => {
  const mk = C.toMarker(
    m,
    {
      range: R(4, 9, 4, 12),
      severity: 2,
      code: '-Wint-conversion',
      source: 'clang',
      message: 'incompatible pointer to integer conversion',
      tags: [1, 2],
      relatedInformation: [{ location: { uri: 'file:///usr/include/stdio.h', range: R(0, 0, 0, 1) }, message: 'declared here' }],
    },
    mapUri,
  );
  assert.equal(mk.severity, 4);
  assert.equal(mk.code, '-Wint-conversion');
  assert.equal(mk.source, 'clang');
  assert.deepEqual(mk.tags, [1, 2]);
  assert.equal(mk.startLineNumber, 5);
  assert.equal(mk.startColumn, 10);
  assert.equal(mk.endColumn, 13);
  assert.equal(mk.relatedInformation![0].resource.toString(), 'file:///usr/include/stdio.h');
  assert.equal(mk.relatedInformation![0].message, 'declared here');
  assert.equal(C.toMarker(m, { range: R(0, 0, 0, 1), message: 'e' }, mapUri).severity, 8);
  assert.equal(C.toMarker(m, { range: R(0, 0, 0, 1), message: 'e', severity: 4 }, mapUri).severity, 1);
  const withHref = C.toMarker(m, { range: R(0, 0, 0, 1), message: 'e', code: 1, codeDescription: { href: 'https://x/y' } }, mapUri);
  assert.equal((withHref.code as { value: string }).value, '1');
  const diag = { range: R(4, 9, 4, 12), message: 'incompatible pointer to integer conversion' };
  assert.equal(C.diagnosticForMarker(mk, [{ range: R(0, 0, 0, 1), message: 'x' }, diag]), diag);
});

test('workspace edits: mapping and lock/other-file rejection', () => {
  const doc = 'file:///workspace/1-abc.c';
  const we = {
    changes: {
      [doc]: [
        { range: R(5, 4, 5, 7), newText: 'cnt' },
        { range: R(7, 1, 7, 4), newText: 'cnt' },
      ],
    },
  };
  const mapped = C.toMonacoWorkspaceEdit(we, mapUri, 3);
  assert.equal(mapped.edits.length, 2);
  const e0 = mapped.edits[0] as { resource: { toString(): string }; textEdit: unknown; versionId: number };
  assert.equal(e0.resource.toString(), doc);
  assert.deepEqual(e0.textEdit, { range: { startLineNumber: 6, startColumn: 5, endLineNumber: 6, endColumn: 8 }, text: 'cnt' });
  assert.equal(e0.versionId, 3);

  assert.equal(C.workspaceEditRejection(we, doc, []), undefined);
  assert.match(C.workspaceEditRejection(we, doc, [{ start: { row: 7, column: 0 }, end: { row: 7, column: 20 } }])!, /locked line 8/);
  assert.match(C.workspaceEditRejection(we, doc, [{ start: { row: 4, column: 0 }, end: { row: 5, column: 20 } }])!, /locked lines 5-6/);

  const dc = {
    documentChanges: [
      { textDocument: { uri: doc, version: 2 }, edits: [{ range: R(1, 0, 1, 1), newText: 'a' }] },
      { textDocument: { uri: 'file:///usr/include/stdio.h', version: null }, edits: [{ range: R(1, 0, 1, 1), newText: 'a' }] },
    ],
  };
  assert.equal(C.flattenWorkspaceEdit(dc).edits.length, 2);
  assert.match(C.workspaceEditRejection(dc, doc, [])!, /another file/);
  assert.match(C.workspaceEditRejection({ documentChanges: [{ kind: 'create', uri: 'file:///x.c' }] }, doc, [])!, /files/);
});

test('locations, symbols, highlights, folding, hover, signature help, semantic tokens', () => {
  const locs = C.toMonacoLocations(
    [{ targetUri: 'file:///usr/include/stdio.h', targetRange: R(10, 0, 10, 40), targetSelectionRange: R(10, 4, 10, 10), originSelectionRange: R(2, 1, 2, 7) }],
    mapUri,
  );
  assert.equal(locs[0].uri.toString(), 'file:///usr/include/stdio.h');
  assert.equal(locs[0].range.startLineNumber, 11);
  assert.equal(locs[0].targetSelectionRange!.startColumn, 5);
  assert.deepEqual(C.locationUris({ uri: 'file:///a.c', range: R(0, 0, 0, 0) }), ['file:///a.c']);
  assert.deepEqual(C.toMonacoLocations(null, mapUri), []);

  const syms = C.toMonacoSymbols([
    { name: 'main', detail: 'int ()', kind: 12, range: R(2, 0, 5, 1), selectionRange: R(2, 4, 2, 8), children: [{ name: 'x', kind: 13, range: R(3, 1, 3, 9), selectionRange: R(3, 5, 3, 6) }] },
  ]);
  assert.equal(syms[0].kind, 11); // Function
  assert.equal(syms[0].children![0].kind, 12); // Variable
  assert.equal(syms[0].children![0].detail, '');

  assert.deepEqual(C.toMonacoHighlights([{ range: R(0, 0, 0, 1), kind: 3 }, { range: R(0, 0, 0, 1) }]).map((h) => h.kind), [2, 0]);

  const folds = C.toMonacoFoldingRanges(m, [{ startLine: 2, endLine: 5, kind: 'comment' }, { startLine: 7, endLine: 7 }]);
  assert.equal(folds.length, 1);
  assert.equal(folds[0].start, 3);
  assert.equal(folds[0].end, 6);

  assert.deepEqual(C.hoverContents({ kind: 'markdown', value: '### printf' }), [{ value: '### printf' }]);
  assert.deepEqual(C.hoverContents([{ language: 'c', value: 'int x' }]), [{ value: '```c\nint x\n```' }]);
  assert.deepEqual(C.hoverContents({ kind: 'plaintext', value: 'a*b' }), [{ value: 'a\\*b' }]);

  const sh = C.toMonacoSignatureHelp({ signatures: [{ label: 'int f(int a)', parameters: [{ label: [6, 11] }] }], activeParameter: 0 });
  assert.equal(sh.activeSignature, 0);
  assert.deepEqual(sh.signatures[0].parameters[0].label, [6, 11]);

  const full = C.toMonacoSemanticTokens({ resultId: '1', data: [0, 4, 4, 12, 3] }) as { data: Uint32Array; resultId: string };
  assert.ok(full.data instanceof Uint32Array);
  assert.equal(full.resultId, '1');
  const delta = C.toMonacoSemanticTokens({ resultId: '2', edits: [{ start: 0, deleteCount: 5, data: [1, 2, 3, 4, 5] }] }) as {
    edits: Array<{ data?: Uint32Array }>;
  };
  assert.ok(delta.edits[0].data instanceof Uint32Array);

  const hint = C.toMonacoInlayHint({ position: { line: 3, character: 9 }, label: 'format:', kind: 2, paddingRight: true }, mapUri);
  assert.deepEqual(hint.position, { lineNumber: 4, column: 10 });
  assert.equal(hint.kind, 2);
});
