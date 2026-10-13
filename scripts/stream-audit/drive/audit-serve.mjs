#!/usr/bin/env node
// Serve a production client build for desktop test binaries built without
// `custom-protocol` (they load devUrl), with an in-page agent that runs commands
// posted to /__drive/run?role=<role>. Several apps can load the same origin: each
// agent learns its role from its own HOME (the audit gives the sender and the
// viewer HOMEs named after their role) and long-polls only its role's queue.
// Commands become ES modules served from this origin (no eval, so the app's CSP
// holds).
//
//   node audit-serve.mjs <distDir> <port> <cmdDir>
//   curl -s -X POST --data-binary 'return document.title' 'http://127.0.0.1:<port>/__drive/run?role=viewer'
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = process.argv[2];
const port = Number(process.argv[3] ?? 1477);
const cmdDir = process.argv[4];
const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(cmdDir, { recursive: true });

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
};

let seq = 0;
const STAMP = Date.now().toString(36);
const roles = new Map(); // role -> { queue, waiter, lastPoll }
const pending = new Map();
const role = (name) => {
  if (!roles.has(name)) roles.set(name, { queue: [], waiter: null, lastPoll: null });
  return roles.get(name);
};

function dispatch(r) {
  if (r.waiter && r.queue.length) {
    const res = r.waiter;
    r.waiter = null;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(r.queue.shift()));
  }
}

const body = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
});

const indexHtml = () => readFileSync(join(dist, 'index.html'), 'utf8')
  .replace('<head>', '<head><script type="module" src="/__drive/agent.js"></script>');

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const path = decodeURIComponent(url.pathname);
  const who = url.searchParams.get('role') ?? 'default';
  if (path === '/__drive/status') {
    const out = {};
    for (const [name, r] of roles) out[name] = { waiting: !!r.waiter, queue: r.queue.length, lastPoll: r.lastPoll };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }
  if (path === '/__drive/next') {
    const r = role(who);
    r.lastPoll = new Date().toISOString();
    if (r.waiter) { r.waiter.writeHead(204); r.waiter.end(); }
    r.waiter = res;
    req.on('close', () => { if (r.waiter === res) r.waiter = null; });
    setTimeout(() => { if (r.waiter === res) { r.waiter = null; res.writeHead(204); res.end(); } }, 25_000);
    dispatch(r);
    return;
  }
  if (path === '/__drive/result' && req.method === 'POST') {
    const data = JSON.parse(await body(req));
    const p = pending.get(data.id);
    pending.delete(data.id);
    res.writeHead(204);
    res.end();
    if (p) {
      clearTimeout(p.timer);
      p.res.writeHead(200, { 'content-type': 'application/json' });
      p.res.end(JSON.stringify(data));
    }
    return;
  }
  if (path === '/__drive/run' && req.method === 'POST') {
    const code = await body(req);
    const id = ++seq;
    const file = `cmd-${STAMP}-${id}.js`;
    writeFileSync(join(cmdDir, file), `import * as __lib from '/__drive/lib.js';\nexport default async function () {\n const { $, $$, btn, click, sleep, fill, key, waitFor, text, rect } = __lib;\n${code}\n}\n`);
    const timeoutMs = Number(url.searchParams.get('timeout') ?? 60_000);
    const timer = setTimeout(() => { pending.delete(id); res.writeHead(504); res.end(JSON.stringify({ id, error: 'timeout' })); }, timeoutMs);
    pending.set(id, { res, timer });
    const r = role(who);
    r.queue.push({ id, url: `/__drive/cmds/${file}` });
    dispatch(r);
    return;
  }
  let filePath;
  if (path.startsWith('/__drive/cmds/')) filePath = join(cmdDir, path.slice('/__drive/cmds/'.length));
  else if (path.startsWith('/__drive/')) filePath = join(here, path.slice('/__drive/'.length));
  else filePath = join(dist, path);
  if (path === '/sw.js') { res.writeHead(404); res.end(); return; } // no service worker under test
  if (path === '/' || path === '/index.html' || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    if (!path.startsWith('/__drive/') && (!extname(path) || path === '/index.html')) {
      res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store' });
      res.end(indexHtml());
      return;
    }
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(filePath)] ?? 'application/octet-stream',
    'cache-control': path.startsWith('/__drive/') ? 'no-store' : 'max-age=3600',
  });
  res.end(readFileSync(filePath));
}).listen(port, '127.0.0.1', () => console.log(`audit-serve on http://localhost:${port} from ${dist}`));
