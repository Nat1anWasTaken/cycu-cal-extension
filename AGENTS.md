# AGENTS.md

This file provides guidance to coding agents working with code in this repository.

## What this is

A Manifest V3 Chrome/Brave extension that replaces the Ace code editor on CYCU CAL topic pages (`*://*/cal/topic/*`) with Monaco, adding C language support from clangd compiled to WebAssembly and optional local AI ghost-text completion (Qwen2.5-Coder via wllama). Everything runs inside the browser.

## Commands

Requires Node 24+ and pnpm.

```sh
pnpm dev            # build to dist/ and rebuild on change (load dist/ as an unpacked extension)
pnpm build          # build to dist/ (first run downloads clangd into vendor/, ~127 MB)
pnpm package        # build + zip to release/
pnpm package:offline-0.5b / package:offline-1.5b   # zip with model weights bundled
pnpm package:all    # all three zips above
pnpm typecheck      # tsc --noEmit
pnpm format         # prettier --write (format:check runs in CI)
pnpm test           # node --test src/**/__tests__/*.test.ts
node --test src/lsp/__tests__/convert.test.ts       # single test file
```

CI (`.github/workflows/build.yml`) runs `format:check`, `typecheck` and the three package builds. Every push to `main` publishes a GitHub release tagged `<UTC date>-<short sha>`.

`OUT_DIR=<dir>` redirects the build output, so parallel builds or e2e runs don't clobber `dist/`. `HARNESS=1` also injects the content scripts into the local test harness.

### Unit tests

Unit tests run in plain Node with type stripping, with no bundler. Any module a test imports must have no runtime imports of Monaco, `chrome.*` or other browser-only code, and relative imports between such modules use explicit `.ts` extensions (for example `src/shared/i18n.ts`). Pure logic is kept in modules like this on purpose: `lsp/client.ts`, `lsp/features/convert.ts`, `content/markdown.ts`, `slm/fim.ts` and `shared/i18n.ts`.

### E2E tests (macOS, Brave)

The `scripts/e2e-*.mjs` scripts each build into their own `/tmp/cal-dist-*` directory, launch a separate headless Brave with a fresh profile and drive it over CDP. They print PASS/FAIL lines. `SKIP_BUILD=1` reuses an existing build, and `BRAVE=` / `BROWSER=` overrides the browser path.

- `e2e-page.mjs`: Monaco-over-Ace integration against the local harness (`test/harness/serve.mjs` mocks a topic page at `http://localhost:5179/cal/topic/1001`, plus HTTPS on 5443).
- `e2e-lsp.mjs`: LSP providers against real clangd.
- `e2e-runtime.mjs`: background → offscreen → clangd worker.
- `e2e-slm.mjs`: real model inference (`MODEL=`, `OFFLINE=1`).

The e2e scripts never touch the real site or port 9222.

## Architecture

All cross-context message types live in `src/shared/protocol.ts`, so read that file first. The contexts are:

1. **MAIN-world content script** (`src/content/main-world.ts`) talks to the page's own Ace instance. **Ace stays the source of truth**, because the site's RUN button, draft autosave, reset and locked lines all read or write Ace. The page declares top-level `let editor, Range, arr2, arrE`. These are global lexical bindings that are referenced by bare name, so never declare locals with those names in that file.
2. **ISOLATED-world content script** (`src/content/index.ts`) loads settings and sets the UI locale, then dynamically imports `src/content/app.ts`, which mounts Monaco over the hidden Ace and wires up the toolbar, the lock guard, LSP and SLM. It talks to MAIN through `window.postMessage` envelopes tagged `BRIDGE_TAG`. If anything fails (no Ace, a timeout, Monaco fails to mount), it leaves the page untouched.
   - **Monaco → Ace sync** (`content/ace-sync.ts`) is debounced while typing, but it must be _synchronous_ before RUN, because the page reads `editor.getValue()` in the same task as the click. It dispatches a `FLUSH_EVENT` CustomEvent on `document` for this, since DOM events dispatch synchronously across worlds.
   - **Copy question** (`content/copy-question.ts`) adds a "Copy" button to the question (`#ins`, the scrolling child of `#instruction`) that copies the title and statement as Markdown (`content/markdown.ts`). The formulas are MathJax output, so it first dispatches `MATH_TEX_EVENT`, and main-world tags each `mjx-container` with its TeX source.
   - **Locks** (`editor/locks.ts`) copy the site's Ace rule for locked regions exactly. Key events are intercepted, and as a safety net, content changes that touch a lock are reverted.
3. **Background service worker** (`src/background.ts`) creates the offscreen document on request (`ensureOffscreen`) and opens the options page.
4. **Offscreen document** (`src/offscreen/`) is cross-origin isolated (the manifest sets COOP/COEP) so that clangd can use pthreads. Content scripts connect to it directly over `chrome.runtime` Ports (`LSP_PORT`, `SLM_PORT`).
   - `lsp-host.ts` multiplexes every tab onto **one shared clangd worker**. It rewrites request ids, sends only the first `initialize` to clangd, routes diagnostics to the port that owns the URI, serves the custom `cal/readFile` method from the Emscripten FS, and shuts clangd down when idle.
   - `slm/host.ts` runs one wllama instance for all tabs. Models are downloaded from Hugging Face (pinned revision and SHA-256 in `protocol.ts`) and cached in OPFS, or read from the package in offline builds (`__BUNDLED_MODELS__`, see `shared/bundle.ts`).
5. **Options page** (`src/options/`) edits `Settings` (`shared/settings.ts`), which are stored in `chrome.storage.sync`.

**LSP layer (`src/lsp/`).** `monaco-bridge.ts` owns the connection: it reconnects with backoff, keeps document sync full and debounced, and gives each document its own `file:///workspace/<topic>-<random>.c` URI. Each file in `features/` exports `register(ctx: FeatureContext)` and maps to a toggleable `FeatureId` in settings. `lsp/index.ts` wires them together. LSP↔Monaco type conversion lives in `features/convert.ts`.

**SLM product rule.** The FIM prompt (`slm/fim.ts`) is built **only** from the editor text before and after the cursor. Never send the problem statement or any other page content to the model.

**Build (`scripts/build.mjs`).** Content scripts can't be ES modules, so `main-world`, `content` and the Monaco `editor.worker` are built as self-contained IIFE bundles, with assets inlined because content-script CSS resolves URLs against the page. Background, offscreen and options are a normal multi-page Vite ES build. The build also copies the clangd and wllama wasm, writes `dist/manifest.json` with the version taken from `package.json`, and generates `_locales/` from the TypeScript locale tables. Heavy binaries are fetched by `scripts/fetch-vendor.mjs` into the gitignored `vendor/`, pinned by SHA-256.

**i18n.** UI strings live in `src/shared/locales/{en,zh-TW}.ts` and are read through `t()` from `shared/i18n.ts`. `en.ts` defines the `Messages` type, so both files must define every key. Manifest strings (`extName`, `extDescription`) come from the same tables. Monaco's own strings are switched in `editor/nls.ts`, which must be imported before any Monaco module. The locale comes from the `language` setting (`'auto'` follows the browser's UI language), and settings load asynchronously: the content script sets the locale before it imports Monaco, and the options page before it renders. The offscreen document and workers can't read settings, so content scripts send the locale in the LSP `hello` and SLM `load` messages, and the LSP host passes it to the clangd worker in `start`.

## Style

The repo is formatted with Prettier (single quotes, `printWidth` 120). Commits follow Conventional Commits (`feat(i18n): …`, `test(e2e): …`, `build: …`).
