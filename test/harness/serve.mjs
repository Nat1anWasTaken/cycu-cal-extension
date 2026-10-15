// Local mock of a cycu-cal topic page for testing the extension without touching the real site.
//
//   node test/harness/serve.mjs          # http://localhost:5179/cal/topic/1001  (?passed=1 → read-only)
//
// startHarness(HTTPS_PORT, { key, cert }) serves the same over TLS (https://127.0.0.1:5443) to check
// behaviour on a secure origin like the real site; the e2e test generates a throwaway cert.
//
// Routes: /cal/topic/<id> → topic.html, /static/vendor/ace/* → ace-builds, /cal/get_precode/<id> → PRECODE.

import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const aceDir = join(root, 'node_modules/ace-builds/src-min-noconflict');
export const PORT = 5179;
export const HTTPS_PORT = 5443;
export const PRECODE = '#include <stdio.h>\n#include <stdlib.h>\n// 以上三行不可修改 (locked)\nint main(void) {\n\t\n\treturn 0;\n}\n';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };

export function startHarness(port = PORT, tls = null) {
  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${port}`);
      const p = url.pathname;
      if (p === '/' || p.startsWith('/cal/topic/')) {
        res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store' });
        res.end(await readFile(join(here, 'topic.html')));
      } else if (p.startsWith('/cal/get_precode/')) {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(PRECODE);
      } else if (p.startsWith('/static/vendor/ace/')) {
        const file = normalize(join(aceDir, p.slice('/static/vendor/ace/'.length)));
        if (!file.startsWith(aceDir)) throw Object.assign(new Error('forbidden'), { code: 'ENOENT' });
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
        res.end(await readFile(file));
      } else {
        res.writeHead(404).end('not found');
      }
    } catch (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500).end(String(err));
    }
  };
  const server = tls ? createHttpsServer(tls, handler) : createServer(handler);
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok(server));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startHarness();
  console.log(`harness on http://localhost:${PORT}/cal/topic/1001  (add ?passed=1 for read-only)`);
}
