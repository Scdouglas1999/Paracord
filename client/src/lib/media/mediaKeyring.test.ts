import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMediaCallKey, MediaKeyring, PEER_INTRODUCTION_TIMEOUT_MS } from './mediaKeyring';
import { wrapSenderKeyForRecipients } from './engineShared';
import type { OperationContext } from '../operationContext';

const ALICE = '357608638640033792';
const BOB = '357611217138749440';

function senderKey(seed = 1): Uint8Array {
  return new Uint8Array(16).fill(seed);
}

/** The engine's own account guard, which the wrapping path only asserts on. */
function account(): OperationContext {
  return { assertCurrent: () => {} } as unknown as OperationContext;
}

/** Two participants that have exchanged call keys over the control plane. */
function pair() {
  const alice = MediaKeyring.create();
  const bob = MediaKeyring.create();
  alice.setPeerKey(BOB, bob.publicKey);
  bob.setPeerKey(ALICE, alice.publicKey);
  return { alice, bob };
}

describe('MediaKeyring', () => {
  it('publishes a call key in the shape the control plane accepts', () => {
    const keyring = MediaKeyring.create();
    expect(isMediaCallKey(keyring.publicKey)).toBe(true);
    expect(keyring.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(MediaKeyring.create().publicKey).not.toBe(keyring.publicKey);
  });

  it('carries a sender key from one participant to the other', async () => {
    const { alice, bob } = pair();
    const wrapped = await alice.wrapSenderKey('room:10:audio', senderKey(7), 3, BOB);
    const opened = await bob.unwrapSenderKey('room:10:audio', ALICE, wrapped);
    expect(opened?.epoch).toBe(3);
    expect(Array.from(opened!.rawKey)).toEqual(Array.from(senderKey(7)));
  });

  it('binds a wrapped key to its scope, so a room key cannot open a screen share', async () => {
    const { alice, bob } = pair();
    const wrapped = await alice.wrapSenderKey('room:10:audio', senderKey(), 1, BOB);
    await expect(bob.unwrapSenderKey('stream:s:camera', ALICE, wrapped)).rejects.toThrow();
  });

  it('refuses a peer that published no call key rather than sending in the clear', async () => {
    const alice = MediaKeyring.create();
    await expect(alice.wrapSenderKey('room:10:audio', senderKey(), 1, BOB)).rejects.toThrow(
      'has not published a media key',
    );
  });

  it('refuses a malformed call key instead of storing it', async () => {
    const alice = MediaKeyring.create();
    alice.setPeerKey(BOB, 'not-a-key');
    expect(alice.hasPeer(BOB)).toBe(false);
    alice.setPeerKey(BOB, 'AB'.repeat(32));
    expect(alice.hasPeer(BOB)).toBe(false);
  });

  it('takes a rejoining peer’s newest key', async () => {
    const alice = MediaKeyring.create();
    const stale = MediaKeyring.create();
    const current = MediaKeyring.create();
    alice.setPeerKey(BOB, stale.publicKey);
    alice.setPeerKey(BOB, current.publicKey);
    current.setPeerKey(ALICE, alice.publicKey);
    stale.setPeerKey(ALICE, alice.publicKey);

    const wrapped = await alice.wrapSenderKey('room:10:audio', senderKey(9), 2, BOB);
    expect(Array.from((await current.unwrapSenderKey('room:10:audio', ALICE, wrapped))!.rawKey)).toEqual(
      Array.from(senderKey(9)),
    );
    await expect(stale.unwrapSenderKey('room:10:audio', ALICE, wrapped)).rejects.toThrow();
  });

  it('forgets a peer that left', async () => {
    const { alice } = pair();
    alice.removePeer(BOB);
    await expect(alice.wrapSenderKey('room:10:audio', senderKey(), 1, BOB)).rejects.toThrow(
      'has not published a media key',
    );
  });

  it('destroys the private half when the call ends', async () => {
    const { alice } = pair();
    alice.dispose();
    await expect(alice.wrapSenderKey('room:10:audio', senderKey(), 1, BOB)).rejects.toThrow();
  });

  it('cannot open a key sealed to the call key it held before it rejoined', async () => {
    // What a relay replaying a stored envelope hands a rejoiner. The new call
    // key is fresh, so the old envelope does not authenticate, and the key is
    // refused rather than accepted: the fix for rejoining is that nothing ever
    // replays such an envelope (see docs/design/glass-fix-rejoin.md).
    const alice = MediaKeyring.create();
    const bobBefore = MediaKeyring.create();
    alice.setPeerKey(BOB, bobBefore.publicKey);
    const sealedToOldCall = await alice.wrapSenderKey('stream:s:screen', senderKey(5), 3, BOB);

    const bobAfterRejoin = MediaKeyring.create();
    bobAfterRejoin.setPeerKey(ALICE, alice.publicKey);
    await expect(bobAfterRejoin.unwrapSenderKey('stream:s:screen', ALICE, sealedToOldCall)).rejects.toThrow(
      'could not be opened',
    );
  });
});

describe('MediaKeyring keys that overtake their sender’s introduction', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Let pending microtasks and WebCrypto work run. */
  const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

  it('opens a key that arrived before the roster introduced its sender', async () => {
    const alice = MediaKeyring.create();
    const bob = MediaKeyring.create();
    alice.setPeerKey(BOB, bob.publicKey);
    const wrapped = await alice.wrapSenderKey('room:10:audio', senderKey(6), 4, BOB);

    // Bob reads Alice's key_deliver before her session_participant_join.
    const opening = bob.unwrapSenderKey('room:10:audio', ALICE, wrapped);
    await settle();
    bob.setPeerKey(ALICE, alice.publicKey);

    const opened = await opening;
    expect(opened?.epoch).toBe(4);
    expect(Array.from(opened!.rawKey)).toEqual(Array.from(senderKey(6)));
  });

  it('opens a rejoining peer’s new key that overtook the news of its departure', async () => {
    // Bob knew Alice's first call. She left and joined again; her new call's
    // key reaches Bob between her leave and her new join.
    const bob = MediaKeyring.create();
    const aliceBefore = MediaKeyring.create();
    bob.setPeerKey(ALICE, aliceBefore.publicKey);
    bob.removePeer(ALICE);

    const aliceAgain = MediaKeyring.create();
    aliceAgain.setPeerKey(BOB, bob.publicKey);
    const wrapped = await aliceAgain.wrapSenderKey('room:10:audio', senderKey(8), 1, BOB);
    const opening = bob.unwrapSenderKey('room:10:audio', ALICE, wrapped);
    await settle();
    bob.setPeerKey(ALICE, aliceAgain.publicKey);

    expect(Array.from((await opening)!.rawKey)).toEqual(Array.from(senderKey(8)));
  });

  it('refuses a key from someone the roster never introduces', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const alice = MediaKeyring.create();
    const bob = MediaKeyring.create();
    alice.setPeerKey(BOB, bob.publicKey);
    const wrapped = await alice.wrapSenderKey('room:10:audio', senderKey(), 1, BOB);

    const opening = bob.unwrapSenderKey('room:10:audio', ALICE, wrapped);
    const outcome = expect(opening).rejects.toThrow('never introduced');
    await vi.advanceTimersByTimeAsync(PEER_INTRODUCTION_TIMEOUT_MS);
    await outcome;
  });

  it('drops a key from someone who left and did not come back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { alice, bob } = pair();
    const wrapped = await alice.wrapSenderKey('room:10:audio', senderKey(), 1, BOB);
    bob.removePeer(ALICE);

    const opening = bob.unwrapSenderKey('room:10:audio', ALICE, wrapped);
    await vi.advanceTimersByTimeAsync(PEER_INTRODUCTION_TIMEOUT_MS);
    await expect(opening).resolves.toBeNull();
  });

  it('refuses at once when the sender is introduced without a key', async () => {
    const alice = MediaKeyring.create();
    const bob = MediaKeyring.create();
    alice.setPeerKey(BOB, bob.publicKey);
    const wrapped = await alice.wrapSenderKey('room:10:audio', senderKey(), 1, BOB);

    const opening = bob.unwrapSenderKey('room:10:audio', ALICE, wrapped);
    const outcome = expect(opening).rejects.toThrow('has not published a media key');
    await settle();
    bob.setPeerKey(ALICE, undefined);
    await outcome;
  });

  it('never opens a waiting key with a call key that is not the sender’s', async () => {
    // Waiting changes when a key is opened, not what it is checked against:
    // an introduction naming some other call key fails authentication.
    const alice = MediaKeyring.create();
    const bob = MediaKeyring.create();
    alice.setPeerKey(BOB, bob.publicKey);
    const wrapped = await alice.wrapSenderKey('room:10:audio', senderKey(), 1, BOB);

    const opening = bob.unwrapSenderKey('room:10:audio', ALICE, wrapped);
    const outcome = expect(opening).rejects.toThrow('could not be opened');
    await settle();
    bob.setPeerKey(ALICE, MediaKeyring.create().publicKey);
    await outcome;
  });

  it('abandons waiting keys when the call ends', async () => {
    const alice = MediaKeyring.create();
    const bob = MediaKeyring.create();
    alice.setPeerKey(BOB, bob.publicKey);
    const wrapped = await alice.wrapSenderKey('room:10:audio', senderKey(), 1, BOB);

    const opening = bob.unwrapSenderKey('room:10:audio', ALICE, wrapped);
    const outcome = expect(opening).rejects.toThrow('destroyed');
    await settle();
    bob.dispose();
    await outcome;
  });
});

describe('wrapSenderKeyForRecipients', () => {
  it('wraps for every recipient in the call', async () => {
    const { alice, bob } = pair();
    const carolId = '357611105763201024';
    const carol = MediaKeyring.create();
    alice.setPeerKey(carolId, carol.publicKey);
    carol.setPeerKey(ALICE, alice.publicKey);

    const wrapped = await wrapSenderKeyForRecipients(
      'room:10:audio',
      senderKey(4),
      5,
      [BOB, carolId],
      alice,
      account(),
    );
    expect(wrapped.map((entry) => entry.recipientUserId)).toEqual([BOB, carolId]);
    expect(Array.from((await bob.unwrapSenderKey('room:10:audio', ALICE, wrapped[0].wrapped))!.rawKey)).toEqual(
      Array.from(senderKey(4)),
    );
    expect(
      Array.from((await carol.unwrapSenderKey('room:10:audio', ALICE, wrapped[1].wrapped))!.rawKey),
    ).toEqual(Array.from(senderKey(4)));
  });

  it('fails the announce rather than quietly leaving a participant out', async () => {
    const { alice } = pair();
    await expect(
      wrapSenderKeyForRecipients('room:10:audio', senderKey(), 1, [BOB, '999'], alice, account()),
    ).rejects.toThrow('has not published a media key');
  });
});
