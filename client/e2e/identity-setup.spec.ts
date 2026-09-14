import { expect, test, type Page } from '@playwright/test';

async function blank(page: Page) {
  await page.route('**/__identity_test__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Identity persistence</title>' }));
  await page.goto('/__identity_test__');
}

test('a browser identity survives reload with only a password-encrypted private key persisted', async ({ page }) => {
  await blank(page);
  const created = await page.evaluate(async () => {
    const path = '/src/lib/account.ts'; const { createAccount, exportKeystore } = await import(path);
    const account = await createAccount('alice', 'encryption password');
    const privateHex = Array.from(account.privateKey as Uint8Array).map(byte => byte.toString(16).padStart(2, '0')).join('');
    const stored = await exportKeystore(); account.privateKey.fill(0);
    return { publicKey: account.publicKey, containsPrivate: stored.includes(privateHex), stored };
  });
  expect(created.containsPrivate).toBe(false);
  await blank(page);
  const restored = await page.evaluate(async () => {
    const path = '/src/lib/account.ts'; const { unlockAccount, exportKeystore } = await import(path);
    let rejected = false;
    try { await unlockAccount('wrong password'); } catch { rejected = true; }
    const account = await unlockAccount('encryption password'); account.privateKey.fill(0);
    return { rejected, publicKey: account.publicKey, stored: await exportKeystore() };
  });
  expect(restored).toEqual({ rejected: true, publicKey: created.publicKey, stored: created.stored });
  const imported = await page.evaluate(async saved => {
    const path = '/src/lib/account.ts';
    const { updateKeystoreProfile, getStoredKeystore, deleteAccount, hasAccount, importKeystore, unlockAccount } = await import(path);
    await updateKeystoreProfile('renamed', 'Alice'); const profile = await getStoredKeystore();
    await deleteAccount(); const deleted = !hasAccount();
    await importKeystore(saved); const account = await unlockAccount('encryption password'); account.privateKey.fill(0);
    return { profile: profile.username, deleted, publicKey: account.publicKey };
  }, created.stored);
  expect(imported).toEqual({ profile: 'renamed', deleted: true, publicKey: created.publicKey });
});

test('concurrent identity creation cannot replace the first committed key', async ({ page, context }) => {
  await blank(page); const other = await context.newPage(); await blank(other);
  const create = (tab: Page, username: string) => tab.evaluate(async username => {
    const path = '/src/lib/account.ts'; const { createAccount } = await import(path);
    try { const account = await createAccount(username, 'encryption password'); account.privateKey.fill(0); return { publicKey: account.publicKey }; }
    catch (error) { return { error: String(error) }; }
  }, username);
  const results = await Promise.all([create(page, 'alice'), create(other, 'bob')]);
  expect(results.filter(result => result.publicKey)).toHaveLength(1);
  expect(results.find(result => result.error)?.error).toContain('already has an identity');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('paracord:encrypted-identity:v1')!).publicKey);
  expect(stored).toBe(results.find(result => result.publicKey)?.publicKey); await other.close();
});

test('failed identity persistence rejects setup without an unlocked account or exists marker', async ({ page }) => {
  await blank(page);
  const result = await page.evaluate(async () => {
    const path = '/src/stores/accountStore.ts'; const { useAccountStore } = await import(path);
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'paracord:encrypted-identity:v1') throw new DOMException('Identity storage full', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
    let error = '';
    try { await useAccountStore.getState().create('alice', 'encryption password'); } catch (failure) { error = String(failure); }
    finally { Storage.prototype.setItem = setItem; }
    const state = useAccountStore.getState();
    return { error, unlocked: state.isUnlocked, exists: state.hasAccount(), key: state.publicKey };
  });
  expect(result).toEqual({ error: 'QuotaExceededError: Identity storage full', unlocked: false, exists: false, key: null });
});

test('legacy encrypted identities migrate nondestructively while missing or corrupt identities fail closed', async ({ page }) => {
  await blank(page);
  const original = await page.evaluate(async () => {
    const path = '/src/lib/account.ts'; const { createAccount, exportKeystore } = await import(path);
    const account = await createAccount('alice', 'encryption password'); account.privateKey.fill(0);
    const saved = await exportKeystore();
    localStorage.setItem('paracord:account', saved); localStorage.setItem('paracord:account:exists', '1');
    localStorage.removeItem('paracord:encrypted-identity:v1'); return saved;
  });
  await blank(page);
  const result = await page.evaluate(async () => {
    const path = '/src/lib/account.ts'; const { unlockAccount, getStoredKeystore } = await import(path);
    const account = await unlockAccount('encryption password'); account.privateKey.fill(0);
    const migrated = localStorage.getItem('paracord:encrypted-identity:v1');
    const legacy = localStorage.getItem('paracord:account');
    localStorage.setItem('paracord:encrypted-identity:v1', '{corrupt');
    let corrupt = false; try { await getStoredKeystore(); } catch { corrupt = true; }
    const retained = localStorage.getItem('paracord:encrypted-identity:v1');
    localStorage.removeItem('paracord:encrypted-identity:v1'); localStorage.removeItem('paracord:account');
    let missing = ''; try { await getStoredKeystore(); } catch (error) { missing = String(error); }
    return { migrated, legacy, corrupt, retained, missing };
  });
  expect(result.migrated).toBe(original); expect(result.legacy).toBe(original);
  expect(result.corrupt).toBe(true); expect(result.retained).toBe('{corrupt'); expect(result.missing).toContain('private keystore is missing');
});

test('the setup form retries rejected server credentials after reload using the same saved identity', async ({ page }) => {
  const attempts: Array<{ public_key: string; password: string; mfa_code?: string }> = [];
  await page.route('**/api/v1/auth/challenge', route => route.fulfill({ status: 200, json: {
    nonce: 'fixture-challenge', timestamp: Math.floor(Date.now() / 1000), server_origin: new URL(page.url()).origin,
  } }));
  await page.route('**/api/v1/auth/attach-public-key', route => {
    const body = route.request().postDataJSON(); attempts.push(body);
    return route.fulfill(body.password === 'correct server password'
      ? { status: 200, json: { token: 'new-token', user: { id: '42', username: 'alice', public_key: body.public_key } } }
      : { status: 401, json: { error: 'Unauthorized' } });
  });
  async function form() {
    await page.goto('/e2e/fixtures/identity-setup.html');
  }
  await form();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const region = page.getByRole('region', { name: 'Account access' });
    await region.hover(); await page.mouse.wheel(0, -2000);
    await expect(page.getByRole('heading', { name: 'Secure your account' })).toBeInViewport();
    await page.screenshot({ path: `../output/improvement-program/identity-setup/setup-${width}.png` });
    await page.mouse.wheel(0, 2000);
    await expect(page.getByRole('button', { name: 'Secure account' })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: `../output/improvement-program/identity-setup/setup-${width}-submit.png` });
    expect(await region.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await region.focus(); await page.keyboard.press('Control+Home');
    await expect(page.getByRole('heading', { name: 'Secure your account' })).toBeInViewport();
  }
  await page.getByLabel('New encryption password', { exact: false }).fill('separate local password');
  await page.getByLabel('Confirm password', { exact: false }).fill('separate local password');
  await page.getByLabel('Current sign-in password', { exact: false }).fill('wrong server password');
  await page.getByLabel('Two-factor or backup code').fill('123456');
  await page.getByRole('button', { name: 'Secure account' }).click();
  await expect(page.getByText('The instance rejected that sign-in.', { exact: false })).toBeVisible();
  const original = await page.evaluate(() => localStorage.getItem('paracord:encrypted-identity:v1'));
  expect(attempts[0]).toMatchObject({ password: 'wrong server password', mfa_code: '123456' });
  await form();
  await page.getByLabel('Encryption password', { exact: false }).fill('separate local password');
  await page.getByLabel('Current sign-in password', { exact: false }).fill('correct server password');
  await page.getByRole('button', { name: 'Secure account' }).click();
  await expect(page.getByRole('heading', { name: 'Recovery phrase' })).toBeVisible();
  expect(attempts[1].public_key).toBe(attempts[0].public_key);
  expect(await page.evaluate(() => localStorage.getItem('paracord:encrypted-identity:v1'))).toBe(original);
  expect(await page.evaluate(async () => {
    const path = '/src/stores/authStore.ts'; return (await import(path)).useAuthStore.getState().token;
  })).toBe('new-token');
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Returned to the conversation')).toBeVisible();
});
