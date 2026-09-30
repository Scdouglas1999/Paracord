/**
 * The dev server for glass-sheets.config.ts, started through Vite's API instead
 * of the `vite` command. Same server, same vite.config.ts; the difference is
 * that its process is not named "vite", so another checkout's cleanup
 * (`pkill -f vite`) cannot take it down mid-run, which it did.
 *
 *   node e2e/glass-sheets-dev.mjs <port>
 */
import { createServer } from 'vite';

const port = Number(process.argv[2]);
if (!Number.isInteger(port)) throw new Error('Usage: node e2e/glass-sheets-dev.mjs <port>');

const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true } });
await server.listen();

const stop = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
