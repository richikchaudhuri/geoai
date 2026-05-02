/**
 * GeoAI — local dev server.
 *
 * Mirrors what Netlify does in production so the same site can be
 * exposed through a Cloudflare Tunnel from your laptop:
 *
 *   - Serves static files (index.html, app.js, styles.css, fonts, …)
 *     from the repo root.
 *   - Proxies `/api/assessments` through netlify/functions/assessments.js
 *     so the Upstash-Redis-cached Supabase pipeline works locally too.
 *
 * Pair this with `tunnel.bat` to put the site on a public
 * `*.trycloudflare.com` URL with no port-forwarding, no public IP,
 * and no paid hosting.
 *
 * Usage:
 *   node server.js          # http://localhost:8000
 *   PORT=9000 node server.js
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');

const { handler: assessmentsHandler } =
  require('./netlify/functions/assessments');

const PORT = Number(process.env.PORT) || 8000;
const ROOT = __dirname;

const MIME = {
  '.html':  'text/html; charset=utf-8',
  '.js':    'application/javascript; charset=utf-8',
  '.mjs':   'application/javascript; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.svg':   'image/svg+xml',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.jpeg':  'image/jpeg',
  '.gif':   'image/gif',
  '.webp':  'image/webp',
  '.ttf':   'font/ttf',
  '.otf':   'font/otf',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ico':   'image/x-icon',
  '.json':  'application/json; charset=utf-8',
  '.txt':   'text/plain; charset=utf-8',
  '.md':    'text/markdown; charset=utf-8',
};

async function callNetlifyFunction(req, res) {
  const parsed = url.parse(req.url, true);
  const event = {
    httpMethod: req.method,
    path: parsed.pathname,
    queryStringParameters: parsed.query || {},
    headers: req.headers,
    body: null,
  };
  try {
    const result = await assessmentsHandler(event);
    res.writeHead(result.statusCode || 200, result.headers || {});
    res.end(result.body || '');
  } catch (e) {
    console.error('[server] function error:', e);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Function error: ' + e.message);
  }
}

function serveStatic(req, res) {
  const reqPath = decodeURIComponent(req.url.split('?')[0]);
  let filePath =
    reqPath === '/' || reqPath === ''
      ? path.join(ROOT, 'index.html')
      : path.join(ROOT, reqPath);

  // Block path traversal.
  const normalized = path.normalize(filePath);
  if (!normalized.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.stat(normalized, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found: ' + reqPath);
      return;
    }
    const ext = path.extname(normalized).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(normalized).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  // Tiny access log — handy when watching the cloudflared window.
  console.log(`${new Date().toISOString()}  ${req.method}  ${req.url}`);

  if (req.url.startsWith('/api/assessments')) {
    return callNetlifyFunction(req, res);
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`
  GeoAI dev server
  ────────────────
  Local:    http://localhost:${PORT}
  Static:   ${ROOT}
  Function: /api/assessments  →  netlify/functions/assessments.js
  Stop:     Ctrl+C
`);
});
