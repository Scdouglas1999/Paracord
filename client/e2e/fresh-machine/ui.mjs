// Page helpers over the WebDriver session: find by test id, role-ish button
// names and visible text; screenshots with a running step number.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Keys, until, xpathLiteral, sleep } from './wd.mjs';
import { shotX } from './lab.mjs';

export class Ui {
  constructor(session, { container, shotsDir, prefix }) {
    this.s = session;
    this.container = container;
    this.shotsDir = shotsDir;
    this.prefix = prefix;
    mkdirSync(shotsDir, { recursive: true });
  }

  static counter = 0;

  /** Webview screenshot, numbered across the run: NN-<prefix>-<name>.png */
  async shot(name) {
    Ui.counter += 1;
    const file = join(this.shotsDir, `${String(Ui.counter).padStart(3, '0')}-${this.prefix}-${name}.png`);
    try {
      writeFileSync(file, await this.s.screenshot());
    } catch {
      // A webview that is gone (the app quit) still has an X display.
      shotX(this.container, file);
    }
    return file;
  }

  /** The whole X display (for native dialogs over the webview). */
  shotScreen(name) {
    Ui.counter += 1;
    const file = join(this.shotsDir, `${String(Ui.counter).padStart(3, '0')}-${this.prefix}-${name}.png`);
    shotX(this.container, file);
    return file;
  }

  async tid(id, timeoutMs = 30000) {
    return until(() => this.s.exists(`[data-testid="${id}"]`), `${this.prefix}: [data-testid=${id}] never showed`, timeoutMs);
  }

  async maybeTid(id) {
    return this.s.exists(`[data-testid="${id}"]`);
  }

  /** A button (or link/role=button) whose visible text or aria-label is `name`. */
  buttonXpath(name, { exact = true } = {}) {
    const lit = xpathLiteral(name);
    const textTest = exact ? `normalize-space(.)=${lit}` : `contains(normalize-space(.), ${lit})`;
    const ariaTest = exact ? `@aria-label=${lit}` : `contains(@aria-label, ${lit})`;
    return `//*[self::button or self::a or @role='button' or @role='menuitem' or @role='tab' or @role='radio'][(${textTest}) or (${ariaTest})]`;
  }

  async button(name, { timeoutMs = 30000, exact = true } = {}) {
    return until(async () => {
      const all = (await this.s.findAll(this.buttonXpath(name, { exact }), { using: 'xpath' })).reverse();
      let hidden = null;
      for (const el of all) {
        const disabled = await this.s.prop(el, 'disabled').catch(() => false);
        if (disabled) continue;
        if (await this.s.displayed(el).catch(() => false)) return el;
        // WebKitGTK's displayedness check is conservative (a nav row inside a
        // transformed panel reads as hidden while a click on it works).
        hidden ??= el;
      }
      return hidden;
    }, `${this.prefix}: no enabled button "${name}"`, timeoutMs);
  }

  async hasButton(name, opts) {
    try {
      await this.button(name, { timeoutMs: 1, ...opts });
      return true;
    } catch {
      return false;
    }
  }

  async click(name, opts) {
    const el = await this.button(name, opts);
    await this.s.click(el);
    return el;
  }

  async clickTid(id, timeoutMs) {
    const el = await this.tid(id, timeoutMs);
    await until(async () => !(await this.s.prop(el, 'disabled').catch(() => false)), `${this.prefix}: ${id} stayed disabled`, timeoutMs ?? 30000);
    await this.s.click(el);
    return el;
  }

  async fill(id, text) {
    const el = await this.tid(id);
    await this.s.clear(el).catch(() => {});
    await this.s.type(el, text);
    return el;
  }

  async text() {
    return this.s.bodyText();
  }

  async waitText(needle, timeoutMs = 30000) {
    return until(async () => {
      const t = await this.s.bodyText();
      return (typeof needle === 'string' ? t.includes(needle) : needle.test(t)) ? t : null;
    }, `${this.prefix}: never saw ${needle}`, timeoutMs);
  }

  async heading(name, timeoutMs = 30000) {
    const lit = xpathLiteral(name);
    return until(() => this.s.exists(`//*[self::h1 or self::h2 or self::h3][normalize-space(.)=${lit}]`, { using: 'xpath' }), `${this.prefix}: heading "${name}" never showed`, timeoutMs);
  }

  async press(key) {
    await this.s.keys(Keys[key] ?? key);
  }

  async path() {
    return this.s.exec('return location.pathname + location.search + location.hash');
  }

  sleep(ms) {
    return sleep(ms);
  }
}
