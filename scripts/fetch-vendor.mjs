// Downloads heavy third-party runtime files into vendor/ (gitignored).
// Files are pinned by SHA-256; an existing file with the right hash is reused.
//
//   node scripts/fetch-vendor.mjs            # fetch missing / mismatched files
//   node scripts/fetch-vendor.mjs --offline  # also fetch the models bundled into the offline builds
//   node scripts/fetch-vendor.mjs --print    # print hashes of what is on disk (for re-pinning)

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { bundledModelPath, modelUrl, OFFLINE_MODELS, SLM_MODELS } from '../src/shared/protocol.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// clangd 21 compiled to wasm32 (Emscripten, pthreads + Asyncify) from
// https://github.com/Guyutongxue/clangd-in-browser — served from its demo site.
const CLANGD_BASE = 'https://clangd.guyutongxue.site/wasm';

export const VENDOR_FILES = [
  {
    path: 'vendor/clangd/clangd.js',
    url: `${CLANGD_BASE}/clangd.js`,
    sha256: process.env.CLANGD_JS_SHA256 ?? 'a7ff1c588eb5374783bbda84d949b92b8027c2381c786072448b96eba90c7027',
  },
  {
    path: 'vendor/clangd/clangd.wasm',
    url: `${CLANGD_BASE}/clangd.wasm`,
    sha256: process.env.CLANGD_WASM_SHA256 ?? '0d71e7a7f8e6dd369cb2a0b22cc4016d649f370e5b905adb6092536deb0ee019',
    validateWasm: true,
  },
];

/** Model weights, pinned in SLM_MODELS (src/shared/protocol.ts). */
export const modelFile = (id) => ({
  path: `vendor/${bundledModelPath(id)}`,
  url: modelUrl(id),
  sha256: SLM_MODELS[id].sha256,
});

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const MAX_ATTEMPTS = 8;
const partSize = (path) => (existsSync(path) ? statSync(path).size : 0);

/** Downloads `url` into `tmp`, appending to an existing partial file when the server honours Range. Returns the expected total size (0 if unknown). */
async function download(url, tmp) {
  const have = partSize(tmp);
  const res = await fetch(url, have ? { headers: { range: `bytes=${have}-` } } : {});
  if (res.status === 416) return have; // the .part is already complete
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const resumed = res.status === 206;
  // content-length is the encoded size when the response is compressed; only compare for identity encoding.
  const encoded = (res.headers.get('content-encoding') ?? 'identity') !== 'identity';
  const length = encoded ? 0 : Number(res.headers.get('content-length')) || 0;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp, { flags: resumed ? 'a' : 'w' }));
  return length && (resumed ? have + length : length);
}

async function fetchOne(file) {
  const abs = join(root, file.path);
  if (existsSync(abs) && sha256(readFileSync(abs)) === file.sha256) {
    console.log(`✓ ${file.path} (cached)`);
    return;
  }
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.part`;
  console.log(`↓ ${file.url}`);
  // Long downloads (the 1.5B model is ~1 GB) can be cut off mid-stream; resume the .part file with a Range request.
  let expected = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      expected = await download(file.url, tmp);
      break;
    } catch (e) {
      if (attempt >= MAX_ATTEMPTS) throw e;
      console.warn(`  ${e.code ?? e.message}; resuming from ${(partSize(tmp) / 1e6).toFixed(1)} MB (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
    }
  }

  const buf = readFileSync(tmp);
  if (expected && buf.length !== expected) throw new Error(`${file.path}: truncated (${buf.length}/${expected} bytes)`);
  if (file.validateWasm && !WebAssembly.validate(buf)) throw new Error(`${file.path}: not a valid wasm module`);
  const got = sha256(buf);
  if (file.sha256 !== 'PIN_ME' && got !== file.sha256) {
    rmSync(tmp);
    throw new Error(`${file.path}: sha256 mismatch\n  expected ${file.sha256}\n  got      ${got}\nUpstream changed; verify it and re-pin.`);
  }
  renameSync(tmp, abs);
  console.log(`✓ ${file.path} ${(buf.length / 1e6).toFixed(1)} MB sha256=${got}`);
}

export async function fetchVendor({ models = [] } = {}) {
  for (const f of [...VENDOR_FILES, ...models.map(modelFile)]) await fetchOne(f);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--print')) {
    for (const f of [...VENDOR_FILES, ...OFFLINE_MODELS.map(modelFile)]) {
      const abs = join(root, f.path);
      console.log(f.path, existsSync(abs) ? sha256(readFileSync(abs)) : '(missing)');
    }
  } else {
    await fetchVendor({ models: process.argv.includes('--offline') ? OFFLINE_MODELS : [] });
  }
}
