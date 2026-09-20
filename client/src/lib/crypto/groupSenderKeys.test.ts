import { beforeEach, describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import {
  buildSenderKeyEnvelopes,
  commitSenderKeys,
  ensureLocalSenderKey,
  GroupE2eeError,
  markDistributed,
  membershipFingerprint,
  openGroupMessage,
  pendingDistribution,
  readReceivedSenderKey,
  sealGroupMessage,
  verifySenderKeyEnvelopes,
  type GroupMember,
  type IncomingSenderKeyEnvelope,
  type LocalSenderKey,
} from './groupSenderKeys';
import { createIdentityTrustVault, installIdentityTrustVault, resetIdentityTrust } from '../../test/identityTrustVaultMock';
import { IdentityPinError } from '../keyVerification';
import { bytesToHex, fromBase64, toArrayBuffer, toBase64 } from './util';
import type { AccountVault, VaultTransaction } from './accountVault';

interface TestUser extends GroupMember {
  privateKey: Uint8Array;
}

function makeUser(id: string): TestUser {
  const privateKey = ed25519.utils.randomSecretKey();
  return { id, privateKey, publicKey: bytesToHex(ed25519.getPublicKey(privateKey)) };
}

/**
 * One device's world: its own account vault, and its own peer-trust vault.
 *
 * They are separate maps per account on purpose — that is the property the
 * previous implementation lacked. It kept one process-wide secure-storage slot,
 * so this separation existed only in its tests.
 */
function makeDevice(user: TestUser) {
  const records = new Map<string, unknown>();
  const { vault } = createIdentityTrustVault(records);
  return {
    user,
    records,
    vault: vault as AccountVault,
    activate() {
      resetIdentityTrust();
      // One vault per account, for peer trust *and* sender keys — which is what
      // the runtime registers, and therefore one exclusive lock over both.
      installIdentityTrustVault(records, user.id, vault as AccountVault);
    },
    transact<T>(run: (tx: VaultTransaction) => Promise<T>): Promise<T> {
      return vault.transact(run);
    },
  };
}

type Device = ReturnType<typeof makeDevice>;

/** The server's sender-key table, with the membership checks the routes make. */
function makeServer() {
  const rows: Array<IncomingSenderKeyEnvelope & { channel_id: string }> = [];
  return {
    rows,
    post(channelId: string, senderId: string, epoch: number, envelopes: Array<{ recipient_id: string; ciphertext: string; header: string }>) {
      for (const envelope of envelopes) {
        rows.push({ channel_id: channelId, sender_id: senderId, recipient_id: envelope.recipient_id, epoch, ciphertext: envelope.ciphertext, header: envelope.header });
      }
    },
    for(channelId: string, recipientId: string) {
      return rows.filter(row => row.channel_id === channelId && row.recipient_id === recipientId);
    },
  };
}

/** Mint, wrap and publish `sender`'s epoch for `members`, as the lane does. */
async function distribute(device: Device, server: ReturnType<typeof makeServer>, channelId: string, members: GroupMember[]): Promise<LocalSenderKey> {
  device.activate();
  const local = await device.transact(tx => ensureLocalSenderKey(tx, channelId, members, device.user.id));
  const pending = pendingDistribution(local, members, device.user.id);
  if (pending.length > 0) {
    const envelopes = await buildSenderKeyEnvelopes(channelId, local, device.user.id, device.user.privateKey, pending);
    server.post(channelId, device.user.id, local.epoch, envelopes);
    await device.transact(async tx => { markDistributed(tx, channelId, local, pending); });
  }
  return local;
}

async function receive(device: Device, server: ReturnType<typeof makeServer>, channelId: string, members: GroupMember[], directory: TestUser[]) {
  device.activate();
  const keys = new Map(directory.map(user => [user.id, user.publicKey]));
  // Verification runs with no transaction open — the pins it asserts live in
  // this same vault, behind the same exclusive lock.
  const outcome = await verifySenderKeyEnvelopes(
    channelId, server.for(channelId, device.user.id), device.user.id, device.user.privateKey,
    (id: string) => keys.get(id) ?? null, members,
  );
  if (outcome.adopted.length > 0) {
    await device.transact(async tx => { commitSenderKeys(tx, channelId, outcome.adopted); });
  }
  return outcome;
}

const channelId = '900000000000000001';

describe('group sender keys', () => {
  let alice: Device, bob: Device, carol: Device, server: ReturnType<typeof makeServer>;
  let members: GroupMember[];
  let directory: TestUser[];

  beforeEach(() => {
    resetIdentityTrust();
    alice = makeDevice(makeUser('alice'));
    bob = makeDevice(makeUser('bob'));
    carol = makeDevice(makeUser('carol'));
    directory = [alice.user, bob.user, carol.user];
    members = directory.map(user => ({ id: user.id, publicKey: user.publicKey }));
    server = makeServer();
  });

  async function aliceSays(text: string) {
    const local = await distribute(alice, server, channelId, members);
    return sealGroupMessage(channelId, text, alice.user.id, alice.user.privateKey, local);
  }

  it('carries a message from one member to the others', async () => {
    const payload = await aliceSays('hello group');
    for (const reader of [bob, carol]) {
      const { adopted } = await receive(reader, server, channelId, members, directory);
      expect(adopted).toHaveLength(1);
      const key = await reader.transact(tx => readReceivedSenderKey(tx, channelId, alice.user.id, 0));
      const opened = await openGroupMessage(channelId, payload, key!.key, alice.user.publicKey);
      expect(opened.content).toBe('hello group');
      expect(opened.senderId).toBe(alice.user.id);
    }
  });

  it('refuses a message one member forged under another member’s sender key', async () => {
    // Every member holds every other member's sender key, so AES-GCM alone
    // proves only that *somebody in the group* wrote this. Before the signature
    // Bob could re-encrypt under Alice's key, put her id in the header, and
    // Carol believed it.
    const payload = await aliceSays('alice speaking');
    await receive(bob, server, channelId, members, directory);
    const aliceKey = (await bob.transact(tx => readReceivedSenderKey(tx, channelId, alice.user.id, 0)))!;

    const header = JSON.parse(payload.header!);
    const canonical = JSON.stringify([header.kind, header.v, header.sender_id, header.epoch, header.members]);
    const key = await crypto.subtle.importKey('raw', toArrayBuffer(fromBase64(aliceKey.key)), { name: 'AES-GCM' }, false, ['encrypt']);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(utf8ToBytes(canonical)) },
      key, toArrayBuffer(utf8ToBytes('I never said this')),
    );
    // Bob signs with his own key, because Alice's is the one thing he lacks.
    const forged = {
      version: 3, nonce: toBase64(nonce), ciphertext: toBase64(new Uint8Array(ciphertext)),
      header: JSON.stringify({ ...header, sig: toBase64(ed25519.sign(new Uint8Array(32), bob.user.privateKey)) }),
    };

    await receive(carol, server, channelId, members, directory);
    await expect(openGroupMessage(channelId, forged, aliceKey.key, alice.user.publicKey))
      .rejects.toThrow('was not signed by the member it claims to be from');
  });

  it('refuses a message whose header was edited away from its body', async () => {
    const payload = await aliceSays('bound to its header');
    await receive(bob, server, channelId, members, directory);
    const aliceKey = (await bob.transact(tx => readReceivedSenderKey(tx, channelId, alice.user.id, 0)))!;
    const header = JSON.parse(payload.header!);

    // The authenticated header is the AEAD's AAD *and* inside the signature, so
    // neither an added field nor a changed epoch survives.
    for (const tampered of [{ ...header, injected: 'anything' }, { ...header, epoch: 7 }]) {
      await expect(openGroupMessage(channelId, { ...payload, header: JSON.stringify(tampered) }, aliceKey.key, alice.user.publicKey))
        .rejects.toThrow();
    }
    await expect(openGroupMessage(channelId, payload, aliceKey.key, alice.user.publicKey)).resolves.toMatchObject({ content: 'bound to its header' });
  });

  it('keeps each account’s keys in its own vault', async () => {
    await aliceSays('mine');
    await receive(bob, server, channelId, members, directory);

    // Alice's mint and Bob's adoption land in different backing stores, and
    // neither account can read the other's by construction: the vault addresses
    // every record under its own [serverId, userId].
    expect([...alice.records.keys()].some(key => key.includes('messages.group-sender-local'))).toBe(true);
    expect([...bob.records.keys()].some(key => key.includes('messages.group-sender-received'))).toBe(true);
    expect(await bob.transact(tx => tx.get('messages.group-sender-local', channelId))).toBeNull();
    expect(await alice.transact(tx => readReceivedSenderKey(tx, channelId, alice.user.id, 0))).toBeNull();
  });

  it('mints a new epoch when the membership changes', async () => {
    const first = await aliceSays('before dave');
    expect(first.header).toContain('"epoch":0');

    const dave = makeUser('dave');
    const widened = [...members, { id: dave.id, publicKey: dave.publicKey }];
    const second = await distribute(alice, server, channelId, widened);
    expect(second.epoch).toBe(1);
    expect(second.key).not.toBe((await alice.transact(tx => tx.get<LocalSenderKey>('messages.group-sender-local', channelId)))!.key === second.key ? '' : second.key);

    // Narrowing again is another change, and another epoch.
    const third = await distribute(alice, server, channelId, members);
    expect(third.epoch).toBe(2);
  });

  it('mints a new epoch when a member’s identity key rotates', async () => {
    await aliceSays('before rotation');
    const rotatedBob = makeUser('bob');
    const rotated = [members[0], { id: 'bob', publicKey: rotatedBob.publicKey }, members[2]];
    const next = await alice.transact(tx => ensureLocalSenderKey(tx, channelId, rotated, alice.user.id));
    expect(next.epoch).toBe(1);
    expect(membershipFingerprint(channelId, rotated)).not.toBe(membershipFingerprint(channelId, members));
  });

  it('refuses to wrap the group key to an identity the account has not verified', async () => {
    await aliceSays('pin established');
    const impostor = makeUser('bob');
    const substituted = [members[0], { id: 'bob', publicKey: impostor.publicKey }, members[2]];
    alice.activate();
    const local = await alice.transact(tx => ensureLocalSenderKey(tx, channelId, substituted, alice.user.id));
    await expect(buildSenderKeyEnvelopes(channelId, local, alice.user.id, alice.user.privateKey,
      pendingDistribution(local, substituted, alice.user.id))).rejects.toBeInstanceOf(IdentityPinError);
  });

  it('refuses a sender key minted for a roster containing someone who has left', async () => {
    // Alice's view still has Carol; Bob's no longer does. Adopting Alice's key
    // would mean reading messages Carol can read too, so Bob declines it and
    // says why instead of silently sharing a key with a departed member.
    await distribute(alice, server, channelId, members);
    const withoutCarol = members.filter(member => member.id !== carol.user.id);
    const { adopted, refused } = await receive(bob, server, channelId, withoutCarol, directory);
    expect(adopted).toHaveLength(0);
    expect(refused[0].reason).toMatch(/has since left/);
    expect(await bob.transact(tx => readReceivedSenderKey(tx, channelId, alice.user.id, 0))).toBeNull();

    // Once Alice sees the same roster she mints a fresh epoch, and that one is
    // adopted.
    await distribute(alice, server, channelId, withoutCarol);
    const second = await receive(bob, server, channelId, withoutCarol, directory);
    expect(second.adopted.map(key => key.epoch)).toEqual([1]);
  });

  it('adopts a key minted before a new member joined', async () => {
    // The mirror case: a narrower roster is ordinary history, not a stale key.
    const withoutCarol = members.filter(member => member.id !== carol.user.id);
    await distribute(alice, server, channelId, withoutCarol);
    const { adopted, refused } = await receive(bob, server, channelId, members, directory);
    expect(refused).toHaveLength(0);
    expect(adopted).toHaveLength(1);
  });

  it('refuses an envelope replayed at another recipient, channel or epoch', async () => {
    await distribute(alice, server, channelId, members);
    const [forBob] = server.for(channelId, bob.user.id);

    // The KDF context names the channel, both parties and the epoch, so none of
    // these can be re-pointed even by a server that holds every envelope.
    const replays: IncomingSenderKeyEnvelope[] = [
      { ...forBob, recipient_id: carol.user.id },
      { ...forBob, epoch: 1 },
    ];
    await receive(carol, server, channelId, members, directory);
    carol.activate();
    const keys = new Map(directory.map(user => [user.id, user.publicKey]));
    const { adopted, refused } = await verifySenderKeyEnvelopes(channelId, replays, carol.user.id, carol.user.privateKey,
      (id: string) => keys.get(id) ?? null, members);
    expect(adopted).toHaveLength(0);
    expect(refused).toHaveLength(2);
  });

  it('verifies sender keys without opening a vault transaction', async () => {
    // The pin assertions inside verification open the identity-trust vault,
    // which for a signed-in account is this same vault behind the same
    // exclusive lock. Doing that from inside a transaction deadlocks: the
    // conversation sticks on a spinner and the account's enrolment never
    // finishes. It cost a live run to find, so it is pinned here.
    await distribute(alice, server, channelId, members);
    bob.activate();
    const keys = new Map(directory.map(user => [user.id, user.publicKey]));
    await expect(bob.transact(async () => verifySenderKeyEnvelopes(
      channelId, server.for(channelId, bob.user.id), bob.user.id, bob.user.privateKey,
      (id: string) => keys.get(id) ?? null, members,
    ))).rejects.toThrow(/cannot nest/);

    // Outside one, the same call is fine.
    const outcome = await verifySenderKeyEnvelopes(
      channelId, server.for(channelId, bob.user.id), bob.user.id, bob.user.privateKey,
      (id: string) => keys.get(id) ?? null, members,
    );
    expect(outcome.adopted).toHaveLength(1);
  });

  it('refuses a membership that lists the same member twice', () => {
    expect(() => membershipFingerprint(channelId, [members[0], members[0]])).toThrow(GroupE2eeError);
  });
});
