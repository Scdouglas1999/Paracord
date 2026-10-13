// A small W3C WebDriver client for tauri-driver (WebKitWebDriver underneath).
//
// The fresh-machine gate drives the real desktop app: tauri-driver starts the
// release `paracord-desktop` inside a container's user session and proxies to
// WebKitGTK's own WebDriver, so clicks and typing go through WebKit's input
// pipeline in the real webview, and the Tauri shell (keychain, service
// manager, clipboard, deep links) is the real one. No dependency is added to
// the client for this: the protocol is a handful of JSON requests.

import http from 'node:http';

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';

export class WebDriverError extends Error {
  constructor(message, data) {
    super(message);
    this.data = data;
  }
}

export const Keys = {
  Enter: '',
  Escape: '',
  Tab: '',
  Backspace: '',
  Control: '',
  Shift: '',
};

// WebKitWebDriver refuses requests whose Host header is not loopback (a DNS
// rebinding guard), and the container publishes it through socat, so every
// request says `Host: localhost`. fetch() cannot set Host; node:http can.
function request(base, method, path, body, timeoutMs = 120000) {
  const url = new URL(`${base}${path}`);
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: {
        Host: 'localhost',
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          reject(new WebDriverError(`${method} ${path}: ${res.statusCode} ${text.slice(0, 300)}`));
          return;
        }
        if (res.statusCode >= 400 || (json.value && json.value.error)) {
          const v = json.value ?? {};
          reject(new WebDriverError(`${method} ${path}: ${v.error ?? res.statusCode}: ${(v.message ?? text).slice(0, 400)}`, v));
          return;
        }
        resolve(json.value);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${path}: no answer in ${timeoutMs} ms`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export class Session {
  constructor(base, id, label) {
    this.base = base;
    this.id = id;
    this.label = label;
  }

  /** Start the app: tauri-driver launches `application` with `args`. */
  static async start(base, { application, args = [], label = 'app' }) {
    const value = await request(base, 'POST', '/session', {
      capabilities: {
        alwaysMatch: {
          'tauri:options': { application, args },
        },
      },
    }, 180000);
    return new Session(base, value.sessionId, label);
  }

  cmd(method, path, body, timeoutMs) {
    return request(this.base, method, `/session/${this.id}${path}`, body, timeoutMs);
  }

  async end() {
    try {
      await request(this.base, 'DELETE', `/session/${this.id}`, undefined, 30000);
    } catch {
      /* the app may already be gone */
    }
  }

  async find(selector, { using = 'css selector', root } = {}) {
    const path = root ? `/element/${root}/element` : '/element';
    const v = await this.cmd('POST', path, { using, value: selector });
    return v[ELEMENT];
  }

  async findAll(selector, { using = 'css selector' } = {}) {
    const v = await this.cmd('POST', '/elements', { using, value: selector });
    return v.map((e) => e[ELEMENT]);
  }

  /**
   * The first displayed match. With `loose`, the first match at all when none
   * reads as displayed: WebKitGTK's displayedness answer is false for rows in
   * a panel that slid in with a transform, though they are on screen and take
   * clicks (seen with the member list and the People sidebar).
   */
  async exists(selector, opts = {}) {
    try {
      const all = await this.findAll(selector, opts);
      for (const el of all) {
        if (await this.displayed(el).catch(() => false)) return el;
      }
      return opts.loose && all.length ? all[0] : null;
    } catch {
      return null;
    }
  }

  displayed(el) {
    return this.cmd('GET', `/element/${el}/displayed`);
  }

  click(el) {
    return this.cmd('POST', `/element/${el}/click`, {});
  }

  async type(el, text) {
    await this.cmd('POST', `/element/${el}/value`, { text });
  }

  clear(el) {
    return this.cmd('POST', `/element/${el}/clear`, {});
  }

  text(el) {
    return this.cmd('GET', `/element/${el}/text`);
  }

  attr(el, name) {
    return this.cmd('GET', `/element/${el}/attribute/${encodeURIComponent(name)}`);
  }

  prop(el, name) {
    return this.cmd('GET', `/element/${el}/property/${encodeURIComponent(name)}`);
  }

  exec(script, ...args) {
    return this.cmd('POST', '/execute/sync', { script, args });
  }

  execAsync(script, ...args) {
    return this.cmd('POST', '/execute/async', { script, args }, 180000);
  }

  url() {
    return this.cmd('GET', '/url');
  }

  title() {
    return this.cmd('GET', '/title');
  }

  async keys(...sequence) {
    const actions = [];
    for (const k of sequence) {
      for (const ch of [...k]) actions.push({ type: 'keyDown', value: ch });
      for (const ch of [...k].reverse()) actions.push({ type: 'keyUp', value: ch });
    }
    await this.cmd('POST', '/actions', { actions: [{ type: 'key', id: 'kb', actions }] });
    await this.cmd('DELETE', '/actions').catch(() => {});
  }

  async screenshot() {
    const b64 = await this.cmd('GET', '/screenshot', undefined, 60000);
    return Buffer.from(b64, 'base64');
  }

  /** Text content of the whole document (for assertions and diagnostics). */
  bodyText() {
    return this.exec('return document.body ? document.body.innerText : ""');
  }
}

/** Poll `fn` until it returns a truthy value. */
export async function until(fn, message, timeoutMs = 30000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) {
      throw new Error(`${message} (waited ${Math.round(timeoutMs / 1000)} s${last ? `; last error: ${last.message}` : ''})`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** XPath literal for arbitrary text. */
export function xpathLiteral(s) {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return `concat('${s.split("'").join(`', "'", '`)}')`;
}
