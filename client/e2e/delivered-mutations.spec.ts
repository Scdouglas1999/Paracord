import { expect, test, type Page } from '@playwright/test';
import type { initializeMutationFixture } from './fixtures/deliveredMutations';

declare global { interface Window { mutationTest: Awaited<ReturnType<typeof initializeMutationFixture>> } }
async function setup(page: Page, initialize = true) {
  await page.route('**/__mutation_test__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Mutation test</title>' }));
  await page.goto('/__mutation_test__');
  await page.evaluate(async initialize => {
    const source = '/e2e/fixtures/deliveredMutations.ts';
    window.mutationTest = await (await import(source)).initializeMutationFixture(initialize);
  }, initialize);
}
const editMessage = (body: string) => ({ id: '100', channel_id: 'dm', author: { id: 'alice' }, ...JSON.parse(body), edit_replayed: false });

test('delivered DM edit without a send receipt survives reload with exactly one encryption preparation', async ({ page }) => {
  const bodies: string[] = [];
  await page.route('**/api/v1/channels/dm/messages/100', async route => {
    const body = route.request().postData()!; bodies.push(body);
    if (bodies.length === 1) await route.abort('connectionreset'); else await route.fulfill({ status: 200, json: editMessage(body) });
  });
  await setup(page);
  const first = await page.evaluate(async () => {
    const f = window.mutationTest; await f.service.edit(f.target, 'Private replacement after years', null); await f.service.drain();
    return { snapshot: await f.service.snapshot(), bundles: f.bundleCalls() };
  });
  expect(first.bundles).toBe(1); expect(first.snapshot.mutations[0].prepared).toBeDefined();
  await setup(page, false);
  const result = await page.evaluate(async () => {
    const f = window.mutationTest; f.setMutationNow(11_001); await f.service.drain();
    const receipt = (await f.service.snapshot()).receipts[0];
    if (receipt.result.kind !== 'message') throw new Error('Missing edit acknowledgment');
    return { plaintext: await f.bobDm.decrypt('dm', f.alicePeer, receipt.result.message.e2ee!, '100'), bundles: f.bundleCalls(),
      ownPlaintext: await f.aliceDm.decrypt('dm', f.bobPeer, receipt.result.message.e2ee!, '100') };
  });
  expect(bodies).toHaveLength(2); expect(bodies[0]).toBe(bodies[1]); expect(bodies[0]).not.toContain('Private replacement after years');
  expect(result).toEqual({ plaintext: 'Private replacement after years', ownPlaintext: 'Private replacement after years', bundles: 0 });
});

test('delivered edit restores eager followers and they decrypt before the edited initial message', async ({ page }) => {
  await page.route('**/api/v1/channels/dm/messages/100', route => route.fulfill({ status: 200, json: editMessage(route.request().postData()!) }));
  await page.route('**/api/v1/channels/dm/messages', route => route.fulfill({ status: 201,
    json: { ...JSON.parse(route.request().postData()!), id: '101', channel_id: 'dm', author: { id: 'alice' } } }));
  await setup(page);
  const result = await page.evaluate(async () => {
    const f = window.mutationTest;
    const original = await f.aliceDm.prepare('dm', f.bobPeer, 'Old initial message');
    await f.alice.transact(async tx => tx.remove('messages.outbox', original.id)); // Already delivered, no creation receipt.
    await f.aliceDm.prepare('dm', f.bobPeer, 'Follower A');
    await f.aliceDm.prepare('dm', f.bobPeer, 'Follower B');
    await f.service.edit(f.target, 'Edited original', null); await f.service.drain();
    const restored = await f.queuedList(f.alice);
    const editReceipt = (await f.service.snapshot()).receipts[0];
    if (editReceipt.result.kind !== 'message') throw new Error('Missing edited message');
    // Prepare the first restored follower without processing the edit at Bob.
    const intent = restored[0]; if ('serializedRequest' in intent) throw new Error('Follower was not restored');
    const request = await f.alice.transact(tx => f.aliceDm.prepareIntent(tx, intent));
    return { drafts: restored.map(row => row.draft.content),
      follower: await f.bobDm.decrypt('dm', f.alicePeer, request.e2ee!, '101'),
      edit: await f.bobDm.decrypt('dm', f.alicePeer, editReceipt.result.message.e2ee!, '100') };
  });
  expect(result).toEqual({ drafts: ['Follower A', 'Follower B'], follower: 'Follower A', edit: 'Edited original' });
});

test('failed durable DM edit commit rolls back retirement, request and plaintext cache before HTTP', async ({ page }) => {
  let patches = 0;
  await page.route('**/api/v1/channels/dm/messages/100', route => { patches++; return route.fulfill({ status: 200, json: editMessage(route.request().postData()!) }); });
  await setup(page);
  const failed = await page.evaluate(async () => {
    const f = window.mutationTest; const original = await f.aliceDm.prepare('dm', f.bobPeer, 'Original');
    await f.alice.transact(async tx => tx.remove('messages.outbox', original.id));
    const before = JSON.stringify(await f.alice.transact(tx => tx.list('signal.sessions')));
    await f.service.edit(f.target, 'Must survive quota failure', null);
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      if (value?.address?.[2] === 'signal.retired-sends') throw new DOMException('Cannot persist keys', 'QuotaExceededError');
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    };
    try { await f.service.drain(); } finally { IDBObjectStore.prototype.put = put; }
    return { snapshot: await f.service.snapshot(), unchanged: before === JSON.stringify(await f.alice.transact(tx => tx.list('signal.sessions'))),
      retired: await f.alice.transact(tx => tx.list('signal.retired-sends')), plaintext: await f.alice.transact(tx => tx.list('messages.plaintext')) };
  });
  expect(patches).toBe(0); expect(failed.unchanged).toBe(true); expect(failed.retired).toEqual([]); expect(failed.plaintext).toHaveLength(1);
  expect(failed.snapshot.mutations[0]).toMatchObject({ status: 'failed', draft: { content: 'Must survive quota failure' } });
  expect(failed.snapshot.mutations[0].prepared).toBeUndefined();
  await page.evaluate(async () => { const f = window.mutationTest; const row = (await f.service.snapshot()).mutations[0]; await f.service.retry(row.id, row.revision); await f.service.drain(); });
  expect(patches).toBe(1);
});

test('delivered deletion retires a dependent send and resolves its receipt after reload', async ({ page }) => {
  let deleted = false; let deletes = 0; const nonces: string[] = [];
  await page.route('**/api/v1/channels/dm/messages/100/deletions/*/resolve', async route => {
    const nonce = route.request().url().split('/').at(-2)!; nonces.push(nonce);
    await route.fulfill({ status: 200, json: { channel_id: 'dm', message_id: '100', actor_id: 'alice', delete_nonce: nonce, state: deleted ? 'deleted' : 'pending' } });
  });
  await page.route('**/api/v1/channels/dm/messages/100', async route => {
    expect(route.request().method()).toBe('DELETE'); deletes++; deleted = true; await route.abort('connectionreset');
  });
  await setup(page);
  const first = await page.evaluate(async () => {
    const f = window.mutationTest; const original = await f.aliceDm.prepare('dm', f.bobPeer, 'Initial');
    await f.alice.transact(async tx => tx.remove('messages.outbox', original.id));
    await f.aliceDm.prepare('dm', f.bobPeer, 'Dependent follower');
    await f.service.delete(f.target, null); await f.service.drain();
    return { rows: await f.queuedList(f.alice), mutation: (await f.service.snapshot()).mutations[0] };
  });
  expect(first.rows[0]).not.toHaveProperty('serializedRequest'); expect(first.mutation.deletionPrepared).toBe(true);
  await setup(page, false);
  const restored = await page.evaluate(async () => { const f = window.mutationTest; f.setMutationNow(11_001); await f.service.drain(); return f.service.snapshot(); });
  expect(deletes).toBe(1); expect(nonces).toHaveLength(2); expect(nonces[0]).toBe(nonces[1]);
  expect(restored.mutations).toEqual([]); expect(restored.receipts[0].result).toEqual({ kind: 'deleted' });
});

test('two tabs editing the same delivered message serialize preparation and PATCH under the account delivery lock', async ({ page, context }) => {
  let patches = 0; let active = 0; let maximum = 0;
  await context.route('**/api/v1/channels/dm/messages/100', async route => {
    active++; maximum = Math.max(maximum, active); patches++;
    await new Promise(resolve => setTimeout(resolve, 40));
    await route.fulfill({ status: 200, json: editMessage(route.request().postData()!) }); active--;
  });
  await setup(page); await page.evaluate(async () => { const f = window.mutationTest; await f.service.edit(f.target, 'One coordinated edit', null); });
  const second = await context.newPage(); await setup(second, false);
  await Promise.all([page.evaluate(() => window.mutationTest.service.drain()), second.evaluate(() => window.mutationTest.service.drain())]);
  expect(patches).toBe(1); expect(maximum).toBe(1);
});

for (const kind of ['edit', 'delete'] as const) test(`delivered ${kind} retains an attempted dependent follower without mutating keys or issuing HTTP`, async ({ page }) => {
  let requests = 0;
  await page.route('**/api/v1/channels/dm/messages/100**', route => { requests++; return route.abort(); });
  await setup(page);
  const result = await page.evaluate(async kind => {
    const f = window.mutationTest; const original = await f.aliceDm.prepare('dm', f.bobPeer, 'Initial');
    await f.alice.transact(async tx => tx.remove('messages.outbox', original.id));
    const follower = await f.aliceDm.prepare('dm', f.bobPeer, 'Attempted dependent');
    await f.alice.transact(async tx => tx.put('messages.outbox', follower.id, { ...follower, attempts: 1 }));
    const before = JSON.stringify(await f.alice.transact(tx => tx.list('signal.sessions')));
    if (kind === 'edit') await f.service.edit(f.target, 'Changed initial', null); else await f.service.delete(f.target, null);
    await f.service.drain();
    return { mutation: (await f.service.snapshot()).mutations[0], follower: (await f.queuedList(f.alice))[0],
      sameSession: before === JSON.stringify(await f.alice.transact(tx => tx.list('signal.sessions'))),
      retired: await f.alice.transact(tx => tx.list('signal.retired-sends')), originalBody: follower.serializedRequest };
  }, kind);
  expect(requests).toBe(0); expect(result.sameSession).toBe(true); expect(result.retired).toEqual([]);
  expect(result.mutation).toMatchObject({ status: 'failed', error: expect.stringContaining('attempted message') });
  expect(result.follower).toMatchObject({ attempts: 1, serializedRequest: result.originalBody });
});
