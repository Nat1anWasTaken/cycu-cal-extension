// Read-only Monaco models for files outside the student's document (system headers such as
// file:///usr/include/wasm32-wasi/stdio.h), plus the editor opener that shows them.
//
// UX:
//   - Peek Definition (Alt-F12) / Peek References: the definition feature creates the header
//     model before returning locations, so Monaco's peek widget shows the header inline.
//   - Go to Definition (F12 / Cmd-click) and clicking an `#include` link: Monaco asks the editor
//     opener to "open" the header. We never swap the main editor's model (the content script
//     owns it); instead the opener shows the target in a peek widget at the cursor. Esc closes it.
//   - Header models are read-only: any editor showing one gets `readOnly: true`, and an edit
//     that slips through is reverted.

import type * as Monaco from 'monaco-editor/editor/editor.api.js';
import { READ_FILE_METHOD, type ReadFileParams, type ReadFileResult } from '../../shared/protocol';
import type { HeaderModelsLike, LspBridge } from '../monaco-bridge';

export class HeaderModels implements HeaderModelsLike {
  private monaco: typeof Monaco;
  private bridge: LspBridge;
  private models = new Map<string, Monaco.editor.ITextModel>();
  private inflight = new Map<string, Promise<Monaco.editor.ITextModel | null>>();
  private subs: Monaco.IDisposable[] = [];

  constructor(monaco: typeof Monaco, bridge: LspBridge) {
    this.monaco = monaco;
    this.bridge = bridge;
    this.subs.push(
      monaco.editor.registerEditorOpener({ openCodeEditor: (src, res, sel) => this.open(src, res, sel) }),
      monaco.editor.onDidCreateEditor((ed) => {
        const apply = () => {
          const m = ed.getModel();
          if (m && this.isHeader(m.uri)) ed.updateOptions({ readOnly: true });
        };
        apply();
        this.subs.push(ed.onDidChangeModel(apply));
      }),
    );
  }

  isHeader(uri: Monaco.Uri): boolean {
    return this.models.has(uri.toString());
  }

  async ensure(lspUri: string): Promise<Monaco.editor.ITextModel | null> {
    const uri = this.monaco.Uri.parse(lspUri);
    const key = uri.toString();
    const existing = this.models.get(key) ?? this.monaco.editor.getModel(uri);
    if (existing) return existing;
    let p = this.inflight.get(key);
    if (!p) {
      p = this.load(uri).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private async load(uri: Monaco.Uri): Promise<Monaco.editor.ITextModel | null> {
    const res = await this.bridge.request<ReadFileResult>(READ_FILE_METHOD, { uri: uri.toString() } satisfies ReadFileParams);
    if (res?.text == null) return null;
    const key = uri.toString();
    const already = this.monaco.editor.getModel(uri);
    if (already) return already;
    const text = res.text;
    const model = this.monaco.editor.createModel(text, 'c', uri);
    this.models.set(key, model);
    let reverting = false;
    model.onDidChangeContent(() => {
      if (reverting || model.getValue() === text) return;
      reverting = true;
      queueMicrotask(() => {
        model.setValue(text);
        reverting = false;
      });
    });
    return model;
  }

  private async open(
    source: Monaco.editor.ICodeEditor,
    resource: Monaco.Uri,
    selOrPos?: Monaco.IRange | Monaco.IPosition,
  ): Promise<boolean> {
    if (resource.scheme !== 'file' || this.bridge.toModelUri(this.bridge.uri).toString() === resource.toString()) return false;
    const range: Monaco.IRange | undefined = !selOrPos
      ? undefined
      : 'endLineNumber' in selOrPos
        ? selOrPos
        : { startLineNumber: selOrPos.lineNumber, startColumn: selOrPos.column, endLineNumber: selOrPos.lineNumber, endColumn: selOrPos.column };
    return this.peek(source, resource.toString(), range);
  }

  /**
   * Shows `lspUri` (read-only) in a peek widget inside `editor`, anchored at `anchor`
   * (default: the cursor) and revealing `range` (default: top of the file).
   */
  async peek(editor: Monaco.editor.ICodeEditor, lspUri: string, range?: Monaco.IRange, anchor?: Monaco.IPosition): Promise<boolean> {
    const model = await this.ensure(lspUri);
    const srcModel = editor.getModel();
    const pos = anchor ?? editor.getPosition();
    if (!model || !srcModel || !pos) return false;
    // Not public API: the standalone editor's command service runs the built-in
    // `editor.action.peekLocations(uri, position, locations, multiple)` command.
    const commands = (editor as unknown as { _commandService?: { executeCommand(id: string, ...args: unknown[]): Promise<unknown> } })
      ._commandService;
    if (!commands) return false;
    const target = range ?? { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
    try {
      await commands.executeCommand(
        'editor.action.peekLocations',
        srcModel.uri,
        new this.monaco.Position(pos.lineNumber, pos.column),
        [{ uri: model.uri, range: target }],
        'peek',
      );
      return true;
    } catch (e) {
      console.warn('[cal-lsp] peek failed', e);
      return false;
    }
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    for (const m of this.models.values()) m.dispose();
    this.models.clear();
  }
}
