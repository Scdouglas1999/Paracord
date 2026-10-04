/**
 * The dev server for index-review.config.ts (docs/design/index-plan.md §3, IX-0),
 * started through Vite's API instead of the `vite` command, so its process is
 * not named "vite" and another checkout's cleanup (`pkill -f vite`) cannot take
 * it down mid-run. Same trick as glass-stage-dev.mjs.
 *
 *   node e2e/index-dev.mjs <port>
 *
 * The config passes `VITE_DEV_PROXY_TARGET` (the realtime stub, so the page's
 * gateway stream reaches it through the dev server's /api proxy) and
 * `VITE_DEV_HMR=false` (a concurrent source edit by another package must not
 * remount the app in the middle of a shot).
 */
import { existsSync, realpathSync } from 'node:fs';
import { createServer, searchForWorkspaceRoot } from 'vite';

const port = Number(process.argv[2]);
if (!Number.isInteger(port)) throw new Error('Usage: node e2e/index-dev.mjs <port>');

// `client/node_modules` may be a symlink into another checkout (it is, in the Index
// worktree). Vite refuses to serve a file outside its allow list, and the fonts
// are such files: without this the shots would be drawn in a fallback face.
const allow = [searchForWorkspaceRoot(process.cwd())];
if (existsSync('node_modules')) allow.push(realpathSync('node_modules'));

const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, fs: { allow } } });
await server.listen();

const stop = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
