# CYCU CAL Code Editor

A Chrome/Brave extension that replaces the editor on [CYCU CAL](https://cycu-cal.tw) topic pages with
[Monaco](https://microsoft.github.io/monaco-editor/), with C language features from
[clangd compiled to WebAssembly](https://github.com/Guyutongxue/clangd-in-browser) running locally in the browser:

- diagnostics and quick fixes
- completion, hover and signature help
- clang-format
- go to definition, references, rename
- outline, folding
- inlay hints, semantic highlighting, `#include` links

An optional local small language model (Qwen2.5-Coder, run on the CPU with
[wllama](https://github.com/ngxson/wllama)) adds ghost-text completions. It is off by default. The model only
sees the code in the editor, never the problem statement.

The site's own logic is left alone. RUN, reset, drafts, locked lines and run limits behave as before: the
original Ace editor stays on the page, hidden, and is kept in sync. You can switch back to it from the toolbar.

## Install (no build)

1. Download the latest release from [Releases](../../releases) (or the matching artifact of a CI run) and unzip it:
   - `cycu-cal-extension-<version>.zip` (~27 MB): AI completion downloads its model from Hugging Face the
     first time you turn it on.
   - `cycu-cal-extension-<version>-offline.zip` (~400 MB): Qwen2.5-Coder 0.5B is included, so nothing is
     downloaded. The 1.5B model can still be downloaded from the options page.
2. Open `chrome://extensions` (or `brave://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and select the unzipped folder (the one containing `manifest.json`).

## Build from source

Requires Node 24+ and pnpm.

```sh
pnpm install
pnpm build        # → dist/  (load this folder unpacked)
pnpm package      # → release/cycu-cal-extension-<version>.zip
pnpm package:offline  # → release/cycu-cal-extension-<version>-offline.zip (bundles the 0.5B model)
pnpm dev          # rebuild on change
```

The clangd runtime (~127 MB) is not committed. `scripts/fetch-vendor.mjs` downloads it into `vendor/` on the
first build and verifies its pinned SHA-256. CI caches it. The offline build also fetches the model weights into
`vendor/models/`, pinned (revision + SHA-256) in `SLM_MODELS` in `src/shared/protocol.ts`.

## Layout

| Path | What |
|---|---|
| `src/content/` | Content scripts. `main-world.ts` talks to the page's Ace instance; `index.ts` mounts Monaco. |
| `src/editor/` | Monaco setup, locked-line enforcement, toolbar. |
| `src/lsp/` | JSON-RPC client and Monaco providers for each LSP feature. |
| `src/offscreen/` | Offscreen document hosting the clangd worker (needs cross-origin isolation for pthreads). |
| `src/slm/` | Local model host (offscreen) and inline-completion provider (content). |
| `src/options/` | Options page: per-feature toggles, compile flags, theme, model. |
| `src/shared/` | Message contracts and settings shared by all contexts. |
| `scripts/` | Vite build orchestration, vendor fetching, e2e scripts. |
| `test/harness/` | A hand-written mock of a topic page for local testing. |
