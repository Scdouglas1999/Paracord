/**
 * First run, claim mode (docs/setup-spec.md §2.11), on a real unclaimed
 * server: the page a headless install opens (`/setup-server#claim=…`) makes
 * the owner with one password, reports the server's own status rows, shows
 * the phrase, makes an invite and lands in the new server. Replaces the
 * retired InstanceSetupPage spec (real-server-setup.spec.ts).
 *
 *   PARACORD_E2E_REAL=1 PARACORD_E2E_SERVER_BIN=… npx playwright test e2e/real-server.setup-claim.spec.ts
 */
import { createDecipheriv, createHash, createPrivateKey, createPublicKey, hkdfSync } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { CLAIM_TOKEN, haveServer, launchFirstRunServer, serverBin, type FirstRunServer } from './fixtures/firstRunServer';

test.describe('claim mode on a real server', () => {
  test.skip(!haveServer, `release server binary not built at ${serverBin}`);
  test.setTimeout(180_000);

  let server: FirstRunServer;
  test.beforeAll(async () => {
    // Encrypted, as the installers leave a new server (S14): the claim page escrows its key (S13b).
    server = await launchFirstRunServer(undefined, { atRest: true });
  });
  test.afterAll(async () => {
    await server?.stop();
  });

  test('a headless install is claimed through the first run and lands in its server', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: server.base });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(`/setup-server#claim=${CLAIM_TOKEN}`);
    await expect(page.getByRole('heading', { name: 'What should we call your server?' })).toBeVisible();
    // The code is read from the fragment and scrubbed from the address bar.
    await expect(page).not.toHaveURL(/claim=/);

    await page.getByTestId('fr-server-name').fill('Friday Night Crew');
    await page.getByRole('radio', { name: 'Green' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.locator('[data-step="account"]')).toHaveAttribute('data-state', 'on');
    await page.getByTestId('fr-display-name').fill('Sam');
    await expect(page.getByTestId('fr-username')).toHaveValue('sam');
    // A common password is refused before anything is sent.
    await page.getByTestId('fr-password').fill('password1234');
    await expect(page.getByTestId('fr-password-help')).toHaveText('That one is too easy to guess.');
    await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await page.getByTestId('fr-password').fill('paper lantern orbit');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('heading', { name: 'Setting up your server' })).toBeVisible();
    await expect(page.getByTestId('fr-setup-continue')).toBeEnabled({ timeout: 60_000 });
    const rows = page.getByTestId('fr-setup-rows');
    await expect(rows.locator('[data-row="3"]')).toHaveAttribute('data-state', 'ok');
    // Encrypted with a key file beside the data, and the key escrowed under the new owner's phrase.
    await expect(rows.locator('[data-row="2"]')).toHaveAttribute('data-state', 'ok');
    await expect(rows.locator('[data-row="2"]')).toContainText('Encrypted on disk, with the key stored on the same disk.');
    expect(server.escrowFile && existsSync(server.escrowFile)).toBe(true);
    const escrow = JSON.parse(readFileSync(server.escrowFile!, 'utf8')) as { version: number; instance_id: string; owner_public_key: string };
    expect(escrow.version).toBe(1);
    expect(escrow.owner_public_key).toMatch(/^[0-9a-f]{64}$/);

    await page.getByTestId('fr-setup-continue').click();

    await expect(page.getByRole('heading', { name: 'Save your recovery phrase' })).toBeVisible();
    await page.getByTestId('fr-show-words').click();
    await expect(page.locator('.fr-words li')).toHaveCount(24);
    // The escrow on disk is this phrase's: its owner key is the phrase's public key, and the key
    // derived from the phrase (spec §4.7) opens it to the server's own storage key.
    const words = await page.locator('.fr-words li').allInnerTexts();
    const privateKey = phraseToKey(words);
    const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), privateKey]);
    const publicKey = createPublicKey(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' }).subarray(-32);
    const sealed = JSON.parse(readFileSync(server.escrowFile!, 'utf8')) as { instance_id: string; owner_public_key: string; iv: string; ciphertext: string };
    expect(sealed.owner_public_key).toBe(publicKey.toString('hex'));
    const escrowKey = Buffer.from(hkdfSync('sha256', privateKey, 'paracord/host-storage-escrow/v1', sealed.instance_id, 32));
    const box = Buffer.from(sealed.ciphertext, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', escrowKey, Buffer.from(sealed.iv, 'base64url'));
    decipher.setAAD(Buffer.from(`paracord/host-storage-escrow/v1|${sealed.instance_id}`));
    decipher.setAuthTag(box.subarray(-16));
    const storageKey = Buffer.concat([decipher.update(box.subarray(0, -16)), decipher.final()]);
    const keyFile = readFileSync(join(server.escrowFile!, '..', 'at-rest.key'), 'utf8').trim().replace(/^hex:/, '');
    expect(storageKey.toString('hex')).toBe(keyFile);
    await page.getByTestId('fr-phrase-saved').check();
    await page.getByTestId('fr-phrase-continue').click();

    await expect(page.getByRole('heading', { name: 'Invite your friends' })).toBeVisible();
    await expect(page.getByTestId('fr-invite-link')).toContainText(/\/invite\/[A-Za-z0-9]+/, { timeout: 15_000 });
    // A server bound to loopback is reachable only here, and the screen says so.
    await expect(page.getByTestId('fr-only-here-note')).toBeVisible();

    await page.getByTestId('fr-open-server').click();
    await expect(page).toHaveURL(/\/app\/guilds\/\d+\/channels\/\d+/, { timeout: 20_000 });
    await expect(page.locator('.ix-frame')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Friday Night Crew').first()).toBeVisible();
    expect(errors).toEqual([]);

    // The claim is single use: the page cannot be used again.
    const again = await (await fetch(`${server.base}/api/v1/setup/status`)).json();
    expect(again.setup_required).toBe(false);
    await context.close();
  });
});

/** The recovery phrase → the identity private key (24 BIP39 words; the client's lib/credential/phrase.ts). */
function phraseToKey(words: string[]): Buffer {
  const list = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'crates', 'paracord-server', 'data', 'bip39-english.txt'), 'utf8').trim().split('\n');
  let bits = '';
  for (const word of words) {
    const index = list.indexOf(word.trim() === 'artifact' ? 'artefact' : word.trim());
    if (index < 0) throw new Error(`not a phrase word: ${word}`);
    bits += index.toString(2).padStart(11, '0');
  }
  const bytes = Buffer.from(Array.from({ length: 33 }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2)));
  const key = bytes.subarray(0, 32);
  expect(createHash('sha256').update(key).digest()[0]).toBe(bytes[32]);
  return key;
}
