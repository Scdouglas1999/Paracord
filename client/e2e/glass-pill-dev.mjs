/**
 * The dev server for glass-pill.config.ts (WP-G12), started through Vite's API
 * instead of the `vite` command, so its process is not named "vite" and another
 * checkout's cleanup (`pkill -f vite`) cannot take it down mid-run.
 *
 *   node e2e/glass-pill-dev.mjs <port>
 */
import { createServer } from 'vite';

const port = Number(process.argv[2]);
if (!Number.isInteger(port)) throw new Error('Usage: node e2e/glass-pill-dev.mjs <port>');

const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true } });
await server.listen();

const stop = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
