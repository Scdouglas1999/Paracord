// A persistent realtime stream for the mocked browser suite. Playwright's
// `route.fulfill` always completes its response, so an intercepted SSE stream
// closes immediately and the client reconnects forever. The mocked dev server
// proxies /api to this stub, which keeps one authenticated READY stream open
// exactly like the real server, while every other request stays intercepted.
import { createServer } from 'node:http';

const port = Number(process.env.PARACORD_E2E_RT_PORT ?? '4175');
const userId = process.env.PARACORD_E2E_RT_USER ?? '42';
const epoch = process.env.PARACORD_E2E_RT_EPOCH ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const streams = new Set();

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/health') { response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}'); return; }
  if (url.pathname !== '/api/v2/rt/events') { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const ready = { op: 0, t: 'READY', d: { session_id: url.searchParams.get('session_id') ?? 'mocked-session', database_history_epoch: epoch, user: { id: userId }, guilds: [] } };
  response.write(`event: gateway\ndata: ${JSON.stringify(ready)}\n\n`);
  const keepalive = setInterval(() => response.write(': keepalive\n\n'), 10_000);
  streams.add(response);
  request.on('close', () => { clearInterval(keepalive); streams.delete(response); });
});
const shutdown = () => { for (const stream of streams) stream.end(); server.close(() => process.exit(0)); };
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
server.listen(port, '127.0.0.1');
