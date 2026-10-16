// Public entry of the LSP layer. The content script calls startLanguageFeatures() once Monaco
// and the model exist, forwards settings changes to updateSettings(), and merges
// semanticTokenRules() into its theme:
//
//   monaco.editor.defineTheme('cal-light', {
//     base: 'vs', inherit: true, colors: {},
//     rules: [...ownRules, ...semanticTokenRules('light')],
//   });
//   // and 'cal-dark' with base 'vs-dark' + semanticTokenRules('dark');
//   // editor option 'semanticHighlighting.enabled': true
//
// Rule tokens are clangd semantic token types ('function', 'macro', 'parameter', ...). The
// standalone theme matches `type.modifier1.modifier2` by longest dotted prefix, so per-type
// rules always apply; a few `type.modifier` rules refine the common cases.

import type * as Monaco from 'monaco-editor/editor/editor.api.js';
import type { LockRange, ServerStatus } from '../shared/protocol';
import type { FeatureId, Settings } from '../shared/settings';
import { HeaderModels } from './features/headers';
import { LspBridge, type FeatureContext, type FeatureRegister } from './monaco-bridge';
import * as completion from './features/completion';
import * as definition from './features/definition';
import * as diagnostics from './features/diagnostics';
import * as documentLinks from './features/documentLinks';
import * as folding from './features/folding';
import * as formatting from './features/formatting';
import * as highlightRename from './features/highlightRename';
import * as hover from './features/hover';
import * as inlayHints from './features/inlayHints';
import * as outline from './features/outline';
import * as semanticTokens from './features/semanticTokens';
import * as signatureHelp from './features/signatureHelp';

export interface LanguageFeaturesOptions {
  monaco: typeof Monaco;
  editor: Monaco.editor.IStandaloneCodeEditor;
  model: Monaco.editor.ITextModel;
  topicId: string;
  settings: Settings;
  /** Current locked ranges (Ace coordinates, 0-indexed). Rename/format edits touching them must be rejected. */
  getLocks: () => LockRange[];
  onStatus: (status: ServerStatus, detail?: string) => void;
}

export interface LanguageFeatures {
  /** Re-register/dispose providers to match new settings (feature toggles, compile flags). */
  updateSettings(settings: Settings): void;
  dispose(): void;
}

/** LSP-backed features (inlineCompletion belongs to the SLM slice). */
const FEATURES: Partial<Record<FeatureId, FeatureRegister>> = {
  diagnostics: diagnostics.register,
  completion: completion.register,
  hover: hover.register,
  signatureHelp: signatureHelp.register,
  formatting: formatting.register,
  definition: definition.register,
  highlightRename: highlightRename.register,
  outline: outline.register,
  folding: folding.register,
  inlayHints: inlayHints.register,
  semanticTokens: semanticTokens.register,
  documentLinks: documentLinks.register,
};

export function startLanguageFeatures(opts: LanguageFeaturesOptions): LanguageFeatures {
  const { monaco, editor, model } = opts;
  const bridge = new LspBridge({
    monaco,
    model,
    topicId: opts.topicId,
    compileFlags: [...opts.settings.compileFlags],
    onStatus: opts.onStatus,
  });
  const headers = new HeaderModels(monaco, bridge);
  const ctx: FeatureContext = {
    monaco,
    editor,
    model,
    bridge,
    headers,
    getLocks: opts.getLocks,
    selector: model.getLanguageId(),
  };
  const active = new Map<FeatureId, Monaco.IDisposable>();
  let disposed = false;

  const apply = (s: Settings) => {
    for (const [id, reg] of Object.entries(FEATURES) as Array<[FeatureId, FeatureRegister]>) {
      const on = s.features[id] !== false;
      const cur = active.get(id);
      if (on && !cur) {
        try {
          active.set(id, reg(ctx));
        } catch (e) {
          console.error(`[cal-lsp] failed to register ${id}`, e);
        }
      } else if (!on && cur) {
        cur.dispose();
        active.delete(id);
      }
    }
  };
  apply(opts.settings);

  return {
    updateSettings(s) {
      if (disposed) return;
      apply(s);
      bridge.setCompileFlags(s.compileFlags);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const d of active.values()) d.dispose();
      active.clear();
      headers.dispose();
      bridge.dispose();
    },
  };
}

/** Theme rules for clangd semantic token types. Colors are hex without '#'. */
export function semanticTokenRules(theme: 'light' | 'dark'): Monaco.editor.ITokenThemeRule[] {
  const c =
    theme === 'dark'
      ? {
          macro: 'BD63C5',
          function: 'DCDCAA',
          method: 'DCDCAA',
          variable: '9CDCFE',
          parameter: '9CDCFE',
          property: '9CDCFE',
          type: '4EC9B0',
          enumMember: '4FC1FF',
          namespace: '4EC9B0',
          label: 'C8C8C8',
          constant: '4FC1FF',
          globalVar: 'B5CEA8',
        }
      : {
          macro: '8A1BB0',
          function: '795E26',
          method: '795E26',
          variable: '001080',
          parameter: '7F4F00',
          property: '0451A5',
          type: '267F99',
          enumMember: '0070C1',
          namespace: '267F99',
          label: '5E5E5E',
          constant: '0070C1',
          globalVar: '1F5F8B',
        };
  return [
    { token: 'macro', foreground: c.macro },
    { token: 'function', foreground: c.function },
    { token: 'method', foreground: c.method },
    { token: 'variable', foreground: c.variable },
    { token: 'variable.readonly', foreground: c.constant },
    { token: 'variable.declaration.readonly', foreground: c.constant },
    { token: 'variable.globalScope', foreground: c.globalVar },
    { token: 'parameter', foreground: c.parameter, fontStyle: 'italic' },
    { token: 'property', foreground: c.property },
    { token: 'type', foreground: c.type },
    { token: 'class', foreground: c.type },
    { token: 'struct', foreground: c.type },
    { token: 'enum', foreground: c.type },
    { token: 'interface', foreground: c.type },
    { token: 'typeParameter', foreground: c.type },
    { token: 'concept', foreground: c.type },
    { token: 'enumMember', foreground: c.enumMember },
    { token: 'namespace', foreground: c.namespace },
    { token: 'label', foreground: c.label },
    // No 'comment'/'operator' rules: those names are shared with the Monarch tokenizer, so
    // clangd's inactive-code ('comment') regions simply take the theme's comment color.
  ];
}
