import { AxiosHeaders } from 'axios';
import { ed25519 } from '@noble/curves/ed25519.js';
import { AccountVault } from '../../src/lib/crypto/accountVault';
import { createDurableDm } from '../../src/lib/messages/durableDm';
import { listDurableSends } from '../../src/lib/messages/durableOutbox';
import { generatePrekeyBundle } from '../../src/lib/crypto/sessionManager';
import { writeSignalPrekeys, readSignalPrekeys } from '../../src/lib/crypto/signalVault';
import { bytesToHex, toBase64 } from '../../src/lib/crypto/util';
import type { DmCipherDependencies } from '../../src/lib/dmCipher';

export async function initializeDmFixture(initialize: boolean, serverId = 'server', lastResort = false, allowBundleFetch = initialize) {
  const aliceKey = new Uint8Array(32).fill(21); const bobKey = new Uint8Array(32).fill(22);
  const alicePeer = { id: 'alice', publicKey: bytesToHex(ed25519.getPublicKey(aliceKey)) };
  const bobPeer = { id: 'bob', publicKey: bytesToHex(ed25519.getPublicKey(bobKey)) };
  const lifetime = { signal: new AbortController().signal, assertCurrent() {} };
  const alice = await AccountVault.open({ serverId, userId: 'alice' }, aliceKey, lifetime);
  const bob = await AccountVault.open({ serverId, userId: 'bob' }, bobKey, lifetime);
  if (initialize) {
    await alice.transact(async tx => writeSignalPrekeys(tx, generatePrekeyBundle(aliceKey)));
    await bob.transact(async tx => writeSignalPrekeys(tx, generatePrekeyBundle(bobKey)));
  }
  const alicePrekeys = await alice.transact(readSignalPrekeys); const bobPrekeys = await bob.transact(readSignalPrekeys);
  let bundleCalls = 0;
  const keysApi: DmCipherDependencies['keysApi'] = { async getBundle(userId: string) {
    if (!allowBundleFetch) throw new Error('An existing conversation must not reinitialize after reload');
    const prekeys = userId === 'alice' ? alicePrekeys : bobPrekeys;
    if (!prekeys) throw new Error('The fixture identity has no published prekeys');
    const key = userId === 'alice' ? aliceKey : bobKey;
    const peer = userId === 'alice' ? alicePeer : bobPeer;
    const opk = lastResort ? prekeys.lastResortPrekey : prekeys.oneTimePrekeys[bundleCalls];
    bundleCalls++;
    if (!opk) throw new Error('No fixture one-time prekeys remain');
    return { data: {
      identity_key: peer.publicKey,
      signed_prekey: { id: prekeys.signedPrekey.id, public_key: toBase64(prekeys.signedPrekey.publicKey), signature: toBase64(ed25519.sign(prekeys.signedPrekey.publicKey, key)) },
      one_time_prekey: { id: opk.id, public_key: toBase64(opk.publicKey) },
    }, status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
  } };
  return { alice, bob, alicePeer, bobPeer, aliceDm: createDurableDm(alice, aliceKey, keysApi), bobDm: createDurableDm(bob, bobKey, keysApi), list: listDurableSends, bundleCalls: () => bundleCalls };
}
