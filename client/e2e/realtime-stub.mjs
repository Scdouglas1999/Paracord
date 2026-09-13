// A persistent realtime stream for the mocked browser suite. Playwright's
// `route.fulfill` always completes its response, so an intercepted SSE stream
// closes immediately and the client reconnects forever. The mocked dev server
// proxies /api to this stub, which keeps one authenticated READY stream open
// exactly like the real server, while every other request stays intercepted.
//
// It also has a back door. Two of WP9b's three signature moments — the lights
// coming on and somebody walking into a room — are things the SERVER does, and
// a gate that pokes the store directly would be measuring a fiction: the whole
// point of `MotionDirector` is that the edge is detected from real gateway
// traffic. So `POST /__emit` takes a gateway frame and writes it to every open
// stream, which is the same path a real `PRESENCE_UPDATE` takes.
import { createServer } from 'node:http';

const port = Number(process.env.PARACORD_E2E_RT_PORT ?? '4175');
const userId = process.env.PARACORD_E2E_RT_USER ?? '42';
const epoch = process.env.PARACORD_E2E_RT_EPOCH ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const streams = new Set();
/**
 * Frames replayed to every stream that opens, right behind its READY.
 *
 * A gate that wants to measure the app WAKING UP has to have a world for it to
 * wake up into, and the world has to be there before the page is. These are
 * that world: presence for the building's members and the voice states for
 * whoever is already in a room.
 */
let standing = [];
/**
 * Extra fields merged into every READY. The real server hands a client its
 * whole world here — the buildings it is in, their rooms, who is in those rooms
 * and whose lights are on — and WP9b's moments all happen to that world, so the
 * gate needs to be able to set it before the page loads.
 */
let world = {};
/**
 * While this is on, the stream endpoint refuses and every open stream is cut.
 *
 * `__drop` is a gateway BLIP — the client's first retry is deliberately 0ms, so
 * it is back before anybody could see it, which is exactly what WP9b's "lights
 * on" wanted. WP9d's other half needs the opposite: a gateway that is really
 * away, long enough for §5.1's outage to be worth drawing on the building. The
 * only honest way to drive that is to stop answering.
 */
let offline = false;

/** Write one gateway frame to every open stream. */
function broadcast(frame) {
  const line = `event: gateway\ndata: ${JSON.stringify(frame)}\n\n`;
  for (const stream of streams) stream.write(line);
  return streams.size;
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/health') { response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}'); return; }
  if (url.pathname === '/__standing' && request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        standing = Array.isArray(payload.frames) ? payload.frames : [];
        world = payload.world && typeof payload.world === 'object' ? payload.world : {};
      } catch {
        response.writeHead(400).end('{"error":"bad frames"}');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ standing: standing.length }));
    });
    return;
  }
  // Cut every open stream. The client reconnects immediately (its first retry
  // is deliberately 0ms), gets a fresh READY and the standing world again —
  // which is a real gateway reconnect, and one of the three things §5.1 says
  // turns the lights back on.
  if (url.pathname === '/__drop' && request.method === 'POST') {
    const dropped = streams.size;
    for (const stream of streams) stream.end();
    streams.clear();
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ dropped }));
    return;
  }
  if (url.pathname === '/__offline' && request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        offline = payload.offline !== false;
      } catch {
        response.writeHead(400).end('{"error":"bad offline"}');
        return;
      }
      if (offline) { for (const stream of streams) stream.end(); streams.clear(); }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ offline }));
    });
    return;
  }
  if (url.pathname === '/__emit' && request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      let sent = 0;
      try {
        const payload = JSON.parse(body || '{}');
        // One frame, or a batch delivered in order — a burst of five arrivals
        // has to be able to land inside one tick of the client's dispatch queue.
        for (const frame of Array.isArray(payload) ? payload : [payload]) sent = broadcast(frame);
      } catch {
        response.writeHead(400).end('{"error":"bad frame"}');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ streams: sent }));
    });
    return;
  }
  if (url.pathname !== '/api/v2/rt/events') { response.writeHead(404).end(); return; }
  if (offline) { response.writeHead(503, { 'Content-Type': 'application/json' }).end('{"error":"offline"}'); return; }
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const ready = { op: 0, t: 'READY', d: { session_id: url.searchParams.get('session_id') ?? 'mocked-session', database_history_epoch: epoch, user: { id: userId }, guilds: [], ...world } };
  response.write(`event: gateway\ndata: ${JSON.stringify(ready)}\n\n`);
  for (const frame of standing) response.write(`event: gateway\ndata: ${JSON.stringify(frame)}\n\n`);
  const keepalive = setInterval(() => response.write(': keepalive\n\n'), 10_000);
  streams.add(response);
  request.on('close', () => { clearInterval(keepalive); streams.delete(response); });
});
const shutdown = () => { for (const stream of streams) stream.end(); server.close(() => process.exit(0)); };
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
server.listen(port, '127.0.0.1');
