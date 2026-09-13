import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page, type PlaywrightTestArgs } from '@playwright/test';

/**
 * Two real accounts exchange attachments in a direct message against the real
 * release server, and the marker they send is looked for everywhere the server
 * could have kept it: the upload request body, the message body, the object on
 * the server's disk, and the browser's own `localStorage`.
 *
 * Nothing here is mocked. The only fixture is the harness's temporary server.
 */
type Playwright = PlaywrightTestArgs['playwright'];
// Defaults match `playwright.messaging.config.ts`; the env overrides let this
// spec run against an isolated harness on another port without editing it.
const origin = process.env.PARACORD_E2E_APP_ORIGIN ?? 'http://127.0.0.1:4174';
const server = `http://127.0.0.1:${process.env.PARACORD_E2E_PORT ?? '18160'}`;
const control = `http://127.0.0.1:${process.env.PARACORD_E2E_CONTROL_PORT ?? '18161'}`;
const password = 'Durable-Server-Password-123!';
const encryptionPassword = 'Separate-Encryption-Password-123!';

/** An 8x4 PNG, so the rendered preview's dimensions can be checked exactly. */
const PNG_8X4 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAYAAACzzX7wAAAAQUlEQVR42hXKMQHAMAgAMJRMCUpQgpIqQUTvGurSI18iYt+PpGgWwyEiBZKiWQwnX2iBpGgWw+kXRiApmsVwZt8fTQFRQWdDg1oAAAAASUVORK5CYII=',
  'base64',
);

async function account(browser: Browser, playwright: Playwright, name: string) {
  const register = await playwright.request.newContext();
  const email = `${name}-${Date.now()}@example.test`;
  const response = await register.post(`${server}/api/v1/auth/register`, { data: { email, username: `${name}${Date.now()}`, password } });
  expect(response.status(), await response.text()).toBe(201);
  const credentials = await response.json(); await register.dispose();
  const api = await playwright.request.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${credentials.token}` } });
  const context = await browser.newContext(); const page = await context.newPage();
  await page.goto(`${origin}/login`);
  await page.locator('input[autocomplete="username"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.getByRole('button', { name: 'Log In', exact: true }).click();
  await expect(page).toHaveURL(/\/app/);
  return { context, page, api, user: credentials.user };
}

async function dismiss(page: Page) {
  for (const name of ['Skip tour', 'Close welcome screen']) {
    const button = page.getByRole('button', { name, exact: true });
    if (await button.isVisible()) await button.click();
  }
}

async function setup(page: Page, id: string, returnTo: string) {
  await page.goto(`${origin}/setup?${new URLSearchParams({ migrate: '1', server: '__local__', user: id, returnTo })}`);
  await page.getByLabel('New Encryption Password', { exact: false }).fill(encryptionPassword);
  await page.getByLabel('Confirm Password', { exact: false }).fill(encryptionPassword);
  await page.getByLabel('Current Server Password', { exact: false }).fill(password);
  await page.getByRole('button', { name: 'Secure Account' }).click();
  await expect(page.getByRole('heading', { name: 'Recovery Phrase' }).or(page.getByRole('alert'))).toBeVisible();
  if (await page.getByRole('alert').isVisible()) throw new Error(await page.getByRole('alert').innerText());
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(returnTo));
  await expect(page.getByRole('button', { name: 'Skip tour', exact: true })).toBeVisible(); await dismiss(page);
}

/** Every regular file under `root`, however the backend chose to lay it out. */
function walk(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) visit(path);
      else found.push(path);
    }
  };
  try { visit(root); } catch { /* The backend creates its directory lazily. */ }
  return found;
}

test('a direct-message attachment reaches the recipient without the server ever holding it in the clear', async ({ browser, playwright }, testInfo) => {
  const marker = `PARACORD-ATTACHMENT-MARKER-${Date.now()}`;
  const textBody = Buffer.from(`${marker}\nthe body of a private text attachment`);
  const alice = await account(browser, playwright, 'attachalice');
  const bob = await account(browser, playwright, 'attachbob');
  // Chromium does not hand a multipart body built from a Blob back to the test,
  // so the upload is judged by what the server recorded for it — and by the
  // bytes it wrote to disk, which the Rust route test proves are the exact
  // bytes received. The message body is JSON and is read directly.
  const uploads: Array<{ url: string; recorded: { filename?: string; content_type?: string; size?: number } }> = [];
  const messages: string[] = [];
  for (const page of [alice.page, bob.page]) {
    page.on('request', request => {
      if (request.method() !== 'POST') return;
      if (/\/channels\/\d+\/messages$/.test(new URL(request.url()).pathname)) messages.push(request.postData() ?? '');
    });
    page.on('response', response => {
      const request = response.request();
      if (request.method() !== 'POST' || !/\/channels\/\d+\/attachments$/.test(new URL(request.url()).pathname)) return;
      void response.json().then(recorded => uploads.push({ url: request.url(), recorded })).catch(() => {});
    });
  }

  try {
    const requested = await alice.api.post(`${server}/api/v1/users/@me/relationships`, { data: { user_id: bob.user.id, type: 1 } });
    expect(requested.ok(), await requested.text()).toBe(true);
    const accepted = await bob.api.put(`${server}/api/v1/users/@me/relationships/${alice.user.id}`);
    expect(accepted.ok(), await accepted.text()).toBe(true);
    const created = await alice.api.post(`${server}/api/v1/users/@me/dms`, { data: { recipient_id: bob.user.id } });
    expect(created.status(), await created.text()).toBe(201);
    const dm = await created.json(); const route = `/app/dms/${dm.id}`;
    await setup(bob.page, bob.user.id, route); await setup(alice.page, alice.user.id, route);

    const composer = alice.page.getByRole('textbox', { name: /Message/ }).last();
    await composer.fill('sending the file now');
    // The attach action is only offered once the encrypted producer can run:
    // unlocked storage, a verified identity and a ready recipient.
    await expect(alice.page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    await expect(alice.page.getByRole('button', { name: 'Attach files' })).toBeEnabled();
    await alice.page.locator('input[type="file"]').setInputFiles([
      { name: `${marker}.png`, mimeType: 'image/png', buffer: PNG_8X4 },
      { name: `${marker}.txt`, mimeType: 'text/plain', buffer: textBody },
    ]);
    await expect(alice.page.getByRole('button', { name: `Remove ${marker}.png` })).toBeVisible();
    await expect(alice.page.getByRole('button', { name: `Remove ${marker}.txt` })).toBeVisible();
    await composer.press('Enter');

    // The recipient sees the sender's real filenames, decrypted locally.
    await expect(bob.page.getByText('sending the file now', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(bob.page.getByText(`${marker}.png`)).toBeVisible();
    await expect(bob.page.getByText(`${marker}.txt`)).toBeVisible();

    // The image is decrypted and rendered at its true dimensions.
    const image = bob.page.getByAltText(`${marker}.png`).first();
    await expect(image).toBeVisible();
    await expect.poll(async () => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(8);
    expect(await image.evaluate((element: HTMLImageElement) => element.naturalHeight)).toBe(4);
    expect(await image.getAttribute('src')).toMatch(/^blob:/);

    // The text attachment is decrypted on demand and saves as its plaintext.
    const textRow = bob.page.locator('div').filter({ hasText: new RegExp(`^.*${marker}\\.txt.*$`) });
    await expect(textRow.first()).toBeVisible();
    const download = bob.page.waitForEvent('download');
    await bob.page.getByRole('button', { name: /Download/ }).last().click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe(`${marker}.txt`);
    const savedPath = await saved.path();
    expect(readFileSync(savedPath!, 'utf8')).toBe(textBody.toString('utf8'));

    // What the server received: two opaque uploads and one encrypted message.
    await expect.poll(() => uploads.length).toBe(2);
    for (const upload of uploads) {
      expect(upload.url).toContain(`/channels/${dm.id}/attachments`);
      // The name and type the server ended up with carry nothing of the file.
      expect(upload.recorded.filename).toMatch(/^[0-9a-f]{32}\.bin$/);
      expect(upload.recorded.content_type).toBe('application/octet-stream');
    }
    // Ciphertext, not plaintext: each object is the file plus its 16-byte tag.
    const sizes = uploads.map(upload => upload.recorded.size).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(sizes).toEqual([PNG_8X4.byteLength + 16, textBody.byteLength + 16].sort((a, b) => a - b));
    expect(messages.length).toBeGreaterThan(0);
    for (const body of messages) {
      expect(body).not.toContain(marker);
      expect(body).not.toContain('sending the file now');
      expect(JSON.parse(body).content).toBe('');
    }

    // What the server kept: opaque objects that contain none of it.
    const paths = await (await fetch(`${control}/paths`)).json() as { directory: string };
    const stored = walk(paths.directory);
    expect(stored.length).toBeGreaterThan(0);
    for (const path of stored) {
      const bytes = readFileSync(path);
      expect(bytes.includes(marker), `${path} contains the marker`).toBe(false);
      expect(bytes.includes('the body of a private text attachment'), `${path} contains the attachment body`).toBe(false);
      expect(bytes.includes('sending the file now'), `${path} contains the message text`).toBe(false);
    }
    const objects = stored.filter(path => path.includes('attachments'));
    expect(objects.length).toBe(2);
    // The storage key is derived from the attachment's own id, so not even the
    // client-chosen opaque name reaches the disk — and no extension of the real
    // file type does either.
    for (const path of objects) expect(path).toMatch(/\/\d+\.bin$/);

    // And what the browser kept outside the encrypted vault: nothing.
    for (const page of [alice.page, bob.page]) {
      const storage = await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(localStorage))));
      expect(storage).not.toContain(marker);
    }

    await bob.page.screenshot({ path: testInfo.outputPath('recipient-decrypted-attachments.png'), fullPage: true });
    await alice.page.screenshot({ path: testInfo.outputPath('sender-encrypted-attachments.png'), fullPage: true });
    await bob.page.setViewportSize({ width: 390, height: 844 });
    await expect(bob.page.getByText(`${marker}.png`)).toBeVisible();
    await bob.page.screenshot({ path: testInfo.outputPath('recipient-decrypted-attachments-390.png'), fullPage: true });
  } finally {
    await alice.api.dispose(); await bob.api.dispose();
    await alice.context.close(); await bob.context.close();
  }
});
