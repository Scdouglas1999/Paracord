// Shared driver helpers for the V7 lab: per-role audit-serve port.
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
export const OUT = process.env.RUN;
export const ports = JSON.parse(readFileSync(join(OUT, 'ports.json'), 'utf8'));
export const scene = JSON.parse(readFileSync(join(OUT, 'scene.json'), 'utf8'));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const mono = () => Number(process.hrtime.bigint() / 1000n);
export const log = (...a) => { const line = `${new Date().toISOString().slice(11, 23)} ${a.join(' ')}`; console.log(line); appendFileSync(join(OUT, 'drive.log'), line + '\n'); };
export async function run(role, body, timeout = 60000) {
  const r = await fetch(`http://127.0.0.1:${ports[role]}/__drive/run?role=${role}&timeout=${timeout}`, { method: 'POST', body });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (j.error) throw new Error(`${role}: ${j.error}`);
  return j.result;
}
