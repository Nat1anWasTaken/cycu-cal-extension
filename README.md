# CYCU CAL Code Editor

A Chrome/Brave extension that replaces the code editor on [CYCU CAL](https://cycu-cal.tw) with
[Monaco](https://microsoft.github.io/monaco-editor/) and full C language support, running entirely in your browser.
It also works on CAL servers hosted on other domains or the LAN (any page under `/cal/topic/`).

## Features

- **C language support** from [clangd compiled to WebAssembly](https://github.com/Guyutongxue/clangd-in-browser):
  diagnostics, quick fixes, completion, hover, go to definition, rename, clang-format and more.
- **Optional AI completion** from a local [Qwen2.5-Coder](https://huggingface.co/Qwen) model run with
  [wllama](https://github.com/ngxson/wllama). Off by default; the model only sees the code in the editor.
- **Works with the site, not around it.** RUN, reset, drafts and locked lines behave as before, and you can switch
  back to the original editor from the toolbar.

## Installation

1. Download a zip from the [latest release](https://github.com/Nat1anWasTaken/cycu-cal-extension/releases/latest)
   and unzip it:
   - `cycu-cal-extension-<version>.zip` (~27 MB) downloads the AI model the first time you turn it on.
   - `cycu-cal-extension-<version>-offline-0.5b.zip` (~400 MB) includes the Qwen2.5-Coder 0.5B model.
   - `cycu-cal-extension-<version>-offline-1.5b.zip` (~1 GB) includes the larger, more accurate 1.5B model.
2. Open `chrome://extensions` (or `brave://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and select the unzipped folder.

## Development

Requires Node 24+ and pnpm.

```sh
pnpm install
pnpm dev                   # build to dist/ and rebuild on change
pnpm build                 # build to dist/
pnpm package               # zip to release/
pnpm package:offline-0.5b  # zip to release/, bundling the 0.5B model
pnpm package:offline-1.5b  # zip to release/, bundling the 1.5B model
pnpm test
```

Load `dist/` as an unpacked extension to try your changes. The clangd runtime is downloaded into `vendor/` on the
first build.

## License

[MIT](LICENSE). Bundled third-party components (clangd, Monaco, wllama, model weights) keep their own licenses.
