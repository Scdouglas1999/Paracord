// How a second invocation reaches the process that holds the scene.
//
// The holder owns every browser (the people in the calls and the viewer), so a
// step or a shot has to run inside it. It listens on a loopback port it picks
// itself and writes `control.json` (pid, port) beside the shots; `--step` and
// `--shot` read that file, check the pid is alive, and post the command. The
// holder streams its log lines back and ends with one `::result` line.

import { createServer } from 'node:http';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RESULT = '::result ';

export function controlFile(out) { return join(out, 'control.json'); }

/** A live holder for this output folder, or null. */
export function findHolder(out) {
  const file = controlFile(out);
  if (!existsSync(file)) return null;
  try {
    const info = JSON.parse(readFileSync(file, 'utf8'));
    process.kill(info.pid, 0); // throws when the process is gone
    return info;
  } catch {
    rmSync(file, { force: true });
    return null;
  }
}

/**
 * Serve commands. `handlers[name](body, say)` runs one command, calling
 * `say(line)` for progress, and resolves to a JSON-able result.
 */
export function serveControl({ out, base, handlers }) {
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', async () => {
      const name = request.url.replace(/^\//, '');
      const handler = handlers[name];
      if (!handler) {
        response.writeHead(404, { 'Content-Type': 'text/plain' });
        response.end(`no command "${name}"\n`);
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      let result;
      try {
        result = await handler(raw ? JSON.parse(raw) : {}, line => response.write(`${line}\n`));
      } catch (error) {
        result = { ok: false, error: error.message };
      }
      response.end(`${RESULT}${JSON.stringify(result ?? { ok: true })}\n`);
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      writeFileSync(controlFile(out), JSON.stringify({ pid: process.pid, port, base, started: new Date().toISOString() }, null, 2));
      resolve({
        port,
        close: () => new Promise(done => { rmSync(controlFile(out), { force: true }); server.close(done); server.closeAllConnections?.(); }),
      });
    });
  });
}

/** Post a command to a holder, echoing its log; resolves to the command's result. */
export async function sendCommand(holder, name, body, echo = line => console.log(line)) {
  const response = await fetch(`http://127.0.0.1:${holder.port}/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  if (!response.ok || !response.body) throw new Error(`the holder answered ${response.status}: ${await response.text()}`);
  const decoder = new TextDecoder();
  let buffer = '';
  let result = null;
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let split;
    while ((split = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, split);
      buffer = buffer.slice(split + 1);
      if (line.startsWith(RESULT)) result = JSON.parse(line.slice(RESULT.length));
      else echo(line);
    }
  }
  if (!result) throw new Error('the holder closed the connection without a result (did it exit?)');
  return result;
}
