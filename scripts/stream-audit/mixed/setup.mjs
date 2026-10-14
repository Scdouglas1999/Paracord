// Sign both apps in (one-password on a new server, legacy /login on an old one).
import { run, scene, sleep, log } from './drv.mjs';
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
    const state = await run(role, `return [location.pathname, !!$('input[type=password]'), !!$('input[type=checkbox]'), $$('input').length]`).catch(() => null);
    if (state) {
      const [p, pw, check, inputs] = state;
      log(role, 'at', p, 'pw', pw, 'check', check, 'inputs', inputs);
      if (p.startsWith('/app/') && !check) return p;
      if (p.startsWith('/login') && pw) {
        await run(role, `
          const ins = $$('input').filter((x) => x.type !== 'hidden' && x.type !== 'checkbox');
          const pwd = $('input[type=password]');
          const userIn = ins.find((x) => x !== pwd && /email|user|login|name/i.test((x.name || '') + (x.id || '') + (x.placeholder || '') + (x.autocomplete || '') + (x.type || ''))) ?? ins.find((x) => x !== pwd);
          if (userIn) fill(userIn, ${JSON.stringify(user + '@stream-audit.test')});
          fill(pwd, ${JSON.stringify(scene.password)}); await sleep(500);
          const b = $$('button').find((x) => /^(Sign in|Log in|Login)$/i.test(text(x)) && !x.disabled) ?? $$('button[type=submit]').pop();
          if (b) await click(b); return 1;`);
        await sleep(6000);
      } else if (p.startsWith('/unlock') && pw) {
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
const which = process.argv[2] ?? 'both';
if (which !== 'sender') log('viewer', await signIn('viewer', scene.viewer.username));
if (which !== 'viewer') log('sender', await signIn('sender', scene.sender.username));
