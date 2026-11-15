// Pre-compress the built client (gzip + brotli) so the server can send compressed files directly.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const root = process.argv[2] ?? 'packages/client/dist';
const exts = /\.(js|css|html|json|svg|wasm)$/;
let saved = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (exts.test(name)) {
      const raw = readFileSync(path);
      const br = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
      writeFileSync(path + '.gz', gzipSync(raw, { level: 9 }));
      writeFileSync(path + '.br', br);
      saved += raw.length - br.length;
    }
  }
}
walk(root);
console.log(`compressed ${root} (brotli saves ${(saved / 1e6).toFixed(1)} MB)`);
