// English UI strings, the default locale. Every other locale must provide the same keys.
// Keep this file free of runtime imports: scripts/build.mjs loads it directly to write _locales/.

export const en = {
  // Manifest (written to _locales/en/messages.json)
  extName: 'CYCU CAL Code Editor',
  extDescription:
    'Replaces the CYCU CAL editor with Monaco + clangd (WASM) language features and optional local completion.',

  // Page toolbar
  'toolbar.label': 'CYCU CAL extension',
  'toolbar.settings': 'Extension settings',
  'toolbar.format': 'Format',
  'toolbar.formatTitle': 'Format code with clang-format (Shift+Alt+F)',
  'toolbar.monaco': 'Monaco',
  'toolbar.ace': 'Ace',
  'toolbar.monacoTitle': 'Using Monaco editor — click to switch back to the site editor (Ace)',
  'toolbar.aceTitle': 'Using the site editor (Ace) — click to switch to Monaco',
  'clangd.starting': 'clangd: starting…',
  'clangd.loading': 'clangd: loading…',
  'clangd.ready': 'clangd: ready',
  'clangd.error': 'clangd: error',
  'clangd.stopped': 'clangd: stopped',
  'clangd.other': (status: string) => `clangd: ${status}`,
  'slm.idle': 'AI: idle',
  'slm.downloading': 'AI: downloading',
  'slm.loading': 'AI: loading…',
  'slm.ready': 'AI: ready',
  'slm.error': 'AI: error',

  // Question "Copy" button
  'question.copy': 'Copy',
  'question.copied': 'Copied',
  'question.copyFailed': 'Copy failed',
  'question.copyTitle': 'Copy the question as Markdown',

  // clangd status details (offscreen document and worker)
  'clangd.detail.loadingPct': (pct: number) => `loading clangd ${pct}%`,
  'clangd.detail.loadingMB': (mb: number) => `loading clangd ${mb} MB`,
  'clangd.detail.compiling': 'compiling clangd',
  'clangd.detail.loading': 'loading clangd',
  'clangd.detail.starting': 'starting clangd',
  'clangd.detail.started': (seconds: string) => `started in ${seconds} s`,
  'clangd.detail.workerError': (message: string) => `clangd worker error: ${message}`,
  'clangd.detail.failedToLoad': 'failed to load',
  'clangd.detail.stopped': 'clangd stopped',
  'clangd.detail.idle': 'idle',
  'clangd.detail.reconnecting': 'reconnecting…',
  'clangd.detail.extensionReloaded': 'extension was reloaded; refresh the page',
  'clangd.detail.initFailed': (error: string) => `initialize failed: ${error}`,
  'clangd.detail.exited': (code: number) => `clangd exited with code ${code}`,

  // Local AI completion
  'slm.displayName': 'Local SLM',
  'slm.detail.unknownModel': (id: string) => `unknown model ${id}`,
  'slm.detail.bundledMissing': (status: number) => `bundled model missing (HTTP ${status})`,
  'slm.detail.ready': (label: string, threads: number) => `${label}, ${threads} threads`,

  // Rename, workspace edits and links
  'edit.fileOps': 'This change would create, rename or delete files.',
  'edit.otherFile': (path: string) => `This change would modify another file (${path}).`,
  'edit.locked': (from: number, to: number) =>
    `This change would modify locked line${from === to ? ` ${from}` : `s ${from}-${to}`}.`,
  'rename.unavailable': "This symbol can't be renamed.",
  'rename.locked': 'This symbol is on a locked line and cannot be renamed.',
  'rename.failed': 'Rename failed.',
  'rename.rejected': (reason: string) => `Rename rejected: ${reason}`,
  'link.peek': (path: string) => `Peek ${path} (read-only)`,

  // Feature names (options page)
  'feature.diagnostics': 'Diagnostics & quick fixes',
  'feature.completion': 'Code completion',
  'feature.hover': 'Hover information',
  'feature.signatureHelp': 'Signature help',
  'feature.formatting': 'Formatting (clang-format)',
  'feature.definition': 'Go to definition / references',
  'feature.highlightRename': 'Symbol highlight & rename',
  'feature.outline': 'Document outline',
  'feature.folding': 'Folding ranges',
  'feature.inlayHints': 'Inlay hints',
  'feature.semanticTokens': 'Semantic highlighting',
  'feature.documentLinks': '#include links',
  'feature.inlineCompletion': 'Local AI ghost-text completion',
  'featureHint.diagnostics': 'Errors and warnings as you type',
  'featureHint.completion': 'Suggestions for names and members',
  'featureHint.hover': 'Types and docs under the cursor',
  'featureHint.signatureHelp': 'Parameter hints inside calls',
  'featureHint.formatting': 'Format the document or a selection',
  'featureHint.definition': 'Jump to declarations and usages',
  'featureHint.highlightRename': 'Highlight and rename symbols',
  'featureHint.outline': 'Quick outline (Ctrl/Cmd-Shift-O)',
  'featureHint.folding': 'Collapse blocks and comments',
  'featureHint.inlayHints': 'Inline parameter names and types',
  'featureHint.semanticTokens': 'Color by meaning, not just syntax',
  'featureHint.documentLinks': 'Ctrl/Cmd-click to peek at a header',
  'featureHint.inlineCompletion': 'Gray ghost-text suggestions; press Tab to accept',

  // Options page
  'options.title': 'CYCU CAL Code Editor – Options',
  'options.tagline': 'Monaco, clangd and local AI completion for the CAL judge.',
  'options.editor': 'Editor',
  'options.useMonaco': 'Monaco editor',
  'options.useMonacoDesc': "Replace the site's editor with Monaco. You can also switch from the toolbar on the page.",
  'options.language': 'Language',
  'options.languageDesc': 'Language of the extension. Reload open CAL pages to apply it there.',
  'options.languageAuto': 'Browser default',
  'options.theme': 'Theme',
  'options.themeDesc': 'Color theme for the editor.',
  'options.themeLight': 'Light',
  'options.themeDark': 'Dark',
  'options.minimap': 'Minimap',
  'options.minimapDesc': 'Show a code overview along the right edge.',
  'options.fontFamily': 'Font family',
  // {example} is replaced with a <code> sample.
  'options.fontFamilyDesc': "A CSS font list, e.g. {example}. Leave empty to use the site's font.",
  'options.fontFamilyPlaceholder': 'Site default',
  'options.toolbar': 'Page buttons',
  'options.clangdBadge': 'clangd status badge',
  'options.clangdBadgeDesc': 'Show whether clangd is starting, ready or failed.',
  'options.slmBadge': 'AI status badge',
  'options.slmBadgeDesc': "Show the local AI model's status while AI completion is on.",
  'options.formatButton': 'Format button',
  'options.formatButtonDesc':
    'Format the code with clang-format in one click while formatting is on (Shift+Alt+F also works).',
  'options.copyButton': 'Copy button',
  'options.copyButtonDesc': 'Show a button at the top right of the question that copies it as Markdown.',
  'options.features': 'Language features',
  'options.featuresHint':
    'Powered by clangd, which runs inside your browser. Changes apply to open editors right away.',
  'options.slm': 'Local AI completion',
  'options.slmContext': 'Context size',
  'options.slmContextDesc':
    'How much of your code the model reads, in tokens. Larger sizes use more memory and respond slower.',
  'options.slmModel': 'Model',
  'options.slmModelDesc': 'Larger models suggest better code but take longer to load and respond.',
  'options.slmNote':
    'Runs on your CPU. Only the code in the editor is used as context, and nothing is sent to a server. Models not included with the extension are downloaded once from Hugging Face and cached in this browser.',
  'options.slmIncluded': (size: string) => `Included · ${size}`,
  'options.slmDownload': (size: string) => `${size} download`,
  'options.slmConfirm': (label: string, size: string, repo: string) =>
    `Local AI completion downloads ${label} (about ${size}) from Hugging Face (${repo}).\n\n` +
    'It is cached in this browser and runs on your CPU. Continue?',
  'options.compileFlags': 'Compiler flags',
  'options.clangdFlags': 'clangd flags',
  'options.clangdFlagsDesc': "Written to clangd's compile flags, one per line.",
  'options.resetFlags': 'Restore defaults',
  'options.saved': 'Saved',
  'options.saveFailed': (error: string) => `Save failed: ${error}`,
  'options.loadFailed': (error: string) => `Could not load settings: ${error}`,
};

export type Messages = typeof en;
