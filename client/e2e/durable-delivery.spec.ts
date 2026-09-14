import { expect, test, type Page } from '@playwright/test';
import type { initializeDeliveryFixture } from './fixtures/durableDelivery';

declare global { interface Window { deliveryTest: Awaited<ReturnType<typeof initializeDeliveryFixture>> } }

async function setup(page: Page, initialize: boolean, allowBundleFetch = initialize) {
  await page.route('**/__delivery_test__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Delivery test</title>' }));
  await page.goto('/__delivery_test__');
  await page.evaluate(async ({ initialize, allowBundleFetch }) => {
    const source = '/e2e/fixtures/durableDelivery.ts';
    window.deliveryTest = await (await import(source)).initializeDeliveryFixture(initialize, allowBundleFetch);
  }, { initialize, allowBundleFetch });
}

function message(body: string, channel = 'dm', id = '100') {
  const request = JSON.parse(body);
  return { id, nonce: request.nonce, channel_id: channel, author: { id: 'alice', username: 'Alice' }, content: '', e2ee: request.e2ee, attachments: [], reactions: [] };
}

async function prepare(page: Page, channel = 'dm', content = 'Private message') {
  return page.evaluate(async ({ channel, content }) => {
    const { aliceDm, bobPeer } = window.deliveryTest;
    return aliceDm.prepare(channel, bobPeer, content);
  }, { channel, content });
}

test('lost response after server commit replays the same ciphertext and nonce after reload', async ({ page }) => {
  const bodies: string[] = [];
  let stored: ReturnType<typeof message> | undefined;
  await page.route('**/api/v1/channels/dm/messages', async route => {
    const body = route.request().postData()!; bodies.push(body);
    if (!stored) { stored = message(body); await route.abort('connectionreset'); return; }
    await route.fulfill({ status: 200, json: stored });
  });
  await setup(page, true);
  const queued = await prepare(page);
  const first = await page.evaluate(async () => {
    const { driver, list, alice } = window.deliveryTest;
    return { run: await driver.drain(), remaining: await list(alice) };
  });
  expect(first.run.sent).toBe(0);
  expect(first.remaining[0]).toMatchObject({ nonce: queued.nonce, serializedRequest: queued.serializedRequest, attempts: 1, status: 'pending' });
  expect(first.remaining[0].nextAttemptAt).toBe(11_000);
  await setup(page, false);
  const second = await page.evaluate(async () => {
    const fixture = window.deliveryTest; fixture.setNow(11_001);
    const run = await fixture.driver.drain();
    const receipts = await fixture.alice.transact(tx => tx.list<{ result: { message: { id: string; e2ee: Parameters<typeof fixture.bobDm.decrypt>[2] } } }>('messages.delivery-receipts'));
    const plaintext = await fixture.bobDm.decrypt('dm', fixture.alicePeer, receipts[0].value.result.message.e2ee, receipts[0].value.result.message.id);
    return { run, remaining: await fixture.list(fixture.alice), plaintext };
  });
  expect(second).toMatchObject({ run: { sent: 1 }, remaining: [], plaintext: 'Private message' });
  expect(bodies).toEqual([queued.serializedRequest, queued.serializedRequest]);
});

test('permanent failure retains its draft and conversation order while another conversation delivers', async ({ page }) => {
  let blocked = true;
  const bodies: string[] = [];
  await page.route('**/api/v1/channels/*/messages', async route => {
    const channel = route.request().url().split('/').at(-2)!;
    const body = route.request().postData()!; bodies.push(body);
    if (channel === 'dm' && blocked) { await route.fulfill({ status: 403, json: { message: 'Permission was revoked.' } }); return; }
    await route.fulfill({ status: 201, json: message(body, channel, String(100 + bodies.length)) });
  });
  await setup(page, true);
  const first = await prepare(page, 'dm', 'First');
  const second = await prepare(page, 'dm', 'Second');
  await prepare(page, 'other', 'Independent');
  const failed = await page.evaluate(async () => {
    const { driver, alice, list } = window.deliveryTest;
    return { run: await driver.drain(), remaining: await list(alice) };
  });
  expect(failed.run.sent).toBe(1);
  expect(failed.remaining.map(record => [record.id, record.status, record.draft.content])).toEqual([[first.id, 'failed', 'First'], [second.id, 'pending', 'Second']]);
  blocked = false;
  const retried = await page.evaluate(async id => { const f = window.deliveryTest; await f.driver.retry(id); return f.driver.drain(); }, first.id);
  expect(retried.sent).toBe(2);
  expect(bodies[0]).toBe(bodies[2]);
  expect(bodies[3]).toBe(second.serializedRequest);
});

test('simultaneous browser tabs serialize delivery under one account lock', async ({ page, context }) => {
  let inFlight = 0; let maxInFlight = 0; const nonces: string[] = [];
  await context.route('**/api/v1/channels/*/messages', async route => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    const response = message(route.request().postData()!, 'dm', String(100 + nonces.length)); nonces.push(response.nonce);
    await new Promise(resolve => setTimeout(resolve, 30));
    await route.fulfill({ status: 201, json: response }); inFlight--;
  });
  await setup(page, true);
  for (let i = 0; i < 4; i++) await prepare(page, 'dm', `Message ${i}`);
  const other = await context.newPage(); await setup(other, false);
  const results = await Promise.all([page.evaluate(() => window.deliveryTest.driver.drain()), other.evaluate(() => window.deliveryTest.driver.drain())]);
  expect(results.reduce((sum, result) => sum + result.sent, 0)).toBe(4);
  expect(maxInFlight).toBe(1);
  expect(new Set(nonces).size).toBe(4);
});

test('an acknowledgement storage failure retains the original request for idempotent replay', async ({ page }) => {
  const bodies: string[] = [];
  await page.route('**/api/v1/channels/dm/messages', route => {
    const body = route.request().postData()!; bodies.push(body);
    return route.fulfill({ status: bodies.length === 1 ? 201 : 200, json: message(body) });
  });
  await setup(page, true); const queued = await prepare(page);
  const failed = await page.evaluate(async () => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      if (value?.address?.[2] === 'messages.delivery-receipts') throw new DOMException('Disk full', 'QuotaExceededError');
      return original.call(this, value, key);
    };
    let error = '';
    try { await window.deliveryTest.driver.drain(); } catch (caught) { error = String(caught); }
    finally { IDBObjectStore.prototype.put = original; }
    return { error, remaining: await window.deliveryTest.list(window.deliveryTest.alice) };
  });
  expect(failed.error).toContain('Disk full');
  expect(failed.remaining[0].serializedRequest).toBe(queued.serializedRequest);
  await page.evaluate(async () => { const f = window.deliveryTest; f.setNow(11_001); await f.driver.drain(); });
  expect(bodies).toEqual([queued.serializedRequest, queued.serializedRequest]);
});

test('server retry timing survives explicit retry and resumes only at its deadline', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/v1/channels/dm/messages', route => {
    requests++;
    if (requests === 1) return route.fulfill({ status: 429, headers: { 'Retry-After': '60' }, json: { message: 'Rate limited' } });
    return route.fulfill({ status: 201, json: message(route.request().postData()!) });
  });
  await setup(page, true); const queued = await prepare(page);
  const before = await page.evaluate(async id => {
    const f = window.deliveryTest; await f.driver.drain(); await f.driver.retry(id);
    const run = await f.driver.drain();
    return { run, queue: await f.list(f.alice) };
  }, queued.id);
  expect(requests).toBe(1);
  expect(before.run.nextAttemptAt).toBe(70_000);
  expect(before.queue[0].serializedRequest).toBe(queued.serializedRequest);
  const after = await page.evaluate(async () => { const f = window.deliveryTest; f.setNow(70_000); return f.driver.drain(); });
  expect(after.sent).toBe(1); expect(requests).toBe(2);
});

test('logout during a request preserves the encrypted queue without a stale receipt', async ({ page }) => {
  let requestStarted!: () => void; const started = new Promise<void>(resolve => { requestStarted = resolve; });
  let release!: () => void; const finish = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/channels/dm/messages', async route => {
    requestStarted(); await finish;
    await route.fulfill({ status: 201, json: message(route.request().postData()!) }).catch(() => {});
  });
  await setup(page, true); const queued = await prepare(page);
  const run = page.evaluate(async () => {
    try { await window.deliveryTest.driver.drain(); return 'unexpected success'; }
    catch { return 'cancelled'; }
  });
  await started;
  await page.evaluate(() => window.deliveryTest.logout()); release();
  expect(await run).toBe('cancelled');
  const retained = await page.evaluate(async () => {
    const f = window.deliveryTest;
    return { queue: await f.list(f.alice), receipts: await f.alice.transact(tx => tx.list('messages.delivery-receipts')) };
  });
  expect(retained.queue[0].serializedRequest).toBe(queued.serializedRequest);
  expect(retained.receipts).toEqual([]);
});

test('the running sender notices a new enqueue while its previous attempt is in flight', async ({ page }) => {
  let requestStarted!: () => void; const started = new Promise<void>(resolve => { requestStarted = resolve; });
  let release!: () => void; const finish = new Promise<void>(resolve => { release = resolve; });
  const bodies: string[] = [];
  await page.route('**/api/v1/channels/dm/messages', async route => {
    const body = route.request().postData()!; bodies.push(body);
    if (bodies.length === 1) { requestStarted(); await finish; }
    await route.fulfill({ status: 201, json: message(body, 'dm', String(100 + bodies.length)) });
  });
  await setup(page, true); await prepare(page, 'dm', 'First');
  await page.evaluate(() => window.deliveryTest.driver.start());
  await started;
  await prepare(page, 'dm', 'Second');
  await page.evaluate(() => window.deliveryTest.driver.wake()); release();
  await expect.poll(() => bodies.length).toBe(2);
  await expect.poll(() => page.evaluate(async () => (await window.deliveryTest.list(window.deliveryTest.alice)).length)).toBe(0);
  await page.evaluate(() => window.deliveryTest.close());
});


test('a policy refusal is recorded as terminal; a lost connection is not', async ({ page }) => {
  // An AutoMod block answers 403 with its reason and will answer the same way
  // for the same bytes forever, so the queue row must stop offering Retry. A
  // connection that dropped is a delivery that never happened and keeps it.
  let mode: 'automod' | 'reset' = 'automod';
  await page.route('**/api/v1/channels/dm/messages', async route => {
    if (mode === 'reset') { await route.abort('connectionreset'); return; }
    await route.fulfill({ status: 403, json: { code: 'AUTOMOD_BLOCKED', message: 'Blocked by a server rule' } });
  });
  await setup(page, true);
  const blocked = await prepare(page, 'dm', 'Say the banned word');
  const refusal = await page.evaluate(async () => {
    const f = window.deliveryTest;
    return { run: await f.driver.drain(), remaining: await f.list(f.alice) };
  });
  expect(refusal.run.sent).toBe(0);
  expect(refusal.remaining[0]).toMatchObject({ id: blocked.id, status: 'failed', refused: true, error: 'Blocked by a server rule' });
  // Asking for one more attempt clears the mark with the error it explained.
  const retried = await page.evaluate(async id => {
    const f = window.deliveryTest;
    await f.driver.retry(id);
    return f.list(f.alice);
  }, blocked.id);
  expect(retried[0]).toMatchObject({ status: 'pending', refused: false, error: null });
  mode = 'reset';
  const lost = await page.evaluate(async () => {
    const f = window.deliveryTest;
    await f.driver.drain();
    return f.list(f.alice);
  });
  expect(lost[0]).toMatchObject({ status: 'pending', refused: false });
});

test('queued intents stay editable behind a failed lane head without advancing its ratchet', async ({ page }) => {
  let blocked = true; const bodies: Array<{ channel: string; body: string }> = [];
  await page.route('**/api/v1/channels/*/messages', async route => {
    const channel = route.request().url().split('/').at(-2)!;
    const body = route.request().postData()!; bodies.push({ channel, body });
    await route.fulfill(channel === 'dm' && blocked
      ? { status: 403, json: { message: 'Permission was revoked.' } }
      : { status: 201, json: message(body, channel, String(100 + bodies.length)) });
  });
  await setup(page, true);
  const initial = await page.evaluate(async () => {
    const f = window.deliveryTest; f.setNow(Date.now());
    const first = await f.aliceDm.enqueue('dm', f.bobPeer, 'First');
    const second = await f.aliceDm.enqueue('dm', f.bobPeer, 'Before editing');
    const removed = await f.aliceDm.enqueue('dm', f.bobPeer, 'Discard this');
    await f.aliceDm.enqueue('other', f.bobPeer, 'Independent');
    const edited = await f.driver.editDraft(second.id, second.revision, 'Edited before encryption');
    await f.driver.discardDraft(removed.id, removed.revision);
    return { first, edited, bundles: f.bundleCalls(), sessions: await f.alice.transact(tx => tx.list('signal.sessions')), queued: await f.queuedList(f.alice) };
  });
  expect(initial.bundles).toBe(0); expect(initial.sessions).toEqual([]);
  expect(initial.queued).toHaveLength(3);
  const run = await page.evaluate(() => window.deliveryTest.driver.drain());
  expect(run.sent).toBe(1);
  expect(bodies.map(item => item.channel)).toEqual(['dm', 'other']);
  const pending = await page.evaluate(async ({ first, edited }) => {
    const f = window.deliveryTest; let error = '';
    try { await f.driver.editDraft(first.id, first.revision, 'Too late'); } catch (failure) { error = String(failure); }
    let stale = '';
    try { await f.driver.editDraft(edited.id, 'old-revision', 'Stale edit'); } catch (failure) { stale = String(failure); }
    return { error, stale, records: await f.queuedList(f.alice) };
  }, initial);
  expect(pending.error).toContain('prepared for delivery'); expect(pending.stale).toContain('another window');
  expect(pending.records[1]).toMatchObject({ revision: initial.edited.revision, draft: { content: 'Edited before encryption' } });
  blocked = false;
  const delivered = await page.evaluate(async firstId => {
    const f = window.deliveryTest; await f.driver.retry(firstId); await f.driver.drain();
    const receipts = await f.alice.transact(tx => tx.list<{ channelId: string; result: { message: { id: string; e2ee: Parameters<typeof f.bobDm.decrypt>[2] } } }>('messages.delivery-receipts'));
    const messages = receipts.map(row => row.value).filter(row => row.channelId === 'dm').sort((a, b) => Number(a.result.message.id) - Number(b.result.message.id));
    const plaintext = [];
    for (const receipt of messages) plaintext.push(await f.bobDm.decrypt('dm', f.alicePeer, receipt.result.message.e2ee, receipt.result.message.id));
    return { plaintext, remaining: await f.queuedList(f.alice), bundles: f.bundleCalls() };
  }, initial.first.id);
  expect(delivered).toEqual({ plaintext: ['First', 'Edited before encryption'], remaining: [], bundles: 2 });
  expect(bodies[0].body).toBe(bodies[2].body);
});

test('discarding an unprepared initial draft lets the next message initialize the recipient', async ({ page }) => {
  const sent: string[] = [];
  await page.route('**/api/v1/channels/dm/messages', async route => {
    const body = route.request().postData()!; sent.push(body);
    await route.fulfill({ status: 201, json: message(body) });
  });
  await setup(page, true);
  const result = await page.evaluate(async () => {
    const f = window.deliveryTest;
    const removed = await f.aliceDm.enqueue('dm', f.bobPeer, 'Never send this');
    await f.aliceDm.enqueue('dm', f.bobPeer, 'New first message');
    await f.driver.discardDraft(removed.id, removed.revision);
    await f.driver.drain();
    const [receipt] = await f.alice.transact(tx => tx.list<{ result: { message: { id: string; e2ee: Parameters<typeof f.bobDm.decrypt>[2] } } }>('messages.delivery-receipts'));
    const message = receipt.value.result.message;
    return { plaintext: await f.bobDm.decrypt('dm', f.alicePeer, message.e2ee, message.id), header: JSON.parse(message.e2ee.header!), bundles: f.bundleCalls() };
  });
  expect(sent).toHaveLength(1); expect(result.plaintext).toBe('New first message');
  expect(result.header.n).toBe(0); expect(result.header.ik).toBeTruthy(); expect(result.bundles).toBe(1);
});

test('an intent becomes one immutable request across a lost response and reload', async ({ page }) => {
  const bodies: string[] = []; let stored: ReturnType<typeof message> | undefined;
  await page.route('**/api/v1/channels/dm/messages', async route => {
    const body = route.request().postData()!; bodies.push(body);
    if (!stored) { stored = message(body); await route.abort('connectionreset'); return; }
    await route.fulfill({ status: 200, json: stored });
  });
  await setup(page, true);
  const first = await page.evaluate(async () => {
    const f = window.deliveryTest; const queued = await f.aliceDm.enqueue('dm', f.bobPeer, 'Retain exact delivery');
    await f.driver.drain(); return { queued, saved: (await f.list(f.alice))[0] };
  });
  expect(first.saved.nonce).toBe(first.queued.nonce); expect(first.saved.attempts).toBe(1);
  await setup(page, false);
  const result = await page.evaluate(async () => {
    const f = window.deliveryTest; f.setNow(11_001); await f.driver.drain();
    const [receipt] = await f.alice.transact(tx => tx.list<{ result: { message: { id: string; e2ee: Parameters<typeof f.bobDm.decrypt>[2] } } }>('messages.delivery-receipts'));
    const message = receipt.value.result.message;
    return { plaintext: await f.bobDm.decrypt('dm', f.alicePeer, message.e2ee, message.id), queued: await f.queuedList(f.alice), bundles: f.bundleCalls() };
  });
  expect(bodies).toEqual([first.saved.serializedRequest, first.saved.serializedRequest]);
  expect(result).toEqual({ plaintext: 'Retain exact delivery', queued: [], bundles: 0 });
});


test('failed preparation persistence retains the intent without committing a ratchet or sending HTTP', async ({ page }) => {
  const bodies: string[] = [];
  await page.route('**/api/v1/channels/dm/messages', async route => {
    const body = route.request().postData()!; bodies.push(body);
    await route.fulfill({ status: 201, json: message(body) });
  });
  await setup(page, true);
  const failed = await page.evaluate(async () => {
    const f = window.deliveryTest;
    const queued = await f.aliceDm.enqueue('dm', f.bobPeer, 'Keep this confidential draft');
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      if (value?.address?.[2] === 'messages.outbox') throw new DOMException('Outbox quota exhausted', 'QuotaExceededError');
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    };
    try { await f.driver.drain(); } finally { IDBObjectStore.prototype.put = put; }
    return { queued, records: await f.queuedList(f.alice), sessions: await f.alice.transact(tx => tx.list('signal.sessions')), plaintext: await f.alice.transact(tx => tx.list('messages.plaintext')) };
  });
  expect(bodies).toEqual([]); expect(failed.sessions).toEqual([]); expect(failed.plaintext).toEqual([]);
  expect(failed.records).toHaveLength(1);
  expect(failed.records[0]).toMatchObject({ id: failed.queued.id, revision: failed.queued.revision, status: 'failed', draft: { content: 'Keep this confidential draft' } });
  await page.evaluate(async id => { const f = window.deliveryTest; await f.driver.retry(id); await f.driver.drain(); }, failed.queued.id);
  expect(bodies).toHaveLength(1);
  expect(JSON.parse(JSON.parse(bodies[0]).e2ee.header).n).toBe(0);
  const received = await page.evaluate(async body => {
    const f = window.deliveryTest; return f.bobDm.decrypt('dm', f.alicePeer, JSON.parse(body).e2ee, '100');
  }, bodies[0]);
  expect(received).toBe('Keep this confidential draft');
});

test('preparation wins atomically over a racing edit without changing the original body', async ({ page }) => {
  const bodies: string[] = [];
  await page.route('**/api/v1/channels/dm/messages', async route => {
    bodies.push(route.request().postData()!);
    await route.fulfill({ status: 503, json: { message: 'Try later' } });
  });
  await setup(page, true);
  const result = await page.evaluate(async () => {
    const f = window.deliveryTest;
    const queued = await f.aliceDm.enqueue('dm', f.bobPeer, 'Original draft');
    const gate = f.pausePreparation();
    const draining = f.driver.drain(); await gate.waiting;
    const editing = f.driver.editDraft(queued.id, queued.revision, 'Racing edit').then(() => '', error => String(error));
    gate.release(); const error = await editing; await draining;
    const [saved] = await f.list(f.alice);
    return { error, saved, plaintext: await f.bobDm.decrypt('dm', f.alicePeer, JSON.parse(saved.serializedRequest).e2ee, '100') };
  });
  expect(result.error).toContain('prepared for delivery');
  expect(result.plaintext).toBe('Original draft'); expect(bodies).toEqual([result.saved.serializedRequest]);
});


for (const state of ['cancelled', 'deleted'] as const) {
  test(`discarding a ${state} initial send re-prepares unattempted followers with a fresh session`, async ({ page }) => {
    let blocked = true; const bodies: string[] = [];
    await page.route('**/api/v1/channels/dm/messages', async route => {
      const body = route.request().postData()!; bodies.push(body);
      await route.fulfill(blocked ? { status: 403, json: { message: 'Denied' } } : { status: 201, json: message(body, 'dm', '101') });
    });
    await page.route('**/message-deliveries/*/resolve', route => route.fulfill({ status: 200, json: {
      channel_id: 'dm', author_id: 'alice', nonce: route.request().url().split('/').at(-2), state,
      ...(state === 'deleted' ? { message_id: '100' } : {}),
    } }));
    await setup(page, true);
    const prepared = await page.evaluate(async () => {
      const f = window.deliveryTest;
      const first = await f.aliceDm.prepare('dm', f.bobPeer, 'Discard initial');
      const second = await f.aliceDm.prepare('dm', f.bobPeer, 'Retain follower');
      await f.driver.drain(); await f.driver.discardPrepared(first.id); return { first, second };
    });
    blocked = false;
    const result = await page.evaluate(async () => {
      const f = window.deliveryTest; const run = await f.driver.drain();
      const receipts = await f.alice.transact(tx => tx.list<{ result: { kind: string; message?: { id: string; e2ee: Parameters<typeof f.bobDm.decrypt>[2] } } }>('messages.delivery-receipts'));
      const delivered = receipts.find(row => row.value.result.kind === 'message')!.value.result.message!;
      return { run, plaintext: await f.bobDm.decrypt('dm', f.alicePeer, delivered.e2ee, delivered.id), remaining: await f.queuedList(f.alice), retired: await f.alice.transact(tx => tx.list('signal.retired-sends')) };
    });
    expect(result.run.sent).toBe(1); expect(result.plaintext).toBe('Retain follower'); expect(result.remaining).toEqual([]);
    expect(result.retired).toHaveLength(1); expect(bodies).toHaveLength(2);
    const sent = JSON.parse(bodies[1]); expect(sent.nonce).toBe(prepared.second.nonce);
    expect(bodies[1]).not.toBe(prepared.second.serializedRequest);
    expect(JSON.parse(sent.e2ee.header).n).toBe(0); expect(JSON.parse(sent.e2ee.header).ik).toBeTruthy();
  });
}

test('retiring a discarded send preserves private keys for delayed incoming replies', async ({ page }) => {
  let firstBody = ''; const sent: string[] = []; let removed = false;
  await page.route('**/api/v1/channels/dm/messages', async route => {
    const body = route.request().postData()!; sent.push(body);
    if (!firstBody) { firstBody = body; await route.abort('connectionreset'); return; }
    await route.fulfill({ status: 201, json: message(body, 'dm', '104') });
  });
  await page.route('**/message-deliveries/*/resolve', route => route.fulfill({ status: 200, json: {
    channel_id: 'dm', author_id: 'alice', nonce: route.request().url().split('/').at(-2), state: removed ? 'deleted' : 'delivered', message_id: '100',
  } }));
  await page.route('**/api/v1/channels/dm/messages/100', async route => { expect(route.request().method()).toBe('DELETE'); removed = true; await route.fulfill({ status: 204 }); });
  await setup(page, true);
  const result = await page.evaluate(async () => {
    const f = window.deliveryTest;
    const first = await f.aliceDm.prepare('dm', f.bobPeer, 'Original');
    await f.driver.drain();
    await f.bobDm.decrypt('dm', f.alicePeer, JSON.parse(first.serializedRequest).e2ee, '100');
    const early = await f.bobDm.prepare('dm', f.alicePeer, 'Early reply');
    const late = await f.bobDm.prepare('dm', f.alicePeer, 'Delayed reply');
    await f.aliceDm.decrypt('dm', f.bobPeer, JSON.parse(early.serializedRequest).e2ee, '101');
    await f.aliceDm.enqueue('dm', f.bobPeer, 'After discard');
    await f.driver.discardPrepared(first.id); await f.driver.drain();
    const receipts = await f.alice.transact(tx => tx.list<{ result: { kind: string; message?: { id: string; e2ee: Parameters<typeof f.bobDm.decrypt>[2] } } }>('messages.delivery-receipts'));
    const next = receipts.find(row => row.value.result.kind === 'message')!.value.result.message!;
    const received = await f.bobDm.decrypt('dm', f.alicePeer, next.e2ee, next.id);
    const delayed = await f.aliceDm.decrypt('dm', f.bobPeer, JSON.parse(late.serializedRequest).e2ee, '102');
    const following = await f.aliceDm.prepare('dm', f.bobPeer, 'Still current');
    const header = JSON.parse(JSON.parse(following.serializedRequest).e2ee.header);
    return { received, delayed, followingCounter: header.n, restarted: Boolean(header.ik) };
  });
  expect(removed).toBe(true); expect(sent).toHaveLength(2);
  expect(result).toEqual({ received: 'After discard', delayed: 'Delayed reply', followingCounter: 1, restarted: false });
});

test('a lost resolution response resumes discard after reload without replaying the original send', async ({ page }) => {
  let resolves = 0; let posts = 0;
  await page.route('**/api/v1/channels/dm/messages', async route => {
    posts++; await route.fulfill({ status: 403, json: { message: 'Denied' } });
  });
  await page.route('**/message-deliveries/*/resolve', async route => {
    resolves++; if (resolves === 1) { await route.abort('connectionreset'); return; }
    await route.fulfill({ status: 200, json: { channel_id: 'dm', author_id: 'alice', nonce: route.request().url().split('/').at(-2), state: 'cancelled' } });
  });
  await setup(page, true);
  await page.evaluate(async () => {
    const f = window.deliveryTest; const queued = await f.aliceDm.prepare('dm', f.bobPeer, 'Cancel once');
    await f.driver.drain(); await f.driver.discardPrepared(queued.id); await f.driver.drain();
  });
  await setup(page, false);
  const result = await page.evaluate(async () => {
    const f = window.deliveryTest; f.setNow(20_000);
    const before = await f.list(f.alice); await f.driver.drain();
    return { before, remaining: await f.queuedList(f.alice), retired: await f.alice.transact(tx => tx.list('signal.retired-sends')) };
  });
  expect(result.before[0].mutation).toEqual({ kind: 'discard' }); expect(result.remaining).toEqual([]);
  expect(result.retired).toHaveLength(1); expect(posts).toBe(1); expect(resolves).toBe(2);
});

test('failed retirement persistence keeps the discard and its ratchet for an atomic retry', async ({ page }) => {
  await page.route('**/api/v1/channels/dm/messages', route => route.fulfill({ status: 403, json: { message: 'Denied' } }));
  await page.route('**/message-deliveries/*/resolve', route => route.fulfill({ status: 200, json: { channel_id: 'dm', author_id: 'alice', nonce: route.request().url().split('/').at(-2), state: 'cancelled' } }));
  await setup(page, true);
  const result = await page.evaluate(async () => {
    const f = window.deliveryTest; const queued = await f.aliceDm.prepare('dm', f.bobPeer, 'Preserve until committed');
    await f.driver.drain(); await f.driver.discardPrepared(queued.id);
    const before = JSON.stringify(await f.alice.transact(tx => tx.list('signal.sessions')));
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      if (value?.address?.[2] === 'signal.retired-sends') throw new DOMException('Cannot save retirement', 'QuotaExceededError');
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    };
    let error = ''; try { await f.driver.drain(); } catch (failure) { error = String(failure); } finally { IDBObjectStore.prototype.put = put; }
    const retained = await f.list(f.alice); const receipts = await f.alice.transact(tx => tx.list('messages.delivery-receipts'));
    const unchanged = before === JSON.stringify(await f.alice.transact(tx => tx.list('signal.sessions')));
    const retired = await f.alice.transact(tx => tx.list('signal.retired-sends'));
    f.setNow(20_000); await f.driver.drain();
    return { error, retained, receipts, unchanged, retired, remaining: await f.list(f.alice) };
  });
  expect(result.error).toContain('Cannot save retirement'); expect(result.retained[0].mutation).toEqual({ kind: 'discard' });
  expect(result.receipts).toEqual([]); expect(result.unchanged).toBe(true); expect(result.retired).toEqual([]); expect(result.remaining).toEqual([]);
});


test('discarding multiple prepared followers resolves their original requests without generating unused sessions', async ({ page }) => {
  let posts = 0; const resolved: string[] = [];
  await page.route('**/api/v1/channels/dm/messages', route => { posts++; return route.fulfill({ status: 403, json: { message: 'Denied' } }); });
  await page.route('**/message-deliveries/*/resolve', route => {
    const nonce = route.request().url().split('/').at(-2)!; resolved.push(nonce);
    return route.fulfill({ status: 200, json: { channel_id: 'dm', author_id: 'alice', nonce, state: 'cancelled' } });
  });
  await setup(page, true);
  const result = await page.evaluate(async () => {
    const f = window.deliveryTest;
    const first = await f.aliceDm.prepare('dm', f.bobPeer, 'First discard');
    const second = await f.aliceDm.prepare('dm', f.bobPeer, 'Second discard');
    await f.driver.drain(); await f.driver.discardPrepared(second.id); await f.driver.discardPrepared(first.id);
    await f.driver.drain();
    return { ids: [first.nonce, second.nonce], bundles: f.bundleCalls(), remaining: await f.queuedList(f.alice) };
  });
  expect(resolved).toEqual(result.ids); expect(posts).toBe(1); expect(result.bundles).toBe(1); expect(result.remaining).toEqual([]);
});

for (const outcome of ['delivered', 'denied', 'lost', 'limited'] as const) {
  test(`discard during an in-flight ${outcome} send persists immediately and resolves before followers`, async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = false; const bodies: string[] = []; let resolves = 0; let deletes = 0;
    await page.route('**/api/v1/channels/dm/messages', async route => {
      const body = route.request().postData()!; bodies.push(body);
      if (bodies.length > 1) { await route.fulfill({ status: 201, json: message(body, 'dm', '101') }); return; }
      entered = true; await gate;
      if (outcome === 'lost') { await route.abort('connectionreset'); return; }
      if (outcome === 'denied') { await route.fulfill({ status: 403, json: { message: 'Denied' } }); return; }
      if (outcome === 'limited') { await route.fulfill({ status: 429, headers: { 'Retry-After': '30' }, json: { message: 'Wait' } }); return; }
      await route.fulfill({ status: 201, json: message(body) });
    });
    await page.route('**/message-deliveries/*/resolve', route => {
      resolves++;
      return route.fulfill({ status: 200, json: {
        channel_id: 'dm', author_id: 'alice', nonce: route.request().url().split('/').at(-2),
        state: outcome === 'delivered' || outcome === 'lost' ? 'delivered' : 'cancelled',
        ...(outcome === 'delivered' || outcome === 'lost' ? { message_id: '100' } : {}),
      } });
    });
    await page.route('**/api/v1/channels/dm/messages/100', route => { deletes++; return route.fulfill({ status: 204 }); });
    await setup(page, true);
    const first = await prepare(page);
    await page.evaluate(() => { const f = window.deliveryTest; return f.aliceDm.enqueue('dm', f.bobPeer, 'Follower'); });
    const draining = page.evaluate(() => window.deliveryTest.driver.drain());
    await expect.poll(() => entered).toBe(true);
    // This must finish while the original POST is still held by the route gate.
    const pending = await page.evaluate(async id => {
      const f = window.deliveryTest; await f.driver.discardPrepared(id);
      return (await f.list(f.alice))[0];
    }, first.id);
    expect(pending.mutation).toEqual({ kind: 'discard' }); expect(resolves).toBe(0);
    release();
    const run = await draining;
    if (outcome === 'limited') {
      expect(run).toEqual({ sent: 0, nextAttemptAt: 40_000 }); expect(resolves).toBe(0);
      await page.evaluate(async () => { const f = window.deliveryTest; f.setNow(40_000); await f.driver.drain(); });
    } else expect(run.sent).toBe(1);
    expect(resolves).toBe(1); expect(deletes).toBe(outcome === 'delivered' || outcome === 'lost' ? 1 : 0);
    expect(bodies).toHaveLength(2); expect(JSON.parse(bodies[1]).nonce).not.toBe(first.nonce);
    expect(JSON.parse(JSON.parse(bodies[1]).e2ee.header).ik).toBeTruthy();
    const result = await page.evaluate(async body => {
      const f = window.deliveryTest;
      return { remaining: await f.queuedList(f.alice), plaintext: await f.bobDm.decrypt('dm', f.alicePeer, JSON.parse(body).e2ee, '101') };
    }, bodies[1]);
    expect(result).toEqual({ remaining: [], plaintext: 'Follower' });
  });
}

test('reload after discarding an in-flight send resumes resolution without resending its body', async ({ page }) => {
  let release!: () => void; let entered = false; let posts = 0; let resolves = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/channels/dm/messages', async route => {
    posts++; entered = true; await gate;
    await route.abort('connectionreset').catch(() => {}); // Reload may already have cancelled this request.
  });
  await page.route('**/message-deliveries/*/resolve', route => {
    resolves++;
    return route.fulfill({ status: 200, json: { channel_id: 'dm', author_id: 'alice', nonce: route.request().url().split('/').at(-2), state: 'cancelled' } });
  });
  await setup(page, true);
  const first = await prepare(page);
  await page.evaluate(() => { void window.deliveryTest.driver.drain().catch(() => {}); });
  await expect.poll(() => entered).toBe(true);
  await page.evaluate(id => window.deliveryTest.driver.discardPrepared(id), first.id);
  await setup(page, false);
  release();
  const result = await page.evaluate(async () => {
    const f = window.deliveryTest; const before = await f.list(f.alice); await f.driver.drain();
    return { before, remaining: await f.queuedList(f.alice), retired: await f.alice.transact(tx => tx.list('signal.retired-sends')) };
  });
  expect(result.before[0].mutation).toEqual({ kind: 'discard' }); expect(result.remaining).toEqual([]);
  expect(result.retired).toHaveLength(1); expect(posts).toBe(1); expect(resolves).toBe(1);
});

function editedMessage(body: string, originalNonce: string) {
  const edit = JSON.parse(body);
  return { ...message(JSON.stringify({ ...edit, nonce: originalNonce })), edit_nonce: edit.edit_nonce, edit_replayed: false };
}

async function requestEdit(page: Page, id: string, content: string) {
  return page.evaluate(async ({ id, content }) => {
    const f = window.deliveryTest; const record = (await f.list(f.alice)).find(row => row.id === id)!;
    await f.driver.editPrepared(id, f.mutationRevision(record), content);
    return (await f.list(f.alice)).find(row => row.id === id)!;
  }, { id, content });
}

async function resolvedDelivery(page: Page, state: 'delivered' | 'cancelled' | 'deleted') {
  await page.route('**/message-deliveries/*/resolve', route => route.fulfill({ status: 200, json: {
    channel_id: 'dm', author_id: 'alice', nonce: route.request().url().split('/').at(-2), state,
    ...(state === 'cancelled' ? {} : { message_id: '100' }),
  } }));
}

test('editing a delivery cancelled before creation replaces its nonce and keeps encrypted followers readable', async ({ page }) => {
  const bodies: string[] = [];
  await resolvedDelivery(page, 'cancelled');
  await page.route('**/api/v1/channels/dm/messages', route => {
    const body = route.request().postData()!; bodies.push(body);
    return route.fulfill({ status: 201, json: message(body, 'dm', String(99 + bodies.length)) });
  });
  await setup(page, true);
  const first = await prepare(page, 'dm', 'Original draft');
  const follower = await prepare(page, 'dm', 'Follower');
  await requestEdit(page, first.id, 'Edited before delivery');
  const result = await page.evaluate(async () => {
    const f = window.deliveryTest;
    return { run: await f.driver.drain(), remaining: await f.queuedList(f.alice) };
  });
  expect(result).toMatchObject({ run: { sent: 2 }, remaining: [] });
  expect(bodies).toHaveLength(2);
  expect(JSON.parse(bodies[0]).nonce).not.toBe(first.nonce);
  expect(JSON.parse(bodies[1]).nonce).toBe(follower.nonce);
  const plaintext = await page.evaluate(async bodies => {
    const f = window.deliveryTest;
    return [await f.bobDm.decrypt('dm', f.alicePeer, JSON.parse(bodies[0]).e2ee, '100'),
      await f.bobDm.decrypt('dm', f.alicePeer, JSON.parse(bodies[1]).e2ee, '101')];
  }, bodies);
  expect(plaintext).toEqual(['Edited before delivery', 'Follower']);
});

test('a lost edit response reloads and retries the same independent ciphertext without another key fetch', async ({ page }) => {
  const patches: string[] = []; let originalNonce = ''; let posts = 0;
  await page.route('**/api/v1/channels/dm/messages', route => { posts++; return route.abort('connectionreset'); });
  await resolvedDelivery(page, 'delivered');
  await page.route('**/api/v1/channels/dm/messages/100', route => {
    const body = route.request().postData()!; patches.push(body);
    if (patches.length === 1) return route.abort('connectionreset');
    return route.fulfill({ status: 200, json: { ...editedMessage(body, originalNonce), edit_replayed: true } });
  });
  await setup(page, true); const first = await prepare(page); originalNonce = first.nonce;
  await page.evaluate(() => window.deliveryTest.driver.drain());
  await requestEdit(page, first.id, 'Survives a lost PATCH reply');
  await page.evaluate(() => window.deliveryTest.driver.drain());
  const saved = await page.evaluate(() => { const f = window.deliveryTest; return f.list(f.alice); });
  expect(saved[0].mutation).toMatchObject({ kind: 'edit', content: 'Survives a lost PATCH reply', prepared: { serializedRequest: patches[0] } });
  await setup(page, false);
  const result = await page.evaluate(async () => {
    const f = window.deliveryTest; f.setNow(30_000);
    return { run: await f.driver.drain(), remaining: await f.queuedList(f.alice), bundleCalls: f.bundleCalls() };
  });
  expect(result).toMatchObject({ run: { sent: 1 }, remaining: [], bundleCalls: 0 });
  expect(posts).toBe(1); expect(patches).toHaveLength(2); expect(patches[1]).toBe(patches[0]);
  const plaintext = await page.evaluate(async body => {
    const f = window.deliveryTest; return f.bobDm.decrypt('dm', f.alicePeer, JSON.parse(body).e2ee, '100');
  }, patches[0]);
  expect(plaintext).toBe('Survives a lost PATCH reply');
});

for (const outcome of ['lost', 'rejected', 'limited'] as const) {
test(`a replacement edit resolves a ${outcome} PATCH before transmitting new ciphertext`, async ({ page }) => {
  const patches: string[] = []; const events: string[] = []; let originalNonce = '';
  await resolvedDelivery(page, 'delivered');
  await page.route('**/api/v1/channels/dm/messages/100', route => {
    const body = route.request().postData()!; patches.push(body); events.push(`patch:${JSON.parse(body).edit_nonce}`);
    if (patches.length === 1) {
      if (outcome === 'lost') return route.abort('connectionreset');
      return route.fulfill({ status: outcome === 'limited' ? 429 : 400, headers: outcome === 'limited' ? { 'Retry-After': '30' } : {}, json: { message: 'Cannot apply this edit yet.' } });
    }
    return route.fulfill({ status: 200, json: editedMessage(body, originalNonce) });
  });
  await page.route('**/messages/100/edits/*/resolve', route => {
    const editNonce = route.request().url().split('/').at(-2)!; events.push(`seal:${editNonce}`);
    return route.fulfill({ status: 200, json: { channel_id: 'dm', actor_id: 'alice', message_id: '100', edit_nonce: editNonce, state: 'cancelled' } });
  });
  await setup(page, true); const first = await prepare(page); originalNonce = first.nonce;
  await requestEdit(page, first.id, 'First uncertain edit'); await page.evaluate(() => window.deliveryTest.driver.drain());
  const next = await requestEdit(page, first.id, 'Replacement after uncertainty');
  expect(next.mutation).toMatchObject({ kind: 'edit', prepared: { serializedRequest: patches[0] }, next: { content: 'Replacement after uncertainty' } });
  if (outcome === 'limited') {
    expect((await page.evaluate(() => window.deliveryTest.driver.drain())).nextAttemptAt).toBe(40_000);
    expect(patches).toHaveLength(1); expect(events).toHaveLength(1);
    await page.evaluate(() => window.deliveryTest.setNow(40_000));
  }
  const result = await page.evaluate(async () => { const f = window.deliveryTest; return { run: await f.driver.drain(), remaining: await f.queuedList(f.alice) }; });
  expect(result).toMatchObject({ run: { sent: 1 }, remaining: [] });
  expect(patches).toHaveLength(2);
  const firstNonce = JSON.parse(patches[0]).edit_nonce; const nextNonce = JSON.parse(patches[1]).edit_nonce;
  expect(nextNonce).not.toBe(firstNonce); expect(events).toEqual([`patch:${firstNonce}`, `seal:${firstNonce}`, `patch:${nextNonce}`]);
  const plaintext = await page.evaluate(async body => {
    const f = window.deliveryTest; return f.bobDm.decrypt('dm', f.alicePeer, JSON.parse(body).e2ee, '100');
  }, patches[1]);
  expect(plaintext).toBe('Replacement after uncertainty');
});
}

test('editing during an in-flight POST persists immediately and wins over its acknowledgement', async ({ page }) => {
  let release!: () => void; let entered = false; let originalNonce = ''; const bodies: string[] = []; let patch = '';
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/channels/dm/messages', async route => {
    const body = route.request().postData()!; bodies.push(body); entered = true; await gate;
    await route.fulfill({ status: 201, json: message(body) });
  });
  await resolvedDelivery(page, 'delivered');
  await page.route('**/api/v1/channels/dm/messages/100', route => {
    patch = route.request().postData()!; return route.fulfill({ status: 200, json: editedMessage(patch, originalNonce) });
  });
  await setup(page, true); const first = await prepare(page); originalNonce = first.nonce;
  const draining = page.evaluate(() => window.deliveryTest.driver.drain());
  await expect.poll(() => entered).toBe(true);
  const pending = await requestEdit(page, first.id, 'Changed while sending');
  expect(pending.mutation).toMatchObject({ kind: 'edit', content: 'Changed while sending' });
  expect(pending.draft.content).toBe('Changed while sending');
  expect(patch).toBe(''); release();
  expect((await draining).sent).toBe(1); expect(bodies).toEqual([first.serializedRequest]);
  const result = await page.evaluate(async body => {
    const f = window.deliveryTest;
    return { remaining: await f.queuedList(f.alice), plaintext: await f.bobDm.decrypt('dm', f.alicePeer, JSON.parse(body).e2ee, '100') };
  }, patch);
  expect(result).toEqual({ remaining: [], plaintext: 'Changed while sending' });
});

test('stale queued editors cannot overwrite a newer edit and deleted targets keep their drafts', async ({ page }) => {
  await resolvedDelivery(page, 'deleted');
  await setup(page, true); const first = await prepare(page);
  await requestEdit(page, first.id, 'Latest user draft');
  const error = await page.evaluate(async first => {
    try { await window.deliveryTest.driver.editPrepared(first.id, first.nonce, 'Stale draft'); return null; }
    catch (error) { return String(error); }
  }, first);
  expect(error).toContain('changed in another window');
  const result = await page.evaluate(async () => { const f = window.deliveryTest; await f.driver.drain(); return f.list(f.alice); });
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ status: 'failed', draft: { content: 'Latest user draft' }, mutation: { kind: 'edit', content: 'Latest user draft' } });
  expect(result[0].error).toContain('deleted');
});

test('an edited first message cannot become a hidden ratchet dependency for its followers', async ({ page }) => {
  let patch = ''; let follower = ''; let originalNonce = '';
  await resolvedDelivery(page, 'delivered');
  await page.route('**/api/v1/channels/dm/messages/100', route => {
    patch = route.request().postData()!; return route.fulfill({ status: 200, json: editedMessage(patch, originalNonce) });
  });
  await page.route('**/api/v1/channels/dm/messages', route => {
    follower = route.request().postData()!; return route.fulfill({ status: 201, json: message(follower, 'dm', '101') });
  });
  await setup(page, true); const first = await prepare(page); originalNonce = first.nonce;
  await prepare(page, 'dm', 'Read this even without the edited message');
  await requestEdit(page, first.id, 'Independent edited message');
  expect((await page.evaluate(() => window.deliveryTest.driver.drain())).sent).toBe(2);
  const headers = [patch, follower].map(body => JSON.parse(JSON.parse(body).e2ee.header));
  expect(headers.every(header => header.ik)).toBe(true); expect(headers[0].ek).not.toBe(headers[1].ek);
  const plaintext = await page.evaluate(async ({ patch, follower }) => {
    const f = window.deliveryTest;
    return [await f.bobDm.decrypt('dm', f.alicePeer, JSON.parse(follower).e2ee, '101'),
      await f.bobDm.decrypt('dm', f.alicePeer, JSON.parse(patch).e2ee, '100')];
  }, { patch, follower });
  expect(plaintext).toEqual(['Read this even without the edited message', 'Independent edited message']);
});

test('discarding an in-flight edit persists immediately and deletes the resolved original target', async ({ page }) => {
  let release!: () => void; let entered = false; let deletes = 0; let originalNonce = '';
  const gate = new Promise<void>(resolve => { release = resolve; });
  await resolvedDelivery(page, 'delivered');
  await page.route('**/api/v1/channels/dm/messages/100', async route => {
    if (route.request().method() === 'DELETE') { deletes++; await route.fulfill({ status: 204 }); return; }
    entered = true; await gate;
    await route.fulfill({ status: 200, json: editedMessage(route.request().postData()!, originalNonce) });
  });
  await setup(page, true); const first = await prepare(page); originalNonce = first.nonce;
  await requestEdit(page, first.id, 'Edit which will be discarded');
  const draining = page.evaluate(() => window.deliveryTest.driver.drain());
  await expect.poll(() => entered).toBe(true);
  const saved = await page.evaluate(async id => {
    const f = window.deliveryTest; await f.driver.discardPrepared(id); return f.list(f.alice);
  }, first.id);
  expect(saved[0].mutation).toEqual({ kind: 'discard' }); expect(deletes).toBe(0);
  release(); expect((await draining).sent).toBe(0); expect(deletes).toBe(1);
  expect(await page.evaluate(() => { const f = window.deliveryTest; return f.queuedList(f.alice); })).toEqual([]);
});

test('failed edit preparation storage rolls back retirement and ciphertext before any PATCH', async ({ page }) => {
  let patches = 0; let originalNonce = '';
  await resolvedDelivery(page, 'delivered');
  await page.route('**/api/v1/channels/dm/messages/100', route => {
    patches++; return route.fulfill({ status: 200, json: editedMessage(route.request().postData()!, originalNonce) });
  });
  await setup(page, true); const first = await prepare(page); originalNonce = first.nonce;
  await requestEdit(page, first.id, 'Preserve this failed edit');
  const result = await page.evaluate(async () => {
    const f = window.deliveryTest; const before = JSON.stringify(await f.alice.transact(tx => tx.list('signal.sessions')));
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      if (value?.address?.[2] === 'signal.retired-sends') throw new DOMException('Cannot save edit encryption', 'QuotaExceededError');
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    };
    try { await f.driver.drain(); } finally { IDBObjectStore.prototype.put = put; }
    return { queued: await f.list(f.alice), unchanged: before === JSON.stringify(await f.alice.transact(tx => tx.list('signal.sessions'))),
      retired: await f.alice.transact(tx => tx.list('signal.retired-sends')) };
  });
  expect(patches).toBe(0); expect(result.unchanged).toBe(true); expect(result.retired).toEqual([]);
  expect(result.queued[0]).toMatchObject({ status: 'failed', mutation: { kind: 'edit', content: 'Preserve this failed edit' } });
  expect(result.queued[0].mutation?.kind === 'edit' && result.queued[0].mutation.prepared).toBeUndefined();
  await page.evaluate(async id => { const f = window.deliveryTest; await f.driver.retry(id); await f.driver.drain(); }, first.id);
  expect(patches).toBe(1);
});
