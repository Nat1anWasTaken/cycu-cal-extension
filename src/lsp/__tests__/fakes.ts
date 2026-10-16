// A tiny stand-in for the parts of the `monaco` namespace that convert.ts reads.

import type * as Monaco from 'monaco-editor/editor/editor.api.js';

class FakeUri {
  value: string;
  constructor(v: string) {
    this.value = v;
  }
  toString(): string {
    return this.value;
  }
}

export const fakeMonaco = {
  Uri: { parse: (s: string) => new FakeUri(s) },
  MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
  MarkerTag: { Unnecessary: 1, Deprecated: 2 },
  languages: {
    CompletionItemKind: {
      Method: 0,
      Function: 1,
      Constructor: 2,
      Field: 3,
      Variable: 4,
      Class: 5,
      Struct: 6,
      Interface: 7,
      Module: 8,
      Property: 9,
      Event: 10,
      Operator: 11,
      Unit: 12,
      Value: 13,
      Constant: 14,
      Enum: 15,
      EnumMember: 16,
      Keyword: 17,
      Text: 18,
      Color: 19,
      File: 20,
      Reference: 21,
      Customcolor: 22,
      Folder: 23,
      TypeParameter: 24,
      User: 25,
      Issue: 26,
      Tool: 27,
      Snippet: 28,
    },
    CompletionItemInsertTextRule: { None: 0, KeepWhitespace: 1, InsertAsSnippet: 4 },
    CompletionItemTag: { Deprecated: 1 },
    FoldingRangeKind: { fromValue: (v: string) => ({ value: v }) },
  },
} as unknown as typeof Monaco;

export const mapUri = (u: string) => fakeMonaco.Uri.parse(u);
