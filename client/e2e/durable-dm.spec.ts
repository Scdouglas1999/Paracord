import { expect, test, type Page } from '@playwright/test';
import type { AccountVault } from '../src/lib/crypto/accountVault';
import type { createDurableDm } from '../src/lib/messages/durableDm';
import type { listDurableSends } from '../src/lib/messages/durableOutbox';
import type { MessageE2eePayload } from '../src/types';

declare global {
  interface Window {
    dmTest: {
      alice: AccountVault; bob: AccountVault;
      aliceDm: ReturnType<typeof createDurableDm>; bobDm: ReturnType<typeof createDurableDm>;
      alicePeer: { id: string; publicKey: string }; bobPeer: { id: string; publicKey: string };
      list: typeof listDurableSends; bundleCalls: () => number;
    };
  }
}

async function setup(page: Page, initialize: boolean, lastResort = false) {
  await page.route('**/__durable_dm_test__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Durable DM test</title>' }));
  await page.goto('/__durable_dm_test__');
  await page.evaluate(async ({ initialize, lastResort }) => {
    const fixturePath = '/e2e/fixtures/durableDm.ts';
    const { initializeDmFixture } = await import(fixturePath);
    window.dmTest = await initializeDmFixture(initialize, 'server', lastResort);
  }, { initialize, lastResort });
}

test('external deletion retires a generation and restores unattempted followers before fresh encryption', async ({ page }) => {
  await setup(page, true);
  const result = await page.evaluate(async () => {
    const { alice, aliceDm, bobDm, alicePeer, bobPeer } = window.dmTest;
    const starter = await aliceDm.prepare('dm', bobPeer, 'Deleted generation starter');
    await alice.transact(async tx => tx.remove('messages.outbox', starter.id));
    const follower = await aliceDm.prepare('dm', bobPeer, 'Retained follower');
    await aliceDm.markExternalRemoval('dm'); await aliceDm.reconcileExternalRemoval('dm', bobPeer);
    const restored = await alice.transact(tx => tx.list<import('../src/lib/messages/durableOutbox').DurableIntent>('messages.intents'));
    const payload = await alice.transact(tx => aliceDm.prepareIntent(tx, restored[0].value));
    return { follower, restored, received: await bobDm.decrypt('dm', alicePeer, payload.e2ee!, '101'), header: JSON.parse(payload.e2ee!.header!) };
  });
  expect(result.restored).toHaveLength(1); expect(result.restored[0].value.nonce).toBe(result.follower.nonce);
  expect(result.received).toBe('Retained follower'); expect(result.header.n).toBe(0);
});

test('external deletion holds attempted dependent bytes and its recovery guard across reload', async ({ page }) => {
  await setup(page, true);
  const before = await page.evaluate(async () => {
    const { alice, aliceDm, bobPeer } = window.dmTest;
    const starter = await aliceDm.prepare('dm', bobPeer, 'Deleted starter');
    await alice.transact(async tx => tx.remove('messages.outbox', starter.id));
    const follower = await aliceDm.prepare('dm', bobPeer, 'Possibly already delivered');
    await alice.transact(async tx => tx.put('messages.outbox', follower.id, { ...follower, attempts: 1 }));
    await aliceDm.markExternalRemoval('dm');
    let error = ''; try { await aliceDm.reconcileExternalRemoval('dm', bobPeer); } catch (caught) { error = String(caught); }
    return { bytes: follower.serializedRequest, error };
  });
  expect(before.error).toContain('attempted message');
  await setup(page, false);
  const after = await page.evaluate(async () => {
    const { alice, aliceDm, list } = window.dmTest;
    let error = ''; try { await aliceDm.assertPreparedDeliveryAllowed('dm'); } catch (caught) { error = String(caught); }
    return { queued: await list(alice), error };
  });
  expect(after.queued[0].serializedRequest).toBe(before.bytes); expect(after.error).toContain('Resolve attempted queued messages');
});

test('fresh identities exchange encrypted DMs and replay exact requests after reload', async ({ page }) => {
  await setup(page, true);
  const first = await page.evaluate(async () => {
    const { aliceDm, bobDm, alicePeer, bobPeer } = window.dmTest;
    const send = await aliceDm.prepare('dm', bobPeer, 'First private message', 'original-reference');
    const request = JSON.parse(send.serializedRequest);
    const received = await bobDm.decrypt('dm', alicePeer, request.e2ee, '100');
    return { send, received };
  });
  expect(first.received).toBe('First private message');
  expect(first.send.serializedRequest).not.toContain('First private message');
  expect(JSON.parse(first.send.serializedRequest)).toMatchObject({ content: '', nonce: first.send.nonce, referenced_message_id: 'original-reference', e2ee: { version: 2 } });
  await setup(page, false);
  const afterReload = await page.evaluate(async payload => {
    const { alice, aliceDm, bobDm, alicePeer, bobPeer, list } = window.dmTest;
    const queued = await list(alice);
    const ownHistory = await aliceDm.decrypt('dm', bobPeer, payload, '100');
    const peerHistory = await bobDm.decrypt('dm', alicePeer, payload, '100');
    const reply = await bobDm.prepare('dm', alicePeer, 'Reply after reload');
    const replyBody = JSON.parse(reply.serializedRequest);
    const receivedReply = await aliceDm.decrypt('dm', bobPeer, replyBody.e2ee, '101');
    return { queued, ownHistory, peerHistory, receivedReply };
  }, JSON.parse(first.send.serializedRequest).e2ee as MessageE2eePayload);
  expect(afterReload.queued).toEqual([first.send]);
  expect(afterReload.ownHistory).toBe('First private message');
  expect(afterReload.peerHistory).toBe('First private message');
  expect(afterReload.receivedReply).toBe('Reply after reload');
});

test('failed outbox persistence rolls back the real ratchet and pins before retry', async ({ page }) => {
  await setup(page, true);
  const result = await page.evaluate(async () => {
    const { alice, aliceDm, bobDm, alicePeer, bobPeer, list, bundleCalls } = window.dmTest;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (value?.address?.[2] === 'messages.outbox') throw new DOMException('Outbox quota exhausted', 'QuotaExceededError');
      return put.call(this, value, key);
    };
    let failure = '';
    try { await aliceDm.prepare('dm', bobPeer, 'Keep this draft'); } catch (error) { failure = String(error); }
    finally { IDBObjectStore.prototype.put = put; }
    const remaining = await alice.transact(async tx => ({ sessions: await tx.list('signal.sessions'), pins: await tx.list('signal.identity-pins'), plaintext: await tx.list('messages.plaintext') }));
    const beforeRetry = await list(alice);
    const send = await aliceDm.prepare('dm', bobPeer, 'Keep this draft');
    const body = JSON.parse(send.serializedRequest);
    const received = await bobDm.decrypt('dm', alicePeer, body.e2ee, '100');
    return { failure, remaining, beforeRetry, received, sequence: send.sequence, header: JSON.parse(body.e2ee.header), bundleCalls: bundleCalls() };
  });
  expect(result.failure).toContain('Outbox quota exhausted');
  expect(result.remaining).toEqual({ sessions: [], pins: [], plaintext: [] });
  expect(result.beforeRetry).toEqual([]);
  expect(result.received).toBe('Keep this draft');
  expect(result.sequence).toBe(1);
  expect(result.header.n).toBe(0);
  expect(result.bundleCalls).toBe(2);
});

test('concurrent preparation keeps all 105 sends and advances one ratchet in queue order', async ({ page }) => {
  await setup(page, true);
  const result = await page.evaluate(async () => {
    const { alice, aliceDm, bobDm, alicePeer, bobPeer, list, bundleCalls } = window.dmTest;
    await Promise.all(Array.from({ length: 105 }, (_, index) => aliceDm.prepare('dm', bobPeer, `Message ${index}`)));
    const queued = await list(alice);
    const counters = queued.map(send => JSON.parse(JSON.parse(send.serializedRequest).e2ee.header).n);
    const received = [];
    for (const send of queued) received.push(await bobDm.decrypt('dm', alicePeer, JSON.parse(send.serializedRequest).e2ee, String(send.sequence)));
    return { sequences: queued.map(send => send.sequence), counters, received, bundleCalls: bundleCalls() };
  });
  expect(result.sequences).toEqual(Array.from({ length: 105 }, (_, index) => index + 1));
  expect(result.counters).toEqual(Array.from({ length: 105 }, (_, index) => index));
  expect(result.received).toEqual(Array.from({ length: 105 }, (_, index) => `Message ${index}`));
  expect(result.bundleCalls).toBe(1);
});

test('separate conversations with the same identity pair keep independent ratchets', async ({ page }) => {
  await setup(page, true);
  const result = await page.evaluate(async () => {
    const { aliceDm, bobDm, alicePeer, bobPeer, bundleCalls } = window.dmTest;
    const sent = [];
    for (const [channel, content] of [['first', 'First conversation'], ['second', 'Second conversation'], ['first', 'First again']]) {
      const send = await aliceDm.prepare(channel, bobPeer, content);
      const body = JSON.parse(send.serializedRequest);
      sent.push({ channel, counter: JSON.parse(body.e2ee.header).n, content: await bobDm.decrypt(channel, alicePeer, body.e2ee, '100') });
    }
    return { sent, bundleCalls: bundleCalls() };
  });
  expect(result).toEqual({ bundleCalls: 2, sent: [
    { channel: 'first', counter: 0, content: 'First conversation' },
    { channel: 'second', counter: 0, content: 'Second conversation' },
    { channel: 'first', counter: 1, content: 'First again' },
  ] });
});

test('a delayed initial message decrypts with its archived signed key after rotation and reload', async ({ page }) => {
  await setup(page, true);
  const payload = await page.evaluate(async () => {
    const { aliceDm, bobPeer, bob } = window.dmTest;
    const send = await aliceDm.prepare('delayed', bobPeer, 'Sent before signed-key rotation');
    const path = '/src/lib/crypto/sessionManager.ts';
    const vaultPath = '/src/lib/crypto/signalVault.ts';
    const { generatePrekeyBundle } = await import(path);
    const { readSignalPrekeys, writeSignalPrekeys } = await import(vaultPath);
    await bob.transact(async tx => {
      const store = await readSignalPrekeys(tx);
      const replacement = generatePrekeyBundle(new Uint8Array(32).fill(22)).signedPrekey;
      replacement.id = store.nextOPKId + 100;
      writeSignalPrekeys(tx, { ...store, signedPrekey: replacement, signedPrekeyArchive: [store.signedPrekey] });
    });
    return JSON.parse(send.serializedRequest).e2ee as MessageE2eePayload;
  });
  await setup(page, false);
  const received = await page.evaluate(async payload => {
    const { bobDm, alicePeer } = window.dmTest;
    const wrong = { ...payload, header: JSON.stringify({ ...JSON.parse(payload.header!), spk_id: 1 }) };
    let error = '';
    try { await bobDm.decrypt('delayed', alicePeer, wrong, '100'); } catch (failure) { error = String(failure); }
    return { error, plaintext: await bobDm.decrypt('delayed', alicePeer, payload, '100') };
  }, payload);
  // Named for what it is — a key this device never held — so the runtime can
  // tell it apart from a ciphertext that failed authentication.
  expect(received.error).toContain('MissingPrivatePrekeyError');
  expect(received.error).toContain('never held');
  expect(received.plaintext).toBe('Sent before signed-key rotation');
});

test('simultaneous initiations retain both ratchets through queued messages and reload', async ({ page }) => {
  await setup(page, true);
  const queued = await page.evaluate(async () => {
    const { aliceDm, bobDm, alicePeer, bobPeer } = window.dmTest;
    const aliceFirst = await aliceDm.prepare('simultaneous', bobPeer, 'Alice first');
    const bobFirst = await bobDm.prepare('simultaneous', alicePeer, 'Bob first');
    const aliceNext = await aliceDm.prepare('simultaneous', bobPeer, 'Alice queued');
    const bobNext = await bobDm.prepare('simultaneous', alicePeer, 'Bob queued');
    const a = await aliceDm.decrypt('simultaneous', bobPeer, JSON.parse(bobFirst.serializedRequest).e2ee, '102');
    const b = await bobDm.decrypt('simultaneous', alicePeer, JSON.parse(aliceFirst.serializedRequest).e2ee, '101');
    return { a, b, aliceNext, bobNext };
  });
  expect([queued.a, queued.b]).toEqual(['Bob first', 'Alice first']);
  await setup(page, false);
  const result = await page.evaluate(async ({ aliceNext, bobNext }) => {
    const { aliceDm, bobDm, alicePeer, bobPeer } = window.dmTest;
    const a = await aliceDm.decrypt('simultaneous', bobPeer, JSON.parse(bobNext.serializedRequest).e2ee, '104');
    const b = await bobDm.decrypt('simultaneous', alicePeer, JSON.parse(aliceNext.serializedRequest).e2ee, '103');
    const ar = await aliceDm.prepare('simultaneous', bobPeer, 'Alice reply');
    const br = await bobDm.prepare('simultaneous', alicePeer, 'Bob reply');
    const replyToAlice = await aliceDm.decrypt('simultaneous', bobPeer, JSON.parse(br.serializedRequest).e2ee, '106');
    const replyToBob = await bobDm.decrypt('simultaneous', alicePeer, JSON.parse(ar.serializedRequest).e2ee, '105');
    return [a, b, replyToAlice, replyToBob];
  }, queued);
  expect(result).toEqual(['Bob queued', 'Alice queued', 'Bob reply', 'Alice reply']);
});

test('uncached older history cannot select a retired generation for replies', async ({ page }) => {
  await setup(page, true);
  const payloads = await page.evaluate(async () => {
    const { alice, bob, aliceDm, bobDm, alicePeer, bobPeer } = window.dmTest;
    const oldFirst = await aliceDm.prepare('history', bobPeer, 'Old first');
    const oldNext = await aliceDm.prepare('history', bobPeer, 'Old next');
    // Simulate an Alice reinstall losing only its conversation state. Bob still
    // has the private prekeys needed by the old messages, which arrive later.
    await alice.transact(async tx => {
      const entries = await tx.list<{ activeId: string }>('signal.sessions');
      for (const entry of entries) {
        for (const generation of await tx.list(`signal.sessions:${entry.id}`)) tx.remove(`signal.sessions:${entry.id}`, generation.id);
        tx.remove('signal.sessions', entry.id);
      }
    });
    const currentFirst = await aliceDm.prepare('history', bobPeer, 'Current first');
    const current = await bobDm.decrypt('history', alicePeer, JSON.parse(currentFirst.serializedRequest).e2ee, '9007199254741002');
    const before = await bob.transact(tx => tx.list('signal.sessions'));
    const old = await bobDm.decrypt('history', alicePeer, JSON.parse(oldFirst.serializedRequest).e2ee, '9007199254741000');
    const after = await bob.transact(tx => tx.list('signal.sessions'));
    return { current, old, before, after, oldNext };
  });
  expect([payloads.current, payloads.old]).toEqual(['Current first', 'Old first']);
  expect(payloads.after).toEqual(payloads.before);
  await setup(page, false);
  const result = await page.evaluate(async oldNext => {
    const { aliceDm, bobDm, alicePeer, bobPeer } = window.dmTest;
    const old = await bobDm.decrypt('history', alicePeer, JSON.parse(oldNext.serializedRequest).e2ee, '9007199254741001');
    const reply = await bobDm.prepare('history', alicePeer, 'Reply on the current session');
    return { old, reply: await aliceDm.decrypt('history', bobPeer, JSON.parse(reply.serializedRequest).e2ee, '9007199254741003') };
  }, payloads.oldNext);
  expect(result).toEqual({ old: 'Old next', reply: 'Reply on the current session' });
});

test('an acknowledged local send advances generation ordering before delayed older history arrives', async ({ page }) => {
  await setup(page, true);
  const result = await page.evaluate(async () => {
    const { aliceDm, bobDm, alicePeer, bobPeer, bob } = window.dmTest;
    const oldFirst = await aliceDm.prepare('history-ack', bobPeer, 'Old first');
    const oldNext = await aliceDm.prepare('history-ack', bobPeer, 'Delayed old next');
    await bobDm.decrypt('history-ack', alicePeer, JSON.parse(oldFirst.serializedRequest).e2ee, '100');
    await bob.transact(tx => bobDm.retireDeliveredMessage(tx, 'history-ack', alicePeer));
    const current = await bobDm.prepare('history-ack', alicePeer, 'Current acknowledged generation');
    await bob.transact(tx => bobDm.acknowledgeSend(tx, current.nonce, { id: '200', nonce: current.nonce, channel_id: current.channelId, author: { id: 'bob' } } as never));
    const before = await bob.transact(tx => tx.list('signal.sessions'));
    const delayed = await bobDm.decrypt('history-ack', alicePeer, JSON.parse(oldNext.serializedRequest).e2ee, '150');
    const after = await bob.transact(tx => tx.list('signal.sessions'));
    const received = await aliceDm.decrypt('history-ack', bobPeer, JSON.parse(current.serializedRequest).e2ee, '200');
    return { before, after, delayed, received };
  });
  expect(result.after).toEqual(result.before); expect(result.delayed).toBe('Delayed old next');
  expect(result.received).toBe('Current acknowledged generation');
});

test('failed incoming generation persistence preserves prekeys and the active session', async ({ page }) => {
  await setup(page, true);
  const result = await page.evaluate(async () => {
    const { aliceDm, bobDm, alicePeer, bobPeer, bob } = window.dmTest;
    const send = await aliceDm.prepare('commit', bobPeer, 'Receive atomically');
    const payload = JSON.parse(send.serializedRequest).e2ee;
    const before = await bob.transact(tx => tx.get('signal.prekeys', 'current'));
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (String(value?.address?.[2]).startsWith('signal.sessions:')) throw new DOMException('Session quota exhausted', 'QuotaExceededError');
      return put.call(this, value, key);
    };
    let failure = '';
    try { await bobDm.decrypt('commit', alicePeer, payload, '100'); } catch (error) { failure = String(error); }
    finally { IDBObjectStore.prototype.put = put; }
    const after = await bob.transact(async tx => ({ prekeys: await tx.get('signal.prekeys', 'current'), sessions: await tx.list('signal.sessions'), plaintext: await tx.list('messages.plaintext') }));
    const retried = await bobDm.decrypt('commit', alicePeer, payload, '100');
    return { failure, unchanged: JSON.stringify(before) === JSON.stringify(after.prekeys), sessions: after.sessions, plaintext: after.plaintext, retried };
  });
  expect(result).toEqual({ failure: 'QuotaExceededError: Session quota exhausted', unchanged: true, sessions: [], plaintext: [], retried: 'Receive atomically' });
});

test('a replay with changed X3DH extensions cannot restart a last-resort session', async ({ page }) => {
  await setup(page, true, true);
  const result = await page.evaluate(async () => {
    const { aliceDm, bobDm, alicePeer, bobPeer, bob } = window.dmTest;
    const first = await aliceDm.prepare('replay', bobPeer, 'Original initial');
    const payload = JSON.parse(first.serializedRequest).e2ee;
    await bobDm.decrypt('replay', alicePeer, payload, '100');
    const reply = await bobDm.prepare('replay', alicePeer, 'Ratchet reply');
    await aliceDm.decrypt('replay', bobPeer, JSON.parse(reply.serializedRequest).e2ee, '101');
    const before = await bob.transact(tx => tx.list('signal.sessions'));
    // Unknown extension fields and noncanonical base64 do not change v2 AEAD
    // authentication. They do change the whole-envelope plaintext cache key.
    const replay = { ...payload, nonce: ` ${payload.nonce}`, header: JSON.stringify({ ...JSON.parse(payload.header), ignored: true }) };
    let failure = '';
    try { await bobDm.decrypt('replay', alicePeer, replay, '900'); } catch (error) { failure = String(error); }
    const after = await bob.transact(tx => tx.list('signal.sessions'));
    const next = await aliceDm.prepare('replay', bobPeer, 'Still current');
    const received = await bobDm.decrypt('replay', alicePeer, JSON.parse(next.serializedRequest).e2ee, '102');
    return { failure, before, after, received };
  });
  expect(result.failure).toContain('already authenticated');
  expect(result.after).toEqual(result.before);
  expect(result.received).toBe('Still current');
});

test('an existing account-owned ratchet upgrades without reenrollment or counter reuse', async ({ page }) => {
  await setup(page, true);
  await page.evaluate(async () => {
    const { alice, aliceDm, bobDm, alicePeer, bobPeer } = window.dmTest;
    const first = await aliceDm.prepare('upgrade', bobPeer, 'Before upgrade');
    await bobDm.decrypt('upgrade', alicePeer, JSON.parse(first.serializedRequest).e2ee, '100');
    // Recreate the previously supported account-owned single-ratchet format.
    // No global secure-storage ownership is implied by this fixture.
    await alice.transact(async tx => {
      const [entry] = await tx.list<{ activeId: string }>('signal.sessions');
      const state = await tx.get(`signal.sessions:${entry.id}`, entry.value.activeId);
      tx.put('signal.sessions', entry.id, state);
      tx.remove(`signal.sessions:${entry.id}`, entry.value.activeId);
    });
  });
  await setup(page, false);
  const result = await page.evaluate(async () => {
    const { aliceDm, bobDm, alicePeer, bobPeer } = window.dmTest;
    const send = await aliceDm.prepare('upgrade', bobPeer, 'After upgrade');
    const payload = JSON.parse(send.serializedRequest).e2ee;
    return { header: JSON.parse(payload.header), plaintext: await bobDm.decrypt('upgrade', alicePeer, payload, '101') };
  });
  expect(result.header.n).toBe(1);
  expect(result.header.ik).toBeUndefined();
  expect(result.plaintext).toBe('After upgrade');
});

test('a missing active ratchet fails closed without fetching another bundle', async ({ page }) => {
  await setup(page, true);
  const result = await page.evaluate(async () => {
    const { alice, aliceDm, bobDm, alicePeer, bobPeer, bundleCalls } = window.dmTest;
    const first = await aliceDm.prepare('missing', bobPeer, 'First');
    await bobDm.decrypt('missing', alicePeer, JSON.parse(first.serializedRequest).e2ee, '100');
    const reply = await bobDm.prepare('missing', alicePeer, 'Reply');
    await alice.transact(async tx => {
      const [entry] = await tx.list<{ activeId: string }>('signal.sessions');
      tx.remove(`signal.sessions:${entry.id}`, entry.value.activeId);
    });
    const failures = [];
    try { await aliceDm.prepare('missing', bobPeer, 'Keep draft'); } catch (error) { failures.push(String(error)); }
    try { await aliceDm.decrypt('missing', bobPeer, JSON.parse(reply.serializedRequest).e2ee, '101'); } catch (error) { failures.push(String(error)); }
    return { failures, bundles: bundleCalls() };
  });
  expect(result.failures).toHaveLength(2);
  expect(result.failures.every(failure => failure.includes('active encrypted DM session is missing'))).toBe(true);
  expect(result.bundles).toBe(1);
});
