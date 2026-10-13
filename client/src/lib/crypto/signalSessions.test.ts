import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import type { VaultTransaction } from './accountVault';
import { createSignalSessionCipher } from './signalSessions';
import { generatePrekeyBundle } from './sessionManager';
import { writeSignalPrekeys } from './signalVault';
import type { LocalPrekeyStore } from './types';
import { bytesToHex, toBase64 } from './util';
import type { PrekeyBundleResponse } from '../../api/keys';
import type { MessageE2eePayload } from '../../types';

const CHANNEL = '900';

/** One device's encrypted store: a plain map that keeps every write. */
function deviceStore(): VaultTransaction {
  const rows = new Map<string, unknown>();
  const key = (namespace: string, id: string) => JSON.stringify([namespace, id]);
  return {
    get: async <T>(namespace: string, id: string) => (rows.get(key(namespace, id)) as T | undefined) ?? null,
    list: async <T>(namespace: string) => [...rows].flatMap(([address, value]) => {
      const [ns, id] = JSON.parse(address) as [string, string];
      return ns === namespace ? [{ id, value: structuredClone(value) as T }] : [];
    }),
    put: (namespace, id, value) => { rows.set(key(namespace, id), structuredClone(value)); },
    remove: (namespace, id) => { rows.delete(key(namespace, id)); },
  };
}

/** The server's single published bundle per account, with its generation. */
function publishedBundle(privateKey: Uint8Array, store: LocalPrekeyStore, generation: string | null) {
  let next = 0;
  return {
    generation,
    response(): PrekeyBundleResponse {
      const opk = store.oneTimePrekeys[next++];
      return {
        identity_key: bytesToHex(ed25519.getPublicKey(privateKey)),
        signed_prekey: {
          id: store.signedPrekey.id,
          public_key: toBase64(store.signedPrekey.publicKey),
          signature: toBase64(ed25519.sign(store.signedPrekey.publicKey, privateKey)),
        },
        one_time_prekey: opk ? { id: opk.id, public_key: toBase64(opk.publicKey) } : null,
        prekey_generation: generation,
      };
    },
  };
}

function account(userId: string) {
  const privateKey = ed25519.utils.randomSecretKey();
  return { userId, privateKey, publicKey: bytesToHex(ed25519.getPublicKey(privateKey)) };
}
type Account = ReturnType<typeof account>;

/** A device of `owner`, holding its own prekey store and ratchets. */
function device(owner: Account) {
  const tx = deviceStore();
  const prekeys = generatePrekeyBundle(owner.privateKey);
  writeSignalPrekeys(tx, prekeys);
  return { owner, tx, prekeys };
}
type Device = ReturnType<typeof device>;

/** Directory of every account's currently published bundle. */
function server() {
  const published = new Map<string, ReturnType<typeof publishedBundle>>();
  let fetches = 0;
  return {
    publish(from: Device, generation: string | null) { published.set(from.owner.userId, publishedBundle(from.owner.privateKey, from.prekeys, generation)); },
    generation(userId: string) { return published.get(userId)?.generation ?? null; },
    get fetches() { return fetches; },
    keysApi: {
      async getBundle(userId: string) {
        fetches++;
        const bundle = published.get(userId);
        if (!bundle) throw new Error('no bundle');
        return { data: bundle.response() } as Awaited<ReturnType<typeof import('../../api/keys').keysApi.getBundle>>;
      },
    },
  };
}
type Server = ReturnType<typeof server>;

async function send(net: Server, from: Device, to: Account, text: string, generation: string | null | undefined) {
  const cipher = createSignalSessionCipher(from.tx, CHANNEL, net.keysApi);
  const { payload } = await cipher.encryptDmMessageWithSession(CHANNEL, text, from.owner.privateKey, to.publicKey, to.userId,
    generation === undefined ? {} : { peerPrekeyGeneration: generation });
  return payload;
}
function startsSession(payload: MessageE2eePayload) { return 'ek' in JSON.parse(payload.header!); }
async function read(net: Server, at: Device, from: Account, payload: MessageE2eePayload, messageId: string) {
  return createSignalSessionCipher(at.tx, CHANNEL, net.keysApi)
    .decryptDmMessage(CHANNEL, payload, at.owner.privateKey, from.publicKey, from.userId, messageId);
}

/**
 * Sam talks to Friend's first computer, then Friend signs in on a second one
 * and publishes its keys (the server advances Friend's prekey generation).
 */
async function establishedConversation() {
  const net = server();
  const sam = account('101'); const friend = account('202');
  const samDevice = device(sam); const friendOld = device(friend);
  net.publish(samDevice, '1000'); net.publish(friendOld, '1001');
  const first = await send(net, samDevice, friend, 'hello', net.generation(friend.userId));
  expect(startsSession(first)).toBe(true);
  expect(await read(net, friendOld, sam, first, '2000')).toBe('hello');
  const reply = await send(net, friendOld, sam, 'hi back', net.generation(sam.userId));
  expect(await read(net, samDevice, friend, reply, '2001')).toBe('hi back');
  const ongoing = await send(net, samDevice, friend, 'still here', net.generation(friend.userId));
  expect(startsSession(ongoing)).toBe(false);
  expect(await read(net, friendOld, sam, ongoing, '2002')).toBe('still here');
  return { net, sam, friend, samDevice, friendOld };
}

describe('a DM follows the recipient to the device that holds their current keys', () => {
  it('the next send after a new device publishes reaches it, without the new device sending first', async () => {
    const { net, sam, friend, samDevice, friendOld } = await establishedConversation();
    const friendNew = device(friend);
    net.publish(friendNew, '3000');

    const next = await send(net, samDevice, friend, 'spruce-otter', net.generation(friend.userId));
    expect(startsSession(next)).toBe(true);
    expect(await read(net, friendNew, sam, next, '3001')).toBe('spruce-otter');
    // The old computer no longer holds the published keys; by design it
    // cannot open conversations started after the new device took over.
    await expect(read(net, friendOld, sam, next, '3001')).rejects.toThrow();

    // One fresh session, then the ordinary ratchet: no X3DH per message.
    const fetches = net.fetches;
    const after = await send(net, samDevice, friend, 'and again', net.generation(friend.userId));
    expect(startsSession(after)).toBe(false);
    expect(net.fetches).toBe(fetches);
    expect(await read(net, friendNew, sam, after, '3002')).toBe('and again');

    // The ratchet continues both ways with the new device.
    const answer = await send(net, friendNew, sam, 'got both', net.generation(sam.userId));
    expect(await read(net, samDevice, friend, answer, '3003')).toBe('got both');
    const back = await send(net, samDevice, friend, 'great', net.generation(friend.userId));
    expect(startsSession(back)).toBe(false);
    expect(await read(net, friendNew, sam, back, '3004')).toBe('great');
  });

  it('keeps the session the new device started after publishing', async () => {
    const { net, sam, friend, samDevice } = await establishedConversation();
    const friendNew = device(friend);
    net.publish(friendNew, '3000');
    const opener = await send(net, friendNew, sam, 'new computer here', net.generation(sam.userId));
    expect(startsSession(opener)).toBe(true);
    expect(await read(net, samDevice, friend, opener, '3001')).toBe('new computer here');

    const fetches = net.fetches;
    const reply = await send(net, samDevice, friend, 'welcome', net.generation(friend.userId));
    expect(startsSession(reply)).toBe(false);
    expect(net.fetches).toBe(fetches);
    expect(await read(net, friendNew, sam, reply, '3002')).toBe('welcome');
  });

  it('does not answer on a session the old device started before the keys moved', async () => {
    const net = server();
    const sam = account('101'); const friend = account('202');
    const samDevice = device(sam); const friendOld = device(friend);
    net.publish(samDevice, '1000'); net.publish(friendOld, '1001');
    // Delivered late: the old computer's opener was accepted before the new
    // computer published, and Sam reads it only afterwards.
    const opener = await send(net, friendOld, sam, 'from the old computer', net.generation(sam.userId));
    const friendNew = device(friend);
    net.publish(friendNew, '3000');
    expect(await read(net, samDevice, friend, opener, '2000')).toBe('from the old computer');

    const reply = await send(net, samDevice, friend, 'reply', net.generation(friend.userId));
    expect(startsSession(reply)).toBe(true);
    expect(await read(net, friendNew, sam, reply, '3001')).toBe('reply');
  });

  it('changes nothing when the server names no generation', async () => {
    const { net, sam, friend, samDevice, friendOld } = await establishedConversation();
    const legacy = await send(net, samDevice, friend, 'as before', undefined);
    expect(startsSession(legacy)).toBe(false);
    expect(await read(net, friendOld, sam, legacy, '2003')).toBe('as before');
    const unnamed = await send(net, samDevice, friend, 'still as before', null);
    expect(startsSession(unnamed)).toBe(false);
    expect(await read(net, friendOld, sam, unnamed, '2004')).toBe('still as before');
  });

  it('refuses a malformed generation instead of guessing', async () => {
    const { net, friend, samDevice } = await establishedConversation();
    await expect(send(net, samDevice, friend, 'x', 'not-a-snowflake')).rejects.toThrow(/invalid prekey generation/);
  });
});
