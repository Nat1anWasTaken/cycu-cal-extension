// Builds the extension into dist/ with Vite, and optionally zips it for "Load unpacked".
//
//   pnpm build            # fetch vendor files (if needed) + build dist/
//   pnpm build --watch    # rebuild on change (vendor fetched once)
//   pnpm package          # build + zip to release/cycu-cal-extension-<version>.zip
//
// Content scripts cannot be ES modules, so they are built separately as self-contained
// IIFE bundles. Extension pages (background, offscreen, options) and their workers are
// a regular multi-page ES build.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { fetchVendor } from './fetch-vendor.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// OUT_DIR lets parallel builds (e.g. several agents or e2e runs) avoid clobbering each other.
const dist = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : join(root, 'dist');
const watch = process.argv.includes('--watch');
const zip = process.argv.includes('--zip');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const common = {
  root,
  configFile: false,
  logLevel: 'warn',
  publicDir: false,
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
};

/** Extension pages + background + their (module) workers. */
const pagesBuild = {
  ...common,
  base: '/',
  worker: { format: 'es' },
  build: {
    outDir: dist,
    emptyOutDir: false,
    target: 'chrome116',
    minify: !watch,
    sourcemap: watch ? 'inline' : false,
    watch: watch ? {} : null,
    modulePreload: false,
    rollupOptions: {
      input: existingEntries({
        background: 'src/background.ts',
        offscreen: 'src/offscreen/offscreen.html',
        options: 'src/options/options.html',
      }),
      output: {
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
};

/** Absolute paths of the entries that exist; missing ones (slices not written yet) are skipped. */
function existingEntries(entries) {
  const out = {};
  for (const [name, rel] of Object.entries(entries)) {
    if (existsSync(join(root, rel))) out[name] = join(root, rel);
    else console.warn(`⚠ skipping missing entry ${rel}`);
  }
  return out;
}

/** Self-contained classic scripts: content scripts and the Monaco editor worker. */
const iifeBuild = (name, entry, extra = {}) => ({
  ...common,
  build: {
    outDir: dist,
    emptyOutDir: false,
    target: 'chrome116',
    minify: !watch,
    sourcemap: watch ? 'inline' : false,
    watch: watch ? {} : null,
    // Fonts (Monaco codicons) must be inlined: a content script's CSS resolves relative URLs against the page.
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    lib: {
      entry: join(root, entry),
      formats: ['iife'],
      name: name.replace(/\W/g, '_'),
      fileName: () => `${name}.js`,
      cssFileName: name,
    },
    ...extra,
  },
});

function copyStatic() {
  mkdirSync(dist, { recursive: true });
  cpSync(join(root, 'vendor/clangd/clangd.js'), join(dist, 'clangd/clangd.js'));
  cpSync(join(root, 'vendor/clangd/clangd.wasm'), join(dist, 'clangd/clangd.wasm'));
  const wllamaWasm = join(root, 'node_modules/@wllama/wllama/esm/wasm/wllama.wasm');
  if (existsSync(wllamaWasm)) cpSync(wllamaWasm, join(dist, 'wllama/wllama.wasm'));
  if (existsSync(join(root, 'icons'))) cpSync(join(root, 'icons'), join(dist, 'icons'), { recursive: true });
}

/** Writes dist/manifest.json, dropping references to files that were not built (missing slices). */
function writeManifest() {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  const keep = (f) => {
    if (existsSync(join(dist, f))) return true;
    console.warn(`⚠ manifest: dropping missing ${f}`);
    return false;
  };
  manifest.content_scripts = (manifest.content_scripts ?? [])
    .map((cs) => ({ ...cs, js: cs.js?.filter(keep), css: cs.css?.filter(keep) }))
    .filter((cs) => cs.js?.length || cs.css?.length);
  if (!manifest.content_scripts.length) delete manifest.content_scripts;
  if (manifest.options_page && !keep(manifest.options_page)) delete manifest.options_page;
  // --- page slice: HARNESS=1 also injects into the local test harness (test/harness/serve.mjs) ---
  if (process.env.HARNESS === '1') {
    const h = ['http://localhost:5179/*', 'https://127.0.0.1:5443/*'];
    for (const cs of manifest.content_scripts ?? []) cs.matches = [...cs.matches, ...h];
    for (const war of manifest.web_accessible_resources ?? []) war.matches = [...war.matches, ...h];
  }
  // --- end page slice ---
  writeFileSync(join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

function packageZip() {
  const out = join(root, 'release');
  mkdirSync(out, { recursive: true });
  const file = join(out, `cycu-cal-extension-${pkg.version}.zip`);
  rmSync(file, { force: true });
  execFileSync('zip', ['-qr', '-9', file, '.'], { cwd: dist, stdio: 'inherit' });
  console.log(`packaged ${file}`);
}

await fetchVendor();
if (!watch) rmSync(dist, { recursive: true, force: true });
copyStatic();

const iifeEntries = [
  ['main-world', 'src/content/main-world.ts'],
  ['content', 'src/content/index.ts'],
  ['editor.worker', 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js'],
];
const builds = [pagesBuild];
for (const [name, entry] of iifeEntries) {
  if (existsSync(join(root, entry))) builds.push(iifeBuild(name, entry));
  else console.warn(`⚠ skipping missing IIFE entry ${entry} (${name}.js)`);
}
if (watch) {
  await Promise.all(builds.map((c) => build(c)));
  writeManifest();
  console.log('watching for changes…');
} else {
  for (const c of builds) await build(c);
  writeManifest();
  console.log(`built ${dist}`);
  if (zip) packageZip();
}
