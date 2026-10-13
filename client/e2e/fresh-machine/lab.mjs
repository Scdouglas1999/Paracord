// The container lab for the fresh-machine gate: networks, the router, the
// "computers", and the commands run inside them. Everything it creates is
// named `pcfm-*` and is removed by `teardown()`; nothing on the machine that
// runs it is touched beyond Docker's own networks and containers.

import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '../../..');
export const HARNESS = join(REPO, 'scripts/fresh-machine');
export const PREFIX = 'pcfm';
export const KEYRING_PASSWORD = 'fresh-machine keyring 1';

export const NETWORKS = {
  lan: { name: `${PREFIX}-lan`, subnet: '192.168.50.0/24', gateway: '192.168.50.254' },
  wan: { name: `${PREFIX}-wan`, subnet: '203.0.113.0/24', gateway: '203.0.113.254' },
  cgnLan: { name: `${PREFIX}-cgn-lan`, subnet: '192.168.60.0/24', gateway: '192.168.60.254' },
  cgnWan: { name: `${PREFIX}-cgn-wan`, subnet: '100.64.0.0/24', gateway: '100.64.0.254' },
};

export const IMAGES = {
  desktop: 'paracord-fresh/desktop:latest',
  router: 'paracord-fresh/router:latest',
};

export function docker(args, { input, allowFail = false, timeout = 600000 } = {}) {
  const r = spawnSync('docker', args, { input, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`docker ${args.slice(0, 4).join(' ')} … failed (${r.status}): ${(r.stderr || r.stdout || '').trim().slice(0, 1200)}`);
  }
  return { out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), status: r.status };
}

export function exec(container, cmd, opts = {}) {
  const args = ['exec'];
  if (opts.input !== undefined) args.push('-i');
  if (opts.user) args.push('-u', opts.user);
  args.push(container, ...cmd);
  return docker(args, opts);
}

/** docker exec without blocking the event loop (for watchers). */
export function execQuiet(container, cmd) {
  return new Promise((resolve) => {
    execFile('docker', ['exec', container, ...cmd], { encoding: 'utf8', timeout: 20000 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

/** Run as sam inside the session environment. */
export function sam(container, cmd, opts = {}) {
  return exec(container, ['pc', 'sam', ...cmd], opts);
}

export function buildImages() {
  docker(['build', '-q', '-t', IMAGES.router, join(HARNESS, 'router')], { timeout: 1800000 });
  docker(['build', '-q', '-t', IMAGES.desktop, join(HARNESS, 'desktop')], { timeout: 3600000 });
}

export function createNetworks(which = ['lan', 'wan']) {
  for (const key of which) {
    const n = NETWORKS[key];
    if (docker(['network', 'inspect', n.name], { allowFail: true }).status === 0) continue;
    docker(['network', 'create', '--driver', 'bridge', '--subnet', n.subnet, '--gateway', n.gateway,
      '--opt', 'com.docker.network.bridge.enable_ip_masquerade=true', '--label', 'paracord-fresh=1', n.name]);
  }
}

/**
 * The router: wan side first (its default route), then the lan side.
 * mode: allow | deny | off.
 */
export function startRouter({ name = `${PREFIX}-router`, lan = NETWORKS.lan, wan = NETWORKS.wan, lanIp = '192.168.50.1', wanIp = '203.0.113.1', mode = 'allow' } = {}) {
  docker(['rm', '-f', name], { allowFail: true });
  docker(['create', '--name', name, '--hostname', 'router', '--label', 'paracord-fresh=1',
    '--cap-add', 'NET_ADMIN', '--cap-add', 'NET_RAW',
    '--sysctl', 'net.ipv4.ip_forward=1', '--sysctl', 'net.ipv4.conf.all.rp_filter=0',
    '--network', wan.name, '--ip', wanIp,
    '-e', `LAN_IP=${lanIp}`, '-e', `WAN_IP=${wanIp}`, '-e', `WAN_GW=${wan.gateway}`, '-e', `UPNP_MODE=${mode}`,
    IMAGES.router]);
  docker(['network', 'connect', '--ip', lanIp, lan.name, name]);
  docker(['start', name]);
  if (mode !== 'off') {
    // Up means miniupnpd stayed up (a config error makes it exit at once).
    waitFor(() => exec(name, ['pgrep', '-x', 'miniupnpd'], { allowFail: true }).status === 0, `${name}: miniupnpd did not start: ${logs(name, 20)}`, 20000);
    execFileSync('sleep', ['1']);
    if (exec(name, ['pgrep', '-x', 'miniupnpd'], { allowFail: true }).status !== 0) throw new Error(`${name}: miniupnpd exited: ${logs(name, 20)}`);
  }
  return name;
}

export function routerMode(name, mode) {
  exec(name, ['router-ctl', 'mode', mode]);
}

export function routerMappings(name) {
  return exec(name, ['router-ctl', 'mappings'], { allowFail: true }).out;
}

function waitFor(fn, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) throw new Error(message);
    execFileSync('sleep', ['0.3']);
  }
}

/**
 * A computer: systemd boots, the release desktop build is copied to
 * /opt/paracord (paracord-desktop with paracord-host beside it, as the
 * bundle installs them), sam signs in.
 */
export function startComputer({ name, hostname, network, ip, router, binDir }) {
  docker(['rm', '-f', name], { allowFail: true });
  const args = ['run', '-d', '--name', name, '--hostname', hostname, '--label', 'paracord-fresh=1',
    '--cap-add', 'SYS_ADMIN', '--cap-add', 'NET_ADMIN',
    '--security-opt', 'seccomp=unconfined', '--security-opt', 'apparmor=unconfined',
    '--cgroupns=private', '--tmpfs', '/run', '--tmpfs', '/run/lock', '--tmpfs', '/tmp:exec',
    '--shm-size', '1g', '--network', network.name, '--ip', ip, IMAGES.desktop];
  let booted = false;
  for (let attempt = 0; attempt < 2 && !booted; attempt++) {
    if (attempt) docker(['rm', '-f', name], { allowFail: true });
    docker(args);
    booted = exec(name, ['pc', 'wait-boot'], { allowFail: true }).status === 0;
  }
  if (!booted) throw new Error(`${name}: systemd did not boot twice; ${docker(['logs', name], { allowFail: true }).out.slice(-800)}`);
  if (router) exec(name, ['ip', 'route', 'replace', 'default', 'via', router]);
  exec(name, ['mkdir', '-p', '/opt/paracord', '/etc/fresh-machine']);
  for (const f of ['paracord-desktop', 'paracord-host', 'tauri-driver']) {
    if (!existsSync(join(binDir, f))) throw new Error(`missing ${join(binDir, f)}`);
    docker(['cp', join(binDir, f), `${name}:/opt/paracord/${f}`]);
  }
  exec(name, ['chmod', '0755', '/opt/paracord/paracord-desktop', '/opt/paracord/paracord-host', '/opt/paracord/tauri-driver']);
  // What the .deb/.rpm puts in place besides the binaries: the app's desktop
  // entry (client/src-tauri/linux/com.paracord.desktop.desktop, named after the
  // window's app id) with the paracord:// scheme, so a link can start the app
  // before it has ever run.
  const entry = [
    '[Desktop Entry]', 'Type=Application', 'Name=Paracord', 'Exec=/opt/paracord/paracord-desktop %u',
    'Icon=com.paracord.desktop', 'Terminal=false', 'Categories=Network;InstantMessaging;Chat;',
    'MimeType=x-scheme-handler/paracord;', 'StartupWMClass=com.paracord.desktop', '',
  ].join('\n');
  exec(name, ['sh', '-c', 'cat > /usr/share/applications/com.paracord.desktop.desktop && update-desktop-database /usr/share/applications'], { input: entry });
  exec(name, ['sh', '-c', `printf %s '${KEYRING_PASSWORD}' > /etc/fresh-machine/keyring-password && chown sam /etc/fresh-machine/keyring-password && chmod 0400 /etc/fresh-machine/keyring-password`]);
  signIn(name);
  return name;
}

/** sam signs in to the computer: user manager, keyring unlocked, audio, driver. */
export function signIn(name) {
  exec(name, ['pc', 'session-start']);
  exec(name, ['pc', 'driver-start']);
}

/** sam signs out: everything in the session stops, the service included. */
export function signOut(name) {
  exec(name, ['pc', 'session-stop']);
}

export function containerIp(name, network) {
  return docker(['inspect', '-f', `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, name]).out;
}

export function driverUrl(ip) {
  return `http://${ip}:4444`;
}

/** Screenshot of the container's whole X display (native windows included). */
export function shotX(name, file) {
  const r = spawnSync('docker', ['exec', name, 'pc', 'shot', 'png:-'], { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${name}: screenshot failed: ${String(r.stderr).slice(0, 400)}`);
  writeFileSync(file, r.stdout);
}

export function teardown() {
  const ids = docker(['ps', '-aq', '--filter', 'label=paracord-fresh=1'], { allowFail: true }).out.split('\n').filter(Boolean);
  if (ids.length) docker(['rm', '-f', '-v', ...ids], { allowFail: true });
  for (const n of Object.values(NETWORKS)) docker(['network', 'rm', n.name], { allowFail: true });
}

export function logs(name, tail = 200) {
  const r = docker(['logs', '--tail', String(tail), name], { allowFail: true });
  return `${r.out}\n${r.err}`;
}
