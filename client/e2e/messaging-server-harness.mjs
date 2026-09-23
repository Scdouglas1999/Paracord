// Disposable real-server fixture with a restart endpoint for replay-loss tests.
// Only this harness's own child and temporary directory are ever controlled.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const directory = mkdtempSync(join(tmpdir(), 'paracord-messaging-e2e-'));
const port = process.env.PARACORD_E2E_PORT ?? '18160';
const controlPort = Number(process.env.PARACORD_E2E_CONTROL_PORT ?? '18161');
const binary = process.env.PARACORD_E2E_SERVER_BIN ?? join(root, 'target', 'release', process.platform === 'win32' ? 'paracord-server.exe' : 'paracord-server');
const claimToken = 'messaging-e2e-first-owner-claim-token-0123456789';
const environment = { ...process.env,
  PARACORD_BIND_ADDRESS: `127.0.0.1:${port}`,
  PARACORD_DATABASE_ENGINE: 'sqlite', PARACORD_DATABASE_URL: `sqlite://${join(directory, 'paracord.db')}?mode=rwc`,
  PARACORD_JWT_SECRET: 'messaging-e2e-jwt-secret-0123456789abcdef', PARACORD_TLS_ENABLED: 'false',
  PARACORD_STORAGE_PATH: join(directory, 'uploads'), PARACORD_MEDIA_STORAGE_PATH: join(directory, 'files'), PARACORD_BACKUP_DIR: join(directory, 'backups'),
  PARACORD_REGISTRATION_ENABLED: 'true', PARACORD_REGISTRATION_MODE: 'open', PARACORD_AUTH_REQUIRE_EMAIL: 'true', PARACORD_LOG_ANSI: 'false', RUST_LOG: 'warn',
  // Every browser context in this suite is a distinct synthetic client. Without
  // this, one loopback address shares a single abuse-control bucket and the
  // server's real auth rate limit rejects the later accounts.
  PARACORD_TRUST_PROXY: '1', PARACORD_TRUSTED_PROXY_IPS: '127.0.0.1',
  // Own a dedicated media UDP port: the server refuses to boot when another
  // local instance already holds the default one.
  PARACORD_VOICE_PORT: process.env.PARACORD_E2E_VOICE_PORT ?? '18162',
  // These specs create their own accounts over REST; bootstrap without a
  // first-owner claim so the first registration still owns the instance.
  PARACORD_SETUP_REQUIRE_CLAIM: 'false',
  // Claim this disposable instance through the shipped first-owner flow rather
  // than disabling it, so the messaging journeys run against the real default.
  PARACORD_SETUP_CLAIM_TOKEN: claimToken,
};
let child; let exited; let stopping = false; let restarting = false; let ready = false;
function launch() {
  child = spawn(binary, ['-c', join(directory, 'paracord.toml')], { cwd: root, env: environment, stdio: 'inherit' });
  exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  const current = child;
  child.once('error', error => { console.error(`messaging fixture failed: ${error.message}`); void shutdown(1); });
  child.once('exit', code => { if (!stopping && !restarting && child === current) void shutdown(code || 1); });
}
async function stopChild() {
  const current = child; if (!current || current.exitCode !== null || current.signalCode !== null) return;
  const exit = exited; current.kill('SIGTERM');
  const kill = setTimeout(() => { if (current.exitCode === null && current.signalCode === null) current.kill('SIGKILL'); }, 5_000);
  await exit; clearTimeout(kill);
}
/** Finish the shipped first-owner claim so ordinary registration is open. */
async function claim() {
  const status = await fetch(`http://127.0.0.1:${port}/api/v1/setup/status`, { signal: AbortSignal.timeout(5_000) });
  if (!status.ok) throw new Error(`The owned messaging server did not report setup status (${status.status}).`);
  if (!(await status.json()).setup_required) return;
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/setup/claim`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ token: claimToken, username: 'messagingowner', email: 'owner@messaging.test',
      password: 'Messaging-Owner-Password-123!', instance_name: 'Messaging end-to-end instance', initial_space_name: 'Owner space' }),
  });
  if (!response.ok) throw new Error(`The owned messaging server rejected its first-owner claim (${response.status}): ${await response.text()}`);
}
async function healthy() {
  const deadline = Date.now() + 30_000;
  let responding = false;
  while (!stopping && !responding && Date.now() < deadline) {
    try { responding = (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* owned child is starting */ }
    if (!responding) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!responding) throw new Error('The owned messaging server did not become ready.');
  await claim(); ready = true;
}
const control = createServer(async (request, response) => {
  if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) { response.writeHead(404).end(); return; }
  // Readiness includes the claim: tests must never register into a pending instance.
  if (request.method === 'GET' && request.url === '/ready') { response.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ready })); return; }
  // Confidentiality tests need to inspect what the server actually wrote to
  // disk, and only this process knows its own temporary directory.
  if (request.method === 'GET' && request.url === '/paths') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ directory, uploads: environment.PARACORD_STORAGE_PATH, files: environment.PARACORD_MEDIA_STORAGE_PATH }));
    return;
  }
  if (request.method !== 'POST' || request.url !== '/restart') { response.writeHead(404).end(); return; }
  if (restarting || stopping) { response.writeHead(409).end(); return; }
  restarting = true;
  try { await stopChild(); launch(); await healthy(); response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"restarted":true}'); }
  catch { response.writeHead(500).end(); }
  finally { restarting = false; }
});
async function shutdown(code = 0) {
  if (stopping) return; stopping = true;
  control.close(); await stopChild(); rmSync(directory, { recursive: true, force: true }); process.exit(code);
}
control.once('error', error => { console.error(`messaging restart control failed: ${error.message}`); void shutdown(1); });
process.once('SIGTERM', () => { void shutdown(); }); process.once('SIGINT', () => { void shutdown(130); });
control.listen(controlPort, '127.0.0.1', () => { launch(); healthy().catch(error => { console.error(error.message); void shutdown(1); }); });
