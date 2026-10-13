#!/usr/bin/env node
// setup.mjs --out <run dir> [--port 1477]: sign both apps in through their own
// pages and bring the call up: the server list (the trust dialog is answered
// ahead by side.sh), the first-run sign-in, the unlock, the recovery-phrase
// screen, Vincent in the voice room with the call view open.
//
// A one-password sign-in derives its key in the webview: about a minute per
// app under WebKitGTK. Later launches of the same HOME ask only for the unlock.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const OUT = arg('out');
const PORT = Number(arg('port', '1477'));
const scene = JSON.parse(readFileSync(join(OUT, 'scene.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(role, body, timeout = 60000) {
  const r = await fetch(`http://127.0.0.1:${PORT}/__drive/run?role=${role}&timeout=${timeout}`, { method: 'POST', body });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (j.error) throw new Error(`${role}: ${j.error}`);
  return j.result;
}

async function signIn(role, user) {
  const path = await run(role, 'return location.pathname');
  if (!path.startsWith('/app') && !path.startsWith('/unlock')) {
    await run(role, `
      localStorage.setItem('paracord:server-list', JSON.stringify({ state: { servers: [{ id: 's_audit', url: ${JSON.stringify(scene.base)}, name: 'Stream audit', token: null, connected: false }], activeServerId: 's_audit' }, version: 0 }));
      setTimeout(() => location.replace('/welcome/sign-in'), 50); return 1;`);
    await sleep(5000);
    await run(role, `
      const [s, u, p] = document.querySelectorAll('input');
      fill(s, ${JSON.stringify(scene.base)}); fill(u, ${JSON.stringify(user)}); fill(p, ${JSON.stringify(scene.password)});
      await sleep(2500);
      await click($$('button').filter((b) => text(b) === 'Sign in').pop());
      return 1;`);
  }
  for (let i = 0; i < 90; i++) {
    const state = await run(role, `return [location.pathname, !!$('input[type=password]'), !!$('input[type=checkbox]')]`).catch(() => null);
    if (state) {
      const [p, pw, check] = state;
      if (p.startsWith('/app/') && !check) return p;
      if (p.startsWith('/unlock') && pw) {
        await run(role, `fill($('input[type=password]'), ${JSON.stringify(scene.password)}); await sleep(300);
          const b = $$('button').find((x) => /unlock/i.test(text(x)) && !x.disabled); if (b) await click(b); return 1;`);
        await sleep(30000);
      } else if (check) {
        await run(role, `const c = $('input[type=checkbox]'); if (!c.checked) c.click(); await sleep(400); const go = $$('button').find((b) => /^(Continue|Open )/.test(text(b)) && !b.disabled); if (go) await click(go); return 1;`);
      }
    }
    await sleep(3000);
  }
  throw new Error(`${role} did not reach the app`);
}

console.log('viewer', await signIn('viewer', scene.viewer.username));
console.log('sender', await signIn('sender', scene.sender.username));
