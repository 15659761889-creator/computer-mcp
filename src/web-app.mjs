import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The phone web app (iPhone, or any browser) under /app/. Static files only: it talks to
// /hub/api/* with the admin key the person scanned, kept on the phone.

const ROOT = fileURLToPath(new URL('../web/app/', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};
// No inline script, no third-party anything: the page holds the key to every computer.
const CSP = "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; "
  + "worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

export function isWebAppPath(pathname) {
  return pathname === '/app' || pathname.startsWith('/app/');
}

export function serveWebApp(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }
  if (pathname === '/app') {
    res.writeHead(308, { Location: '/app/' });
    res.end();
    return;
  }
  const name = pathname === '/app/' ? 'index.html' : pathname.slice('/app/'.length);
  if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9]+)+$/.test(name)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  const file = path.join(ROOT, name);
  let body;
  try {
    body = fs.readFileSync(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  const headers = {
    'Content-Type': TYPES[path.extname(name)] || 'application/octet-stream',
    'Content-Length': body.length,
    // Small files; always fresh, so an update reaches the phone on the next open.
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  if (name.endsWith('.html')) Object.assign(headers, { 'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY' });
  if (name === 'sw.js') headers['Service-Worker-Allowed'] = '/app/';
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}
