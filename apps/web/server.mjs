#!/usr/bin/env node
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorizeRequest } from './access-policy.mjs';

const root = resolve(fileURLToPath(new URL('./dist/', import.meta.url)));
const api = new URL(process.env.HEARTH_CONTROL_URL ?? 'http://127.0.0.1:8787');
const host = process.env.HEARTH_WEB_HOST ?? '127.0.0.1';
const port = Number(process.env.HEARTH_WEB_PORT ?? 5174);
const allowedUsers = new Set((process.env.HEARTH_TAILSCALE_ALLOWED_USERS ?? '')
  .split(',').map((value) => value.trim().toLocaleLowerCase()).filter(Boolean));

if (api.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(api.hostname)) {
  throw new Error('HEARTH_CONTROL_URL must be an HTTP loopback URL');
}
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  throw new Error('HEARTH_WEB_HOST must be loopback-only');
}
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid HEARTH_WEB_PORT');

const mime = new Map([
  ['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'], ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json'], ['.png', 'image/png'], ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'], ['.webmanifest', 'application/manifest+json'],
  ['.woff2', 'font/woff2'],
]);

function authorized(req) {
  return authorizeRequest({
    remoteAddress: req.socket.remoteAddress,
    host: req.headers.host,
    tailscaleLogin: req.headers['tailscale-user-login'],
  }, allowedUsers);
}

function proxy(req, res) {
  const headers = { ...req.headers, host: api.host };
  delete headers.connection;
  delete headers['content-length'];
  const upstream = http.request({
    protocol: api.protocol,
    hostname: api.hostname,
    port: api.port || 80,
    method: req.method,
    path: req.url,
    headers,
  }, (response) => {
    res.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'control_unavailable', message: 'Hearth control service is unavailable' } }));
  });
  req.pipe(upstream);
}

async function staticFile(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }
  const url = new URL(req.url ?? '/', 'http://hearth.local');
  const decoded = decodeURIComponent(url.pathname);
  let path = resolve(root, `.${decoded}`);
  if (path !== root && !path.startsWith(root + sep)) {
    res.writeHead(400).end();
    return;
  }
  try {
    if ((await stat(path)).isDirectory()) path = resolve(path, 'index.html');
    const data = await readFile(path);
    res.writeHead(200, {
      'content-type': mime.get(extname(path)) ?? 'application/octet-stream',
      'cache-control': path.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
    });
    if (req.method === 'HEAD') res.end();
    else res.end(data);
  } catch {
    if (extname(decoded)) {
      res.writeHead(404).end();
      return;
    }
    req.url = '/index.html';
    await staticFile(req, res);
  }
}

const server = http.createServer((req, res) => {
  if (!authorized(req)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('This Hearth host is not enabled for your Tailscale identity.');
    return;
  }
  const path = new URL(req.url ?? '/', 'http://hearth.local').pathname;
  if (path.startsWith('/v1/') || path === '/healthz' || path === '/readyz') proxy(req, res);
  else void staticFile(req, res);
});

server.listen(port, host, () => {
  console.log(`[hearth-web] serving built PWA on loopback port ${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
