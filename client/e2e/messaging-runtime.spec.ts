import { expect, test, type Page } from '@playwright/test';
import type { initializeMessagingRuntime } from './fixtures/messagingRuntime';

declare global { interface Window { messaging: Awaited<ReturnType<typeof initializeMessagingRuntime>> } }
const firstEpoch = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const secondEpoch = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
async function open(page: Page, epoch: string | null = firstEpoch, lifecycle = false, userId = 'alice') {
  await page.route('**/__messaging_runtime_test__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Messaging runtime test</title>' }));
  await page.goto('/__messaging_runtime_test__');
  await page.evaluate(async ({ epoch, lifecycle, userId }) => {
    const path = '/e2e/fixtures/messagingRuntime.ts';
    const module = await import(path);
    window.messaging = await module.initializeMessagingRuntime(epoch, lifecycle, userId);
  }, { epoch, lifecycle, userId });
}
/** The authenticated recovery fence every send waits for, with no retained history. */
async function recovery(page: Page) {
  await page.route('**/api/v1/channels/*/messages/recovery**', async route => {
    const url = new URL(route.request().url());
    const after = url.searchParams.get('after') ?? '0';
    await route.fulfill({ status: 200, headers: { 'X-Paracord-History-Epoch': route.request().headers()['x-paracord-history-epoch'] }, json: {
      database_history_epoch: route.request().headers()['x-paracord-history-epoch'], channel_id: url.pathname.split('/')[4],
      after, through: after, floor: '0', next: after, complete: true, projection_head: after, changes: [], states: [],
    } });
  });
}
async function ciphertext(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('paracord-device-encrypted-accounts'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const rows = await new Promise<unknown[]>(resolve => { const r = db.transaction('records').objectStore('records').getAll(); r.onsuccess = () => resolve(r.result.map((row: { ciphertext: ArrayBuffer }) => ({ ...row, ciphertext: new TextDecoder().decode(row.ciphertext) }))); });
    db.close(); return JSON.stringify(rows);
  });
}

test('ordinary server drafts persist encrypted across reload without Signal enrollment', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.messaging.runtime.writeDraft('2001', { revision: 'draft-a', content: 'Private ordinary draft' }));
  expect(await ciphertext(page)).not.toContain('Private ordinary draft');
  const key = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open('paracord-account-device-keys'); r.onsuccess = () => resolve(r.result); });
    const values = await new Promise<CryptoKey[]>(resolve => { const r = db.transaction('keys').objectStore('keys').getAll(); r.onsuccess = () => resolve(r.result); });
    db.close(); return values.map(value => ({ extractable: value.extractable, type: value.type, algorithm: value.algorithm.name }));
  });
  expect(key).toEqual([{ extractable: false, type: 'secret', algorithm: 'AES-GCM' }]);
  await open(page);
  expect(await page.evaluate(() => window.messaging.runtime.readDraft('2001'))).toEqual({ revision: 'draft-a', content: 'Private ordinary draft' });
  await open(page, firstEpoch, false, 'bob');
  expect(await page.evaluate(() => window.messaging.runtime.readDraft('2001'))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('paracord:account-draft:2001'))).toBeNull();
});

test('missing device key rejects storage without replacing existing ciphertext', async ({ page }) => {
  await open(page);
  await page.evaluate(async () => {
    await window.messaging.runtime.writeDraft('2001', { revision: 'draft', content: 'Recover with original device key' });
    window.messaging.close();
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open('paracord-account-device-keys'); r.onsuccess = () => resolve(r.result); });
    await new Promise<void>(resolve => { const tx = db.transaction('keys', 'readwrite'); tx.objectStore('keys').clear(); tx.oncomplete = () => resolve(); }); db.close();
  });
  const before = await ciphertext(page);
  const error = await page.evaluate(async () => { try { await window.messaging.open(); return ''; } catch (error) { return String(error); } });
  expect(error).toContain('encryption key is missing'); expect(await ciphertext(page)).toBe(before);
});

test('original pre-handshake account lease adopts drafts but a reload requires review', async ({ page }) => {
  await open(page, null, true);
  await page.evaluate(() => window.messaging.runtime.writeDraft('2001', { revision: 'before', content: 'Before authenticated handshake' }));
  expect(await page.evaluate(() => window.messaging.runtime.store.getState().storage)).toBe('awaiting-handshake');
  await page.evaluate(epoch => window.messaging.history(epoch), firstEpoch);
  await expect.poll(() => page.evaluate(() => window.messaging.runtime.store.getState().storage)).toBe('ready');
  expect(await page.evaluate(() => window.messaging.runtime.readDraft('2001'))).toEqual({ revision: 'before', content: 'Before authenticated handshake' });
  await open(page, null, false, 'bob');
  await page.evaluate(() => window.messaging.runtime.writeDraft('2001', { revision: 'unknown', content: 'Unknown after reload' }));
  await open(page, firstEpoch, false, 'bob');
  expect(await page.evaluate(() => window.messaging.runtime.store.getState().storage)).toBe('review');
});

test('changed history holds queued HTTP and explicitly preserves old drafts before fresh sends', async ({ page }) => {
  const requests: string[] = [];
  await page.route('**/api/v1/channels/2001/messages', async route => {
    requests.push(route.request().postData() ?? '');
    await route.fulfill({ status: 403, contentType: 'application/json', headers: { 'X-Paracord-History-Epoch': requests.length === 1 ? firstEpoch : secondEpoch }, body: JSON.stringify({ message: 'Permission denied' }) });
  });
  await recovery(page);
  await open(page);
  await page.evaluate(() => window.messaging.handshake());
  await page.evaluate(() => window.messaging.runtime.send('2001', 'Old queued text'));
  await expect.poll(() => requests.length).toBe(1);
  await expect.poll(() => page.evaluate(() => window.messaging.runtime.store.getState().queue[0]?.record.status)).toBe('failed');
  await page.evaluate(epoch => window.messaging.history(epoch), secondEpoch);
  await page.evaluate(() => window.messaging.runtime.startLocal());
  expect(await page.evaluate(() => window.messaging.runtime.store.getState().storage)).toBe('review');
  expect(requests).toHaveLength(1);
  await page.evaluate(() => window.messaging.runtime.preservePreviousHistoryForReview());
  expect(await page.evaluate(() => window.messaging.runtime.store.getState().recovery.map(row => row.content))).toContain('Old queued text');
  expect(await page.evaluate(() => window.messaging.runtime.store.getState().queue)).toEqual([]);
  await page.evaluate(() => window.messaging.runtime.send('2001', 'Fresh current history text'));
  await expect.poll(() => requests.length).toBe(2);
  expect(JSON.parse(requests[1]).content).toBe('Fresh current history text');
  expect(JSON.parse(requests[1]).nonce).not.toBe(JSON.parse(requests[0]).nonce);
});

test('identity handoff retry after acceptance/clear crash retains nonce and newer draft', async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const local = await window.messaging.open();
    const identity = await window.messaging.AccountVault.open(local.vault.scope, new Uint8Array(32).fill(51), local);
    const original = { revision: 'submitted', content: 'Accepted exactly once' };
    await local.vault.transact(async tx => tx.put('messages.drafts', '2001', original));
    const transact = local.vault.transact.bind(local.vault); let calls = 0;
    local.vault.transact = async run => { if (++calls === 2) throw new Error('Simulated crash before clearing draft'); return transact(run); };
    let failure = '';
    try { await window.messaging.acceptEncryptedDraft(local.vault, identity, 'identity', '2001', original, { encryption: { kind: 'plain' } }); } catch (error) { failure = String(error); }
    local.vault.transact = transact;
    const before = await identity.transact(tx => tx.list<{ nonce: string }>('messages.intents'));
    await local.vault.transact(async tx => tx.put('messages.drafts', '2001', { revision: 'newer', content: 'Typed during send' }));
    const accepted = await window.messaging.acceptEncryptedDraft(local.vault, identity, 'identity', '2001', original, { encryption: { kind: 'plain' } });
    const after = await identity.transact(tx => tx.list('messages.intents'));
    const draft = await local.vault.transact(tx => tx.get('messages.drafts', '2001'));
    identity.close(); local.dispose(); return { failure, accepted, before, after, draft };
  });
  expect(result.failure).toContain('Simulated crash');
  expect(result.before).toHaveLength(1); expect(result.after).toHaveLength(1);
  expect(result.accepted.nonce).toBe(result.before[0].value.nonce);
  expect(result.draft).toEqual({ revision: 'newer', content: 'Typed during send' });
});

test('logout cancels a staged device write and clears runtime projections', async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const session = await window.messaging.open();
    let release!: () => void; let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const saved = session.vault.transact(async tx => { tx.put('messages.drafts', '2001', { content: 'Canceled secret' }); enter(); await gate; });
    const status = saved.then(() => 'saved', () => 'cancelled');
    await entered; window.messaging.logout(); release();
    return { status: await status, state: window.messaging.runtime.store.getState() };
  });
  expect(result.status).toBe('cancelled'); expect(result.state.queue).toEqual([]);
  await open(page);
  expect(await page.evaluate(() => window.messaging.runtime.readDraft('2001'))).toBeNull();
});

test('an authenticated delete masks a late create receipt and remains masked after reload', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let attempted = false;
  await page.route('**/api/v1/channels/2001/messages', async route => {
    const body = route.request().postDataJSON(); attempted = true; await gate;
    await route.fulfill({ status: 201, contentType: 'application/json', headers: { 'X-Paracord-History-Epoch': firstEpoch },
      body: JSON.stringify({ id: '100', channel_id: '2001', author: { id: 'alice' }, nonce: body.nonce, content: body.content }) });
  });
  await recovery(page);
  await open(page);
  await page.evaluate(() => {
    Object.assign(window, { receiptEvents: [] });
    window.messaging.runtime.subscribeMessages(event => (window as unknown as { receiptEvents: unknown[] }).receiptEvents.push(event));
  });
  await page.evaluate(() => window.messaging.handshake());
  await page.evaluate(() => window.messaging.runtime.send('2001', 'Already deleted'));
  await expect.poll(() => attempted).toBe(true);
  await page.evaluate(() => window.messaging.runtime.observeDeleted('2001', '100'));
  release(); await expect.poll(() => page.evaluate(() => window.messaging.runtime.store.getState().queue.length)).toBe(0);
  // Authoritative recovery snapshots are ordinary handshake output; the late
  // creation receipt must never appear, and the deletion must.
  expect(await page.evaluate(() => (window as unknown as { receiptEvents: Array<{ kind: string }> }).receiptEvents.filter(event => event.kind !== 'authoritative')))
    .toEqual([{ kind: 'delete', channelId: '2001', messageId: '100' }]);
  await open(page);
  const after = await page.evaluate(async () => {
    const events: unknown[] = []; window.messaging.runtime.subscribeMessages(event => events.push(event));
    await window.messaging.runtime.refresh(); return events;
  });
  expect(after).toEqual([]);
});

test('history review preserves an open composer’s unsaved text without accepting it in the new history', async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async epoch => {
    const controller = window.messaging.runtime.draftController('2001'); await controller.capture();
    controller.setContent('Old composer text'); await controller.capture();
    window.messaging.history(epoch); await window.messaging.runtime.startLocal();
    controller.setContent('Still visible while reviewing');
    let failure = ''; try { await controller.capture(); } catch (error) { failure = String(error); }
    const visible = controller.store.getState().draft.content;
    await window.messaging.runtime.preservePreviousHistoryForReview();
    const next = window.messaging.runtime.draftController('2001'); await next.capture();
    return { failure, visible, fresh: next.store.getState().draft.content, recovery: window.messaging.runtime.store.getState().recovery.map(row => row.content) };
  }, secondEpoch);
  expect(result.failure).toContain('history changed'); expect(result.visible).toBe('Still visible while reviewing');
  expect(result.fresh).toBe(''); expect(result.recovery).toContain('Still visible while reviewing');
});

test('verified enrollment uses committed account keys while identity lock leaves ordinary encrypted drafts available', async ({ page }) => {
  let publicKey = ''; const publications: Array<Record<string, unknown>> = [];
  await page.route('**/api/v1/users/@me/keys', async route => {
    const previous = publications.at(-1);
    if (route.request().method() === 'GET') return route.fulfill({ status: 200, headers: { 'X-Paracord-History-Epoch': firstEpoch }, json: {
      identity_key: publicKey, signed_prekey: previous?.signed_prekey ?? null,
      last_resort_prekey: previous?.last_resort_prekey ?? null, one_time_prekeys: previous?.one_time_prekeys ?? [],
    } });
    const body = route.request().postDataJSON(); publications.push(body);
    return route.fulfill({ status: 200, headers: { 'X-Paracord-History-Epoch': firstEpoch }, json: {
      request_id: body.request_id, signed_prekey_id: body.signed_prekey?.id ?? null,
      last_resort_prekey_id: body.last_resort_prekey?.id ?? null,
      one_time_prekeys_stored: body.one_time_prekeys?.length ?? 0, one_time_prekeys_total: body.one_time_prekeys?.length ?? 0,
    } });
  });
  await open(page);
  publicKey = await page.evaluate(() => window.messaging.unlockIdentity());
  await page.evaluate(() => window.messaging.runtime.enroll());
  expect(publications).toHaveLength(1);
  expect(publications[0].expected_identity_key).toBe(publicKey);
  expect(await page.evaluate(() => window.messaging.runtime.store.getState().encryption)).toBe('ready');
  await page.evaluate(() => window.messaging.lockIdentity());
  expect(await page.evaluate(() => window.messaging.runtime.store.getState().encryption)).toBe('locked');
  await page.evaluate(() => window.messaging.runtime.writeDraft('2001', { revision: 'ordinary', content: 'Still available with identity locked' }));
  expect(await page.evaluate(() => window.messaging.runtime.readDraft('2001'))).toEqual({ revision: 'ordinary', content: 'Still available with identity locked' });
  await page.evaluate(() => window.messaging.unlockIdentity()); await page.evaluate(() => window.messaging.runtime.enroll());
  expect(await page.evaluate(() => window.messaging.runtime.store.getState().encryption)).toBe('ready');
  expect(publications).toHaveLength(1);
});

test('a verification decision survives a reload in the browser build, and a locked vault says unknown', async ({ page }) => {
  const PEER = 'b'.repeat(64);
  let publicKey = ''; const publications: Array<Record<string, unknown>> = [];
  const keys = async (route: import('@playwright/test').Route) => {
    const previous = publications.at(-1);
    if (route.request().method() === 'GET') return route.fulfill({ status: 200, headers: { 'X-Paracord-History-Epoch': firstEpoch }, json: {
      identity_key: publicKey, signed_prekey: previous?.signed_prekey ?? null,
      last_resort_prekey: previous?.last_resort_prekey ?? null, one_time_prekeys: previous?.one_time_prekeys ?? [],
    } });
    const body = route.request().postDataJSON(); publications.push(body);
    return route.fulfill({ status: 200, headers: { 'X-Paracord-History-Epoch': firstEpoch }, json: {
      request_id: body.request_id, signed_prekey_id: body.signed_prekey?.id ?? null,
      last_resort_prekey_id: body.last_resort_prekey?.id ?? null,
      one_time_prekeys_stored: body.one_time_prekeys?.length ?? 0, one_time_prekeys_total: body.one_time_prekeys?.length ?? 0,
    } });
  };
  await page.route('**/api/v1/users/@me/keys', keys);

  await open(page);
  publicKey = await page.evaluate(() => window.messaging.unlockIdentity());
  await page.evaluate(() => window.messaging.runtime.enroll());
  expect(await page.evaluate(peer => window.messaging.trustState('peer-1', peer), PEER)).toBe('unverified');
  await page.evaluate(peer => window.messaging.markVerified('peer-1', peer), PEER);
  expect(await page.evaluate(peer => window.messaging.trustState('peer-1', peer), PEER)).toBe('verified');

  // Nothing about the decision is left in plaintext for the page to lose.
  const plaintext = await page.evaluate(() => JSON.stringify(localStorage));
  expect(plaintext).not.toContain('b'.repeat(64));
  expect(plaintext).not.toContain('verified');

  // Reload: every in-process store is gone. Before the vault is open the
  // honest answer is "unknown", not "not verified".
  await open(page);
  expect(await page.evaluate(peer => window.messaging.trustState('peer-1', peer), PEER)).toBe('unknown');
  await page.evaluate(() => window.messaging.unlockIdentity());
  await page.evaluate(() => window.messaging.runtime.enroll());
  expect(await page.evaluate(peer => window.messaging.trustState('peer-1', peer), PEER)).toBe('verified');

  // Locking the identity closes the vault: unknown again, never unverified.
  await page.evaluate(() => window.messaging.lockIdentity());
  expect(await page.evaluate(peer => window.messaging.trustState('peer-1', peer), PEER)).toBe('unknown');
});
