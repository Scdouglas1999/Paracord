/**
 * The dev server for glass-send.config.ts, started through Vite's API (a process
 * that is not named "vite" survives another checkout's `pkill -f vite`), with its
 * own dependency cache so two checkouts sharing one node_modules never rewrite
 * each other's optimized dependencies mid-run.
 *
 *   node e2e/glass-send-dev.mjs <port>
 */
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'vite';

const port = Number(process.argv[2]);
if (!Number.isInteger(port)) throw new Error('Usage: node e2e/glass-send-dev.mjs <port>');

// `node_modules` may be a link to another checkout's (a worktree shares one
// install); Vite then serves fonts and dependencies from outside the root, and
// refuses unless that real directory is allowed.
const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
let modules = join(root, 'node_modules');
try {
  modules = realpathSync(modules);
} catch {
  /* no install to follow */
}

const server = await createServer({
  cacheDir: join(process.env.PARACORD_E2E_VITE_CACHE ?? tmpdir(), `paracord-vite-send-${port}`),
  server: { host: '127.0.0.1', port, strictPort: true, fs: { allow: [root, modules] } },
});
await server.listen();

const stop = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
