import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

/**
 * Serves the built client (packages/client/dist). Uses pre-compressed .br/.gz siblings when
 * the browser accepts them (the bundle is ~5 MB raw, ~1.8 MB gzipped). Hashed assets are
 * cached forever; index.html is always revalidated so deploys take effect immediately.
 */
export function staticHandler(root: string) {
  const base = resolve(root);
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const url = new URL(req.url ?? '/', 'http://x');
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(base, path));
    if (!file.startsWith(base)) return false; // no escaping the dist folder
    if (!existsSync(file) || !statSync(file).isFile()) return false;

    const accept = String(req.headers['accept-encoding'] ?? '');
    let serve = file;
    let encoding: string | null = null;
    if (accept.includes('br') && existsSync(file + '.br')) {
      serve = file + '.br';
      encoding = 'br';
    } else if (accept.includes('gzip') && existsSync(file + '.gz')) {
      serve = file + '.gz';
      encoding = 'gzip';
    }
    const headers: Record<string, string | number> = {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'content-length': statSync(serve).size,
      'cache-control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      vary: 'accept-encoding',
    };
    if (encoding) headers['content-encoding'] = encoding;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') res.end();
    else createReadStream(serve).pipe(res);
    return true;
  };
}
