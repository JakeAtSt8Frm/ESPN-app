/**
 * Serves the built app with a working Refresh button.
 *
 * `npm run dev` already has one, because the Vite dev server mounts the same
 * route. This is for the multi-file production build in `dist/`, whose Refresh
 * button otherwise has no server route to ask.
 *
 * Running it through here instead gives the same page a local origin and the
 * `/api/refresh` route behind it, so Refresh pulls a genuinely new snapshot
 * from ESPN using the credentials in `.env` and reloads onto it.
 *
 *   npm run serve
 *
 * Bound to loopback, and that is not incidental. The refresh route is
 * unauthenticated by design — it runs a fixed command with no caller-supplied
 * input — which is fine for something only this machine can reach and is not
 * fine on any other interface.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleRefresh } from './refresh-endpoint';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

/*
 * A refresh rewrites `public/data`, while this server reads the copied files in
 * `dist/data`. Rebuilding after the pull copies the new snapshot into the
 * served directory before the page reloads.
 */
process.env.ESPN_REFRESH_REBUILD = '1';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 5175);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Resolves a request path inside `dist`, or returns null.
 *
 * The null case is the whole point: `normalize` collapses `..` segments, and
 * the containment check afterwards rejects anything that still escaped. A
 * static server that skips this happily serves `.env`.
 */
function safePath(urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const candidate = resolve(DIST, `.${normalize(decoded)}`);
  return candidate === DIST || candidate.startsWith(DIST + sep) ? candidate : null;
}

const server = createServer((req, res) => {
  void (async () => {
    if (await handleRefresh(req, res)) return;

    const requested = safePath(req.url ?? '/');
    if (!requested) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    let file = requested;
    try {
      const info = await stat(file);
      if (info.isDirectory()) file = join(file, 'index.html');
      await stat(file);
    } catch {
      // The app routes on the hash, so every unknown path is the entry page.
      file = join(DIST, 'index.html');
      try {
        await stat(file);
      } catch {
        res.writeHead(404).end('Run npm run build first — dist/index.html is missing');
        return;
      }
    }

    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      // This is a development convenience server; always expose the files it
      // just rebuilt instead of retaining an older HTTP-cache entry.
      'Cache-Control': 'no-store',
    });
    createReadStream(file).pipe(res);
  })().catch((error: unknown) => {
    res.writeHead(500).end(error instanceof Error ? error.message : String(error));
  });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`serving dist/ at http://${HOST}:${PORT}/ — Refresh pulls a new snapshot\n`);
});
