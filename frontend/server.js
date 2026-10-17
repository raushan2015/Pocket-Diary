import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.FRONTEND_PORT || process.env.PORT || 5000);
const BACKEND_URL = process.env.BACKEND_URL || 'http://127.0.0.1:3000';
const PROXY_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS || 30000);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

// Security headers applied to every response (audit L-1).
// CSP note: the app ships no inline <script> and no inline event-handler
// attributes in generated HTML, so scripts are locked to same-origin. Styles
// stay permissive because components use inline style="" attributes.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(self), geolocation=(), payment=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "connect-src 'self'",
    "font-src 'self' data:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; '),
};

// Files inside frontend/ that must never be served to clients (audit L-2).
const DENIED_FILES = new Set([
  'server.js', 'Dockerfile', 'package.json', 'package-lock.json',
  '.env', '.env.example', '.gitignore',
]);

function isDeniedPath(filePath) {
  const rel = path.relative(__dirname, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return true;
  const base = path.basename(rel);
  if (DENIED_FILES.has(base) || base.startsWith('.env')) return true;
  return false;
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(parsedUrl.pathname);

  // Reverse proxy /api/* and /health requests to backend
  if (pathname.startsWith('/api/') || pathname === '/health') {
    const targetUrl = new URL(req.url, BACKEND_URL);
    // Security (audit H-1): this proxy OVERWRITES the forwarded headers with
    // values it observed itself. The previous code forwarded client-supplied
    // X-Forwarded-For/Proto/Host verbatim, so any client could spoof its IP
    // and walk past the backend's rate limiter (or poison cookie security
    // flags via the protocol header).
    const headers = {
      ...req.headers,
      'x-forwarded-for': req.socket.remoteAddress || '',
      'x-forwarded-proto': req.socket.encrypted ? 'https' : 'http',
      'x-forwarded-host': req.headers.host || 'localhost',
      host: `${targetUrl.hostname}:${targetUrl.port || 3000}`,
    };
    delete headers['x-forwarded-port'];
    delete headers['forwarded'];

    const options = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || 3000,
      path: targetUrl.pathname + targetUrl.search,
      method: req.method,
      headers,
      timeout: PROXY_TIMEOUT_MS,
    };

    const proxyReq = http.request(options, (proxyRes) => {
      const outHeaders = { ...SECURITY_HEADERS, ...proxyRes.headers };
      res.writeHead(proxyRes.statusCode, outHeaders);
      proxyRes.pipe(res);
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy(new Error('proxy timeout'));
    });

    proxyReq.on('error', (err) => {
      console.error('Proxy error:', err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad Gateway', message: 'Unable to reach backend service at ' + BACKEND_URL }));
      } else {
        res.end();
      }
    });

    req.pipe(proxyReq);
    return;
  }

  // Static file serving
  let normalizedPath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  let filePath = path.join(__dirname, normalizedPath === '/' || normalizedPath === '\\' ? 'index.html' : normalizedPath);

  // Prevent directory traversal attacks
  if (!filePath.startsWith(__dirname) || isDeniedPath(filePath)) {
    res.writeHead(403, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // SPA Fallback: serve index.html for extensionless or non-file routes
      filePath = path.join(__dirname, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(404, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
        res.end('Not Found');
        return;
      }

      const isHtml = ext === '.html' || !ext;
      const headers = {
        ...SECURITY_HEADERS,
        'Content-Type': contentType,
        // Cacheable asset fingerprinting: HTML revalidates every time; static
        // assets may be reused briefly. ETag lets the browser revalidate.
        'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=300',
        ETag: `"${stats.size.toString(16)}-${stats.mtimeMs.toString(16)}"`,
        Vary: 'Accept-Encoding',
      };

      if (req.headers['if-none-match'] === headers.ETag) {
        res.writeHead(304, headers);
        res.end();
        return;
      }

      // Compress text responses above 1 KB when the client accepts gzip.
      const compressible = /^text\/|application\/(javascript|json)/.test(contentType);
      if (compressible && content.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
        const gzipped = gzipSync(content);
        headers['Content-Encoding'] = 'gzip';
        headers['Content-Length'] = String(gzipped.length);
        res.writeHead(200, headers);
        res.end(gzipped);
      } else {
        headers['Content-Length'] = String(content.length);
        res.writeHead(200, headers);
        res.end(content);
      }
    });
  });
});

server.headersTimeout = PROXY_TIMEOUT_MS + 5000;
server.requestTimeout = PROXY_TIMEOUT_MS + 5000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Memo Manager Frontend listening on http://0.0.0.0:${PORT} (proxying /api to ${BACKEND_URL})`);
});
