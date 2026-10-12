/**
 * A real, unclaimed Paracord server for the first-run real-server specs
 * (real-server.setup-claim, real-server.setup-join; docs/design/setup-plan.md
 * S13). Each spec launches its OWN instance of the release binary on its own
 * port (S13's real-server port is 18290; a busy port falls back to an
 * OS-assigned one), with a pinned claim token, in a throwaway data directory
 * that is deleted afterwards. Nothing here is mocked: the page is the
 * embedded UI the server serves.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const binName = process.platform === 'win32' ? 'paracord-server.exe' : 'paracord-server';
export const serverBin = resolve(process.env.PARACORD_E2E_SERVER_BIN ?? join(repoRoot, 'target', 'release', binName));
export const haveServer = existsSync(serverBin);

export const CLAIM_TOKEN = 'S13FIRSTRUNCLAIMTOKEN0123456789ABCDEFGHJKMNPQRSTVW';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function tcpPortFree(port: number): Promise<boolean> {
  const probe = createServer();
  return new Promise((resolvePromise) => {
    probe.once('error', () => resolvePromise(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolvePromise(true)));
  });
}

async function freeTcpPort(preferred: number): Promise<number> {
  if (await tcpPortFree(preferred)) return preferred;
  const probe = createServer();
  await new Promise<void>((r, j) => {
    probe.once('error', j);
    probe.listen(0, '127.0.0.1', r);
  });
  const address = probe.address();
  await new Promise<void>((r) => probe.close(() => r()));
  if (typeof address !== 'object' || !address?.port) throw new Error('no free TCP port');
  return address.port;
}

async function freeUdpPort(): Promise<number> {
  const probe = createSocket('udp4');
  await new Promise<void>((r, j) => {
    probe.once('error', j);
    probe.bind(0, '127.0.0.1', r);
  });
  const port = probe.address().port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

export interface FirstRunServer {
  base: string;
  output: () => string;
  stop: () => Promise<void>;
}

/** Launch an unclaimed server; `stop()` ends it and deletes its data. */
export async function launchFirstRunServer(preferredPort = Number(process.env.PARACORD_E2E_PORT ?? 18290)): Promise<FirstRunServer> {
  const dataDir = await mkdtemp(join(tmpdir(), 'paracord-s13-'));
  const configPath = join(dataDir, 'paracord.toml');
  const httpPort = await freeTcpPort(preferredPort);
  const udpPort = await freeUdpPort();
  const base = `http://127.0.0.1:${httpPort}`;
  const toml = (v: string) => JSON.stringify(v);
  for (const dir of ['uploads', 'files', 'backups']) await mkdir(join(dataDir, dir), { recursive: true });
  await writeFile(
    configPath,
    [
      '[server]',
      `bind_address = ${toml(`127.0.0.1:${httpPort}`)}`,
      'server_name = "s13-first-run"',
      '',
      '[database]',
      'engine = "sqlite"',
      `url = ${toml(`sqlite://${join(dataDir, 'paracord.db')}?mode=rwc`)}`,
      '',
      '[auth]',
      `jwt_secret = ${toml(randomBytes(32).toString('hex'))}`,
      'registration_enabled = true',
      'require_email = false',
      '',
      '[setup]',
      'require_claim = true',
      `claim_token = ${toml(CLAIM_TOKEN)}`,
      '',
      '[storage]',
      'storage_type = "local"',
      `path = ${toml(join(dataDir, 'uploads'))}`,
      '',
      '[media]',
      `storage_path = ${toml(join(dataDir, 'files'))}`,
      '',
      '[voice]',
      'native_media = true',
      `port = ${udpPort}`,
      '',
      '[tls]',
      'enabled = false',
      '',
      '[backup]',
      `backup_dir = ${toml(join(dataDir, 'backups'))}`,
      'auto_backup_enabled = false',
      '',
    ].join('\n'),
  );

  // No PARACORD_* override may leak in: the file above is authoritative.
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('PARACORD_')) env[key] = value;
  env.RUST_LOG = 'warn';

  const child: ChildProcess = spawn(serverBin, ['-c', configPath], { cwd: dataDir, env });
  let output = '';
  let exited = false;
  const done = new Promise<void>((r) => child.on('exit', () => ((exited = true), r())));
  const append = (chunk: Buffer) => {
    output = (output + chunk.toString('utf8')).slice(-120_000);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (exited) throw new Error(`server exited before it was healthy\n${output}`);
    try {
      if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never became healthy\n${output}`);
    await sleep(150);
  }

  return {
    base,
    output: () => output,
    stop: async () => {
      if (!exited) {
        child.kill('SIGTERM');
        await Promise.race([done, sleep(15_000)]);
        if (!exited) child.kill('SIGKILL');
      }
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
