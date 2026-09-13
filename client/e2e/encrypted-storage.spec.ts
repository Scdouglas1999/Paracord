import { expect, test, type Page } from '@playwright/test';
import type { AccountVault } from '../src/lib/crypto/accountVault';

declare global {
  interface Window { vaultModule: { AccountVault: typeof AccountVault } }
}

async function openPage(page: Page) {
  await page.route('**/__encrypted_storage_test__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Encrypted storage test</title>' }));
  await page.goto('/__encrypted_storage_test__');
  await page.evaluate(async () => {
    const source = '/src/lib/crypto/accountVault.ts';
    window.vaultModule = await import(source);
  });
}

test('encrypted account records survive reload and isolate server, account and namespace', async ({ page }) => {
  await openPage(page);
  const stored = await page.evaluate(async () => {
    const scope = { serverId: 'server-a', userId: 'account-a' };
    const controller = new AbortController();
    const vault = await window.vaultModule.AccountVault.open(scope, new Uint8Array(32).fill(7), { signal: controller.signal, assertCurrent() {} });
    await vault.transact(async tx => {
      tx.put('outbox', 'same', { content: 'Private message content', filename: 'private-photo.png' });
      tx.put('ratchet', 'same', { counter: 4 });
    });
    vault.close();
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('paracord-encrypted-accounts', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const records = await new Promise<Array<{ address: string[]; ciphertext: ArrayBuffer }>>(resolve => { const r = db.transaction('records').objectStore('records').getAll(); r.onsuccess = () => resolve(r.result); });
    db.close();
    return records.map(record => ({ ...record, ciphertext: new TextDecoder().decode(record.ciphertext) }));
  });
  expect(stored).toHaveLength(3);
  expect(JSON.stringify(stored)).not.toContain('Private message content');
  expect(JSON.stringify(stored)).not.toContain('private-photo.png');
  await openPage(page);
  const result = await page.evaluate(async () => {
    const controller = new AbortController();
    const lifetime = { signal: controller.signal, assertCurrent() {} };
    const key = new Uint8Array(32).fill(7);
    const original = await window.vaultModule.AccountVault.open({ serverId: 'server-a', userId: 'account-a' }, key, lifetime);
    const otherAccount = await window.vaultModule.AccountVault.open({ serverId: 'server-a', userId: 'account-b' }, key, lifetime);
    const otherServer = await window.vaultModule.AccountVault.open({ serverId: 'server-b', userId: 'account-a' }, key, lifetime);
    const results = await Promise.all([
      original.transact(tx => tx.list('outbox')),
      original.transact(tx => tx.get('ratchet', 'same')),
      otherAccount.transact(tx => tx.list('outbox')),
      otherServer.transact(tx => tx.get('outbox', 'same')),
    ]);
    original.close(); otherAccount.close(); otherServer.close();
    return results;
  });
  expect(result).toEqual([[{ id: 'same', value: { content: 'Private message content', filename: 'private-photo.png' } }], { counter: 4 }, [], null]);
});

test('cross-tab ratchet and request updates serialize without lost state', async ({ page, context }) => {
  await openPage(page);
  const other = await context.newPage();
  await openPage(other);
  const increment = async (target: Page) => target.evaluate(async () => {
    const controller = new AbortController();
    const vault = await window.vaultModule.AccountVault.open({ serverId: 'a', userId: 'u' }, new Uint8Array(32).fill(8), { signal: controller.signal, assertCurrent() {} });
    await Promise.all(Array.from({ length: 15 }, () => vault.transact(async tx => {
      const count = await tx.get<number>('ratchet', 'counter') ?? 0;
      await new Promise(resolve => setTimeout(resolve, 1));
      tx.put('ratchet', 'counter', count + 1);
      tx.put('outbox', String(count + 1), { serializedRequest: `ciphertext-${count + 1}`, nonce: `original-${count + 1}` });
    })));
    vault.close();
  });
  await Promise.all([increment(page), increment(other)]);
  const result = await page.evaluate(async () => {
    const controller = new AbortController();
    const vault = await window.vaultModule.AccountVault.open({ serverId: 'a', userId: 'u' }, new Uint8Array(32).fill(8), { signal: controller.signal, assertCurrent() {} });
    const value = await vault.transact(async tx => ({ count: await tx.get('ratchet', 'counter'), outbox: await tx.list('outbox') }));
    vault.close(); return value;
  });
  expect(result.count).toBe(30);
  expect(result.outbox).toHaveLength(30);
  expect(new Set(result.outbox.map(record => record.id)).size).toBe(30);
});

test('failed multi-record commit rolls back ratchet and outbox together', async ({ page }) => {
  await openPage(page);
  const result = await page.evaluate(async () => {
    const controller = new AbortController();
    const vault = await window.vaultModule.AccountVault.open({ serverId: 'a', userId: 'u' }, new Uint8Array(32).fill(9), { signal: controller.signal, assertCurrent() {} });
    const put = IDBObjectStore.prototype.put;
    let writes = 0;
    IDBObjectStore.prototype.put = function (...args) {
      if (++writes === 2) throw new DOMException('Storage quota exhausted', 'QuotaExceededError');
      return put.apply(this, args);
    };
    let error = '';
    try {
      await vault.transact(async tx => { tx.put('ratchet', 'state', { next: 1 }); tx.put('outbox', 'request', { body: 'ciphertext' }); });
    } catch (caught) { error = String(caught); }
    finally { IDBObjectStore.prototype.put = put; }
    const saved = await vault.transact(async tx => [await tx.list('ratchet'), await tx.list('outbox')]);
    vault.close(); return { error, saved };
  });
  expect(result.error).toContain('Storage quota exhausted');
  expect(result.saved).toEqual([[], []]);
});

test('logout cancels queued and staged transactions without persisting plaintext', async ({ page }) => {
  await openPage(page);
  const result = await page.evaluate(async () => {
    const controller = new AbortController();
    const scope = { serverId: 'a', userId: 'u' };
    const key = new Uint8Array(32).fill(10);
    const vault = await window.vaultModule.AccountVault.open(scope, key, { signal: controller.signal, assertCurrent() {} });
    let queuedRan = false;
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const first = vault.transact(async tx => { tx.put('outbox', 'pending', { plaintext: 'unsaved' }); started(); await hold; });
    await entered;
    const second = vault.transact(async () => { queuedRan = true; });
    const finished = Promise.allSettled([first, second]);
    controller.abort(); release();
    const statuses = (await finished).map(value => value.status);
    const next = new AbortController();
    const reopened = await window.vaultModule.AccountVault.open(scope, key, { signal: next.signal, assertCurrent() {} });
    const saved = await reopened.transact(tx => tx.list('outbox'));
    reopened.close(); return { statuses, queuedRan, saved };
  });
  expect(result).toEqual({ statuses: ['rejected', 'rejected'], queuedRan: false, saved: [] });
});

test('wrong identity keys and copied ciphertext fail authentication without replacing records', async ({ page }) => {
  await openPage(page);
  const result = await page.evaluate(async () => {
    const controller = new AbortController();
    const lifetime = { signal: controller.signal, assertCurrent() {} };
    const scope = { serverId: 'a', userId: 'u' };
    const vault = await window.vaultModule.AccountVault.open(scope, new Uint8Array(32).fill(11), lifetime);
    await vault.transact(async tx => { tx.put('outbox', 'source', { text: 'Secret' }); });
    let keyRejected = false;
    try { await window.vaultModule.AccountVault.open(scope, new Uint8Array(32).fill(12), lifetime); } catch { keyRejected = true; }
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open('paracord-encrypted-accounts', 1); r.onsuccess = () => resolve(r.result); });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite');
      const store = tx.objectStore('records');
      const r = store.get(['a', 'u', 'outbox', 'source']);
      r.onsuccess = () => store.put({ ...r.result, address: ['a', 'u', 'outbox', 'copy'] });
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    });
    db.close();
    let copyRejected = false;
    try { await vault.transact(tx => tx.get('outbox', 'copy')); } catch { copyRejected = true; }
    const original = await vault.transact(tx => tx.get('outbox', 'source'));
    vault.close(); return { keyRejected, copyRejected, original };
  });
  expect(result).toEqual({ keyRejected: true, copyRejected: true, original: { text: 'Secret' } });
});
