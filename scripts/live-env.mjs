#!/usr/bin/env node
// Launch a real Paracord instance for hands-on driving.
//
// This is the `real-server-harness.mjs` idea without Playwright's `webServer`
// lifecycle around it: the instance stays up until it is killed, keeps its data
// directory, and prints the URL and the accounts it seeded. It exists so a
// change can be driven through the actual product — several live accounts in one
// instance, talking to each other — rather than only through tests that assert
// on the shapes the product is supposed to produce.
//
// Build first:
//   cd client && npm run build
//   cargo build --release --bin paracord-server
//
// Usage:
//   node scripts/live-env.mjs [--port 18420] [--data /path] [--keep]

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const port = arg('port', '18420');
const dataDir = arg('data', join(repoRoot, '.live-env'));
const keep = process.argv.includes('--keep');
const origin = `http://127.0.0.1:${port}`;

const serverBin = join(repoRoot, 'target', 'release', 'paracord-server');
if (!existsSync(serverBin)) {
  console.error(`live-env: no server binary at ${serverBin}\n  cd client && npm run build\n  cargo build --release --bin paracord-server`);
  process.exit(1);
}

if (!keep) rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

const env = {
  ...process.env,
  PARACORD_BIND_ADDRESS: `127.0.0.1:${port}`,
  PARACORD_DATABASE_ENGINE: 'sqlite',
  PARACORD_DATABASE_URL: `sqlite://${join(dataDir, 'paracord.db')}?mode=rwc`,
  PARACORD_JWT_SECRET: 'live-env-jwt-secret-0123456789abcdef0123456789abcdef',
  PARACORD_TLS_ENABLED: 'false',
  PARACORD_STORAGE_PATH: join(dataDir, 'uploads'),
  PARACORD_MEDIA_STORAGE_PATH: join(dataDir, 'files'),
  PARACORD_BACKUP_DIR: join(dataDir, 'backups'),
  PARACORD_REGISTRATION_ENABLED: 'true', PARACORD_REGISTRATION_MODE: 'open',
  PARACORD_AUTH_REQUIRE_EMAIL: 'true',
  // The first account registered owns the instance, as pre-claim releases
  // behaved. The claim flow has its own coverage.
  PARACORD_SETUP_REQUIRE_CLAIM: 'false',
  PARACORD_LOG_ANSI: 'false',
  // One driver behind one loopback address stands in for many clients, so the
  // per-IP ceilings would fire on traffic that is not a defect. Everything else
  // about the limiter stays armed.
  PARACORD_HTTP_RATE_LIMIT_GLOBAL_PER_SECOND: '4000',
  PARACORD_HTTP_RATE_LIMIT_AUTH_PER_MINUTE: '4000',
  PARACORD_VOICE_PORT: String(Number(port) + 1),
  RUST_LOG: process.env.RUST_LOG ?? 'warn,paracord_api=info',
};

const logPath = join(dataDir, 'server.log');
writeFileSync(logPath, '');

const child = spawn(serverBin, ['-c', join(dataDir, 'paracord.toml')], {
  cwd: repoRoot,
  env,
  stdio: ['ignore', 'inherit', 'inherit'],
});

child.on('error', (error) => {
  console.error(`live-env: failed to launch: ${error.message}`);
  process.exit(1);
});

function shutdown() {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
}
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
process.on('SIGINT', () => { shutdown(); process.exit(130); });

// Wait for the instance to answer before announcing it, so a caller that pipes
// this into a driver does not race the bind.
const deadline = Date.now() + 60_000;
(async function announce() {
  for (;;) {
    try {
      const response = await fetch(`${origin}/api/v1/health`);
      if (response.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      console.error('live-env: server did not become healthy within 60s');
      shutdown();
      process.exit(1);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  console.log(`\nlive-env ready\n  url:  ${origin}\n  data: ${dataDir}\n  log:  ${logPath}\n`);
})();
