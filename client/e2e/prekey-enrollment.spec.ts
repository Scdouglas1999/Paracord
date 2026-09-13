import { expect, test, type Page, type BrowserContext } from '@playwright/test';
import type { initializePrekeyFixture } from './fixtures/prekeyEnrollment';
import type { OwnPublicKeysResponse, UploadKeysRequest, UploadKeysResponse } from '../src/api/keys';

declare global { interface Window { prekeyTest: Awaited<ReturnType<typeof initializePrekeyFixture>>; } }
async function setup(page: Page) {
  await page.route('**/__prekey_test__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Encrypted key enrollment</title>' }));
  await page.goto('/__prekey_test__');
  await page.evaluate(async () => {
    const path = '/e2e/fixtures/prekeyEnrollment.ts';
    const { initializePrekeyFixture } = await import(path);
    window.prekeyTest = await initializePrekeyFixture();
  });
  return page.evaluate(() => window.prekeyTest.identity);
}
async function service(context: BrowserContext, identity: string) {
  const state = {
    keys: { identity_key: identity, signed_prekey: null, one_time_prekeys: [], last_resort_prekey: null } as OwnPublicKeysResponse,
    requests: [] as string[], loseResponse: false,
    receipts: new Map<string, UploadKeysResponse>(),
  };
  await context.route('**/api/v1/users/@me/keys', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: state.keys });
    const raw = route.request().postData()!;
    state.requests.push(raw);
    const body = JSON.parse(raw) as UploadKeysRequest;
    let receipt = state.receipts.get(body.request_id!);
    if (!receipt) {
      if (body.signed_prekey) state.keys.signed_prekey = body.signed_prekey;
      if (body.last_resort_prekey) state.keys.last_resort_prekey = body.last_resort_prekey;
      state.keys.one_time_prekeys.push(...(body.one_time_prekeys ?? []));
      receipt = { request_id: body.request_id!, signed_prekey_id: body.signed_prekey?.id ?? null,
        last_resort_prekey_id: body.last_resort_prekey?.id ?? null,
        one_time_prekeys_stored: body.one_time_prekeys?.length ?? 0, one_time_prekeys_total: state.keys.one_time_prekeys.length };
      state.receipts.set(body.request_id!, receipt);
    }
    if (state.loseResponse) { state.loseResponse = false; return route.abort('connectionreset'); }
    await route.fulfill({ json: receipt });
  });
  return state;
}

test('a lost publication response replays exact bytes after reload without republishing consumed keys', async ({ page, context }) => {
  const server = await service(context, await setup(page));
  server.loseResponse = true;
  const error = await page.evaluate(() => window.prekeyTest.driver.ensure().then(() => '', error => String(error)));
  expect(error).toContain('Network Error');
  const before = await page.evaluate(() => window.prekeyTest.inspect());
  expect(before.keys!.oneTimePrekeys).toHaveLength(50);
  expect(before.pending).toHaveLength(1);
  server.keys.one_time_prekeys.shift();
  await setup(page);
  await page.evaluate(() => window.prekeyTest.driver.ensure());
  const after = await page.evaluate(() => window.prekeyTest.inspect());
  expect(after.pending).toEqual([]);
  expect(after.keys).toEqual(before.keys);
  expect(server.requests).toHaveLength(2);
  expect(server.requests[1]).toBe(server.requests[0]);
  expect(server.keys.one_time_prekeys).toHaveLength(49);
});

test('failed encrypted persistence publishes no keys and rolls back both private material and upload', async ({ page, context }) => {
  const server = await service(context, await setup(page));
  const result = await page.evaluate(async () => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      if (value?.address?.[2] === 'signal.publications') throw new DOMException('Key storage quota exhausted', 'QuotaExceededError');
      return put.call(this, value, key);
    };
    let error = '';
    try { await window.prekeyTest.driver.ensure(); } catch (failure) { error = String(failure); }
    finally { IDBObjectStore.prototype.put = put; }
    return { error, state: await window.prekeyTest.inspect() };
  });
  expect(result.error).toContain('Key storage quota exhausted');
  expect(result.state).toEqual({ keys: null, pending: [] });
  expect(server.requests).toEqual([]);
  await page.evaluate(() => window.prekeyTest.driver.ensure());
  expect(server.requests).toHaveLength(1);
});

test('matching legacy private keys migrate only after verifying the published account signature', async ({ page, context }) => {
  const server = await service(context, await setup(page));
  server.keys = await page.evaluate(() => window.prekeyTest.seedLegacy());
  const original = await page.evaluate(() => localStorage.getItem('paracord:signal:prekeys'));
  await page.evaluate(() => window.prekeyTest.driver.ensure());
  const state = await page.evaluate(() => window.prekeyTest.inspect());
  expect(state.keys!.signedPrekey.id).toBe(server.keys.signed_prekey!.id);
  expect(state.keys!.oneTimePrekeys).toHaveLength(50);
  expect(state.pending).toEqual([]);
  expect(server.requests).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('paracord:signal:prekeys'))).toBe(original);
});

test('unverifiable legacy ownership preserves the original data and requires explicit initialization', async ({ page, context }) => {
  const server = await service(context, await setup(page));
  await page.evaluate(() => window.prekeyTest.seedLegacy());
  const original = await page.evaluate(() => localStorage.getItem('paracord:signal:prekeys'));
  const error = await page.evaluate(() => window.prekeyTest.driver.ensure().then(() => '', error => error.code));
  expect(error).toBe('UNOWNED_LEGACY_KEYS');
  expect(await page.evaluate(() => window.prekeyTest.inspect())).toEqual({ keys: null, pending: [] });
  expect(server.requests).toEqual([]);
  await page.evaluate(() => window.prekeyTest.driver.ensure({ initializeWithUnownedLegacy: true }));
  expect(server.requests).toHaveLength(1);
  expect(await page.evaluate(() => localStorage.getItem('paracord:signal:prekeys'))).toBe(original);
});

test('two tabs share one enrollment and retain every generated private key', async ({ page, context }) => {
  const server = await service(context, await setup(page));
  const second = await context.newPage(); await setup(second);
  await Promise.all([page.evaluate(() => window.prekeyTest.driver.ensure()), second.evaluate(() => window.prekeyTest.driver.ensure())]);
  expect(server.requests).toHaveLength(1);
  expect(await second.evaluate(() => window.prekeyTest.inspect())).toEqual(await page.evaluate(() => window.prekeyTest.inspect()));
  await second.close();
});

test('locking during publication cancels HTTP without deleting the saved keys or request', async ({ page, context }) => {
  await service(context, await setup(page));
  let reached!: () => void;
  const requested = new Promise<void>(resolve => { reached = resolve; });
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/users/@me/keys', async route => {
    if (route.request().method() === 'GET') return route.fallback();
    reached(); await released; await route.abort('aborted');
  });
  const result = page.evaluate(() => window.prekeyTest.driver.ensure().then(() => '', error => String(error)));
  await requested;
  await page.evaluate(() => window.prekeyTest.lock());
  expect(await result).not.toBe('');
  release();
  await setup(page);
  const retained = await page.evaluate(() => window.prekeyTest.inspect());
  expect(retained.keys!.oneTimePrekeys).toHaveLength(50);
  expect(retained.pending).toHaveLength(1);
});

test('failed acknowledgement persistence retains a replayable publication after the server commits', async ({ page, context }) => {
  const server = await service(context, await setup(page));
  const result = await page.evaluate(async () => {
    const remove = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function(key) {
      if (Array.isArray(key) && key[2] === 'signal.publications') throw new DOMException('Acknowledgement quota exhausted', 'QuotaExceededError');
      return remove.call(this, key);
    };
    let error = '';
    try { await window.prekeyTest.driver.ensure(); } catch (failure) { error = String(failure); }
    finally { IDBObjectStore.prototype.delete = remove; }
    return { error, state: await window.prekeyTest.inspect() };
  });
  expect(result.error).toContain('Acknowledgement quota exhausted');
  expect(result.state.pending).toHaveLength(1);
  expect(result.state.keys!.oneTimePrekeys).toHaveLength(50);
  expect(server.requests).toHaveLength(1);
  await setup(page);
  await page.evaluate(() => window.prekeyTest.driver.ensure());
  expect(server.requests).toHaveLength(2);
  expect(server.requests[1]).toBe(server.requests[0]);
  expect((await page.evaluate(() => window.prekeyTest.inspect())).pending).toEqual([]);
});

test('rotation archives the preceding private signed key before publishing its replacement', async ({ page, context }) => {
  await page.clock.install({ time: new Date() });
  const server = await service(context, await setup(page));
  await page.evaluate(() => window.prekeyTest.driver.ensure());
  const before = await page.evaluate(() => window.prekeyTest.inspect());
  await page.clock.fastForward(8 * 24 * 60 * 60 * 1000);
  await page.evaluate(() => window.prekeyTest.driver.ensure());
  const after = await page.evaluate(() => window.prekeyTest.inspect());
  expect(after.keys!.signedPrekeyArchive).toEqual([before.keys!.signedPrekey]);
  expect(after.keys!.signedPrekey.id).not.toBe(before.keys!.signedPrekey.id);
  expect(after.keys!.oneTimePrekeys).toEqual(before.keys!.oneTimePrekeys);
  expect(after.pending).toEqual([]);
  expect(server.requests).toHaveLength(2);
  expect(server.keys.signed_prekey!.id).toBe(after.keys!.signedPrekey.id);
});

test('inventory HTTP does not lock the vault or misclassify a concurrently consumed private key', async ({ page, context }) => {
  const server = await service(context, await setup(page));
  await page.evaluate(() => window.prekeyTest.driver.ensure());
  const observed = structuredClone(server.keys);
  let reached!: () => void; const requested = new Promise<void>(resolve => { reached = resolve; });
  let release!: () => void; const released = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  await page.route('**/api/v1/users/@me/keys', async route => {
    if (route.request().method() !== 'GET' || ++reads !== 1) return route.fallback();
    reached(); await released; await route.fulfill({ json: observed });
  });
  const enrollment = page.evaluate(() => window.prekeyTest.driver.ensure());
  await requested;
  // This transaction must finish while the inventory HTTP response is held.
  const consumed = await page.evaluate(() => window.prekeyTest.consumeFirstPrivatePrekey());
  server.keys.one_time_prekeys = server.keys.one_time_prekeys.filter(key => key.id !== consumed);
  release(); await enrollment;
  expect(reads).toBe(2);
  expect((await page.evaluate(() => window.prekeyTest.inspect())).keys!.oneTimePrekeys).toHaveLength(49);
  expect(server.requests).toHaveLength(1);
});
