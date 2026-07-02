// Playwright `webServer` launcher for the real-server E2E smoke.
//
// Unlike the mocked `smoke.spec.ts` (which intercepts every /api call via
// page.route against `npm run dev`), this harness boots the *actual* release
// `paracord-server` binary serving the embedded web UI out of `client/dist/`,
// backed by a throwaway file-based SQLite database in a temp directory. The
// spec then performs a genuine register/login/authenticated-fetch round trip
// against the real REST API — exercising embedded-asset serving, real auth, and
// real contract shapes end to end.
//
// The env layout mirrors scripts/release_embedded_ui_smoke.py so both smokes
// launch the binary identically. The binary must already be built:
//   cd client && npm run build            # produces client/dist for rust-embed
//   cargo build --release --bin paracord-server
//
// On teardown Playwright sends SIGTERM (webServer.gracefulShutdown in
// playwright.config.ts); we forward it to the server child and remove the temp
// data dir so nothing leaks between runs. A startup sweep additionally removes
// stale data dirs from prior runs that were torn down with SIGKILL.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const TMP_PREFIX = 'paracord-e2e-real-';

// Anything older than an hour cannot belong to a live run.
function sweepStaleDataDirs() {
  let entries;
  try {
    entries = readdirSync(tmpdir());
  } catch {
    return;
  }
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const entry of entries) {
    if (!entry.startsWith(TMP_PREFIX)) continue;
    const full = join(tmpdir(), entry);
    try {
      if (statSync(full).mtimeMs < cutoff) {
        rmSync(full, { recursive: true, force: true });
      }
    } catch {
      // best effort
    }
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const port = process.env.PARACORD_E2E_PORT ?? '18150';
const binName = process.platform === 'win32' ? 'paracord-server.exe' : 'paracord-server';
const serverBin =
  process.env.PARACORD_E2E_SERVER_BIN ?? join(repoRoot, 'target', 'release', binName);

if (!existsSync(serverBin)) {
  console.error(
    `real-server harness: server binary not found at ${serverBin}\n` +
      'Build it first:\n' +
      '  cd client && npm run build\n' +
      '  cargo build --release --bin paracord-server',
  );
  process.exit(1);
}

sweepStaleDataDirs();

const dataDir = mkdtempSync(join(tmpdir(), TMP_PREFIX));
const dbPath = join(dataDir, 'paracord.db');

const env = {
  ...process.env,
  PARACORD_BIND_ADDRESS: `127.0.0.1:${port}`,
  PARACORD_DATABASE_ENGINE: 'sqlite',
  PARACORD_DATABASE_URL: `sqlite://${dbPath}?mode=rwc`,
  PARACORD_JWT_SECRET: 'real-server-e2e-jwt-secret-0123456789abcdef',
  PARACORD_TLS_ENABLED: 'false',
  PARACORD_STORAGE_PATH: join(dataDir, 'uploads'),
  PARACORD_MEDIA_STORAGE_PATH: join(dataDir, 'files'),
  PARACORD_BACKUP_DIR: join(dataDir, 'backups'),
  PARACORD_REGISTRATION_ENABLED: 'true',
  PARACORD_AUTH_REQUIRE_EMAIL: 'true',
  PARACORD_LOG_ANSI: 'false',
  RUST_LOG: process.env.RUST_LOG ?? 'warn',
};

const child = spawn(serverBin, ['-c', join(dataDir, 'paracord.toml')], {
  cwd: repoRoot,
  env,
  stdio: 'inherit',
});

let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
  } catch {
    // best effort
  }
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

function shutdown(signal) {
  cleanup();
  process.exit(signal === 'SIGINT' ? 130 : 0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('exit', cleanup);

child.on('exit', (code, signal) => {
  cleanup();
  if (signal) {
    process.exit(0);
  }
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  console.error(`real-server harness: failed to launch server: ${err.message}`);
  cleanup();
  process.exit(1);
});
