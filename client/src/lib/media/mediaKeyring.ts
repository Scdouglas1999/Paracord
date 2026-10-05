import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { bytesToHex, fromBase64, hexToBytes, toArrayBuffer, toBase64 } from '../crypto/util';

/**
 * A wrapped media key that did not authenticate between this device's call key
 * and the sender's: it was sealed to some other call key. Typed so a caller can
 * tell it from a malformed key (see `TrackKeyGrace` in `engineShared.ts`).
 */
export class UnopenableMediaKeyError extends Error {
  constructor() {
    super('A media key sent to this device could not be opened: it was not sealed to this call’s keys.');
    this.name = 'UnopenableMediaKeyError';
  }
}

/**
 * Media call keys.
 *
 * Every frame of voice and video leaves this device encrypted under a sender
 * key the relay never sees. That key has to reach the other people in the room,
 * so each sender wraps it once per recipient. This module owns the key that
 * wrapping is addressed to.
 *
 * A call key is an X25519 keypair minted when a participant joins a media
 * session and destroyed when it leaves. The public half travels on the media
 * control plane — `SessionJoin` publishes it, the relay copies it into the
 * participant roster it already sends — so every peer in the call learns it and
 * nobody outside the call does. The private half never leaves this process.
 *
 * Why per call, and not the account identity key:
 *
 *  - It works for everybody. The account identity key is created by the
 *    "Secure account" ceremony and unlocked from a recovery phrase. Most
 *    accounts have never run it, a second device does not hold the private half
 *    of one that has, and the guild member payload never carried the public
 *    half at all — so a guild call could not resolve a single peer's key and
 *    the engine refused to encrypt. One deterministic path that works for one
 *    account in a hundred is not a path.
 *  - It is worth less when stolen. A call key protects one call. There is no
 *    archive behind it, nothing to back up, and nothing to recover: the
 *    compromise of today's key says nothing about yesterday's call or
 *    tomorrow's.
 *
 * What the server is trusted for is unchanged. It already asserts which public
 * key belongs to which account — `GET /users/{id}/keys` hands out
 * `users.public_key` straight out of its own table, with no external
 * attestation, and that is exactly what the identity-keyed media path trusted.
 * Here it asserts the same binding for a key that lives one call. What
 * encryption buys, and the reason it is not optional, is that the relay
 * forwarding the media — the one component that sees every packet of every call
 * on the server — cannot read any of it.
 *
 * There is no unencrypted path and no "encrypt if the peer supports it": a peer
 * that published no call key cannot be sent audio, and the engine says so.
 */

/** Domain separation for the wrapping key. Bound to the media scope. */
const CALL_KEY_CONTEXT_PREFIX = 'paracord:media-call-key:v1:';
const CALL_KEY_NONCE_BYTES = 12;
const CALL_KEY_HEX_LENGTH = 64;

/**
 * How long a sender key from someone the roster has not introduced yet waits
 * for that introduction.
 *
 * Every media control message travels on its own QUIC stream, so two that
 * the relay sent in order can be read in the other order: a newcomer's
 * `key_deliver` can overtake the `session_participant_join` that carries its
 * call key, and a rejoiner's `session_participant_join` can overtake the
 * `session_participant_leave` of its previous call. The introduction is
 * normally milliseconds behind. Ten seconds is far past any reordering and
 * short enough that a key from someone who never joins fails the call
 * promptly.
 */
export const PEER_INTRODUCTION_TIMEOUT_MS = 10_000;

/**
 * Bound on keys waiting for an introduction at once. A room holds a few
 * hundred participants at most, each of whom delivers a handful of keys, so
 * more than this is not reordering.
 */
const MAX_PENDING_INTRODUCTIONS = 256;

/** A sender key opened from a peer's envelope. */
export interface UnwrappedSenderKey {
  epoch: number;
  rawKey: Uint8Array;
}

interface IntroductionWaiter {
  resolve: (publicKey: string | null) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function missingKeyError(action: string): Error {
  return new Error(`Someone in this call has not published a media key, so ${action}.`);
}

interface WrappedSenderKeyEnvelope {
  v: 1;
  nonce: string;
  ciphertext: string;
}

/** A media call key is 32 bytes of X25519 public key, lowercase hex. */
export function isMediaCallKey(value: unknown): value is string {
  return typeof value === 'string' && new RegExp(`^[0-9a-f]{${CALL_KEY_HEX_LENGTH}}$`).test(value);
}

function encodeEnvelope(envelope: WrappedSenderKeyEnvelope): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(envelope));
}

function decodeEnvelope(data: Uint8Array): WrappedSenderKeyEnvelope {
  const decoded = JSON.parse(new TextDecoder().decode(data)) as Partial<WrappedSenderKeyEnvelope>;
  if (decoded.v !== 1 || typeof decoded.nonce !== 'string' || typeof decoded.ciphertext !== 'string') {
    throw new Error('The wrapped media key is not in a shape this client understands.');
  }
  return decoded as WrappedSenderKeyEnvelope;
}

export class MediaKeyring {
  private secret: Uint8Array | null;
  private readonly peers = new Map<string, string>();
  /**
   * Peers this call has seen leave and has not seen come back. A key they
   * delivered that is still waiting when the wait runs out belongs to a call
   * they are no longer in, and is dropped rather than failing this one.
   */
  private readonly departed = new Set<string>();
  /** Unwraps waiting for the roster to introduce their sender, by sender. */
  private readonly introductions = new Map<string, Set<IntroductionWaiter>>();
  private pendingIntroductions = 0;
  /** This device's call key, as it goes on the wire. */
  readonly publicKey: string;

  private constructor(secret: Uint8Array) {
    this.secret = secret;
    this.publicKey = bytesToHex(x25519.getPublicKey(secret));
  }

  /** Mint the keypair for one call. */
  static create(): MediaKeyring {
    return new MediaKeyring(x25519.utils.randomSecretKey());
  }

  /**
   * Record the call key a peer published.
   *
   * A peer that rejoins publishes a new key; the newest one wins, because a
   * sender key wrapped to a key its owner has already thrown away is useless to
   * everybody.
   */
  setPeerKey(userId: string, publicKey: unknown): void {
    if (!userId) return;
    this.departed.delete(userId);
    if (!isMediaCallKey(publicKey)) {
      this.peers.delete(userId);
      // Introduced without a key: whatever they sent cannot be opened, and
      // waiting longer will not change that.
      this.settleIntroductions(userId, (waiter) =>
        waiter.reject(missingKeyError('the media key they sent cannot be opened')),
      );
      return;
    }
    this.peers.set(userId, publicKey);
    this.settleIntroductions(userId, (waiter) => waiter.resolve(publicKey));
  }

  /**
   * Forget a peer that left. A key of theirs that is still in flight waits
   * like any other, because the same account may be rejoining: its new call
   * is introduced right behind the old one's departure, in either order.
   */
  removePeer(userId: string): void {
    if (this.peers.delete(userId)) this.departed.add(userId);
  }

  hasPeer(userId: string): boolean {
    return this.peers.has(userId);
  }

  private requireSecret(): Uint8Array {
    if (!this.secret) throw new Error('This call’s media keys have already been destroyed.');
    return this.secret;
  }

  private requirePeer(userId: string): string {
    const key = this.peers.get(userId);
    if (!key) throw missingKeyError('their audio cannot be encrypted');
    return key;
  }

  private settleIntroductions(userId: string, settle: (waiter: IntroductionWaiter) => void): void {
    const waiters = this.introductions.get(userId);
    if (!waiters) return;
    this.introductions.delete(userId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      this.pendingIntroductions--;
      settle(waiter);
    }
  }

  /**
   * The call key of the peer a sender key came from, once the roster has
   * introduced them.
   *
   * Resolves `null` only for a peer this call saw leave and who did not come
   * back within {@link PEER_INTRODUCTION_TIMEOUT_MS}: their key has nothing
   * left to decrypt. A sender the roster never introduced is refused, because
   * the relay forwards keys only between members of the call, so a key from a
   * stranger means the roster and the relay disagree.
   */
  private awaitPeerKey(userId: string): Promise<string | null> {
    const known = this.peers.get(userId);
    if (known) return Promise.resolve(known);
    this.requireSecret();
    if (this.pendingIntroductions >= MAX_PENDING_INTRODUCTIONS) {
      return Promise.reject(
        new Error('Too many media keys arrived from people this call has not introduced.'),
      );
    }
    return new Promise<string | null>((resolve, reject) => {
      const waiter: IntroductionWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const waiters = this.introductions.get(userId);
          if (!waiters?.delete(waiter)) return;
          if (waiters.size === 0) this.introductions.delete(userId);
          this.pendingIntroductions--;
          if (this.departed.has(userId)) {
            resolve(null);
            return;
          }
          reject(
            new Error(
              'A media key arrived from someone this call never introduced, so it cannot be verified.',
            ),
          );
        }, PEER_INTRODUCTION_TIMEOUT_MS),
      };
      let waiters = this.introductions.get(userId);
      if (!waiters) {
        waiters = new Set();
        this.introductions.set(userId, waiters);
      }
      waiters.add(waiter);
      this.pendingIntroductions++;
    });
  }

  /**
   * The AES-GCM key that wraps a sender key for one peer, bound to the scope so
   * a room key and a screen-share key never share wrapping material.
   */
  private deriveWrappingMaterial(scope: string, peerPublicKey: string): Uint8Array {
    const shared = x25519.getSharedSecret(this.requireSecret(), hexToBytes(peerPublicKey));
    try {
      return sha256(concatBytes(utf8ToBytes(`${CALL_KEY_CONTEXT_PREFIX}${scope}`), shared));
    } finally {
      shared.fill(0);
    }
  }

  private async importWrappingKey(material: Uint8Array): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', toArrayBuffer(material), { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
  }

  /** Wrap a raw sender key for one recipient in this call. */
  async wrapSenderKey(
    scope: string,
    rawSenderKey: Uint8Array,
    epoch: number,
    recipientUserId: string,
  ): Promise<Uint8Array> {
    if (!scope || !Number.isSafeInteger(epoch) || epoch < 0 || ![16, 32].includes(rawSenderKey.byteLength)) {
      throw new Error('Invalid media sender key or epoch.');
    }
    const material = this.deriveWrappingMaterial(scope, this.requirePeer(recipientUserId));
    try {
      const key = await this.importWrappingKey(material);
      const nonce = crypto.getRandomValues(new Uint8Array(CALL_KEY_NONCE_BYTES));
      const plaintext = utf8ToBytes(
        JSON.stringify({ sender_key: toBase64(rawSenderKey), epoch }),
      );
      try {
        const ciphertext = await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv: toArrayBuffer(nonce) },
          key,
          toArrayBuffer(plaintext),
        );
        return encodeEnvelope({
          v: 1,
          nonce: toBase64(nonce),
          ciphertext: toBase64(new Uint8Array(ciphertext)),
        });
      } finally {
        plaintext.fill(0);
      }
    } finally {
      material.fill(0);
    }
  }

  /**
   * Unwrap a sender key a peer in this call addressed to us.
   *
   * A key can arrive before the roster message that introduces its sender
   * (see {@link PEER_INTRODUCTION_TIMEOUT_MS}); it waits for that
   * introduction and is then opened with the call key it names. Resolves
   * `null` when the sender left the call and did not return, so there is
   * nothing to apply. Nothing is ever accepted without the envelope
   * authenticating under this device's call key and the sender's.
   */
  async unwrapSenderKey(
    scope: string,
    senderUserId: string,
    payload: Uint8Array,
  ): Promise<UnwrappedSenderKey | null> {
    if (!scope) throw new Error('A media scope is required.');
    const envelope = decodeEnvelope(payload);
    const nonce = fromBase64(envelope.nonce);
    if (nonce.byteLength !== CALL_KEY_NONCE_BYTES) {
      throw new Error('The wrapped media key has an invalid nonce.');
    }
    const senderKey = await this.awaitPeerKey(senderUserId);
    if (senderKey === null) return null;
    const material = this.deriveWrappingMaterial(scope, senderKey);
    try {
      const key = await this.importWrappingKey(material);
      let opened: ArrayBuffer;
      try {
        opened = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: toArrayBuffer(nonce) },
          key,
          toArrayBuffer(fromBase64(envelope.ciphertext)),
        );
      } catch {
        // Authentication failed: the envelope was not sealed between this
        // device's call key and the one the sender published for this call.
        throw new UnopenableMediaKeyError();
      }
      const plaintext = new Uint8Array(opened);
      try {
        const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as {
          sender_key?: string;
          epoch?: number;
        };
        if (
          typeof parsed.sender_key !== 'string' ||
          !Number.isSafeInteger(parsed.epoch) ||
          parsed.epoch! < 0
        ) {
          throw new Error('The wrapped media key is not in a shape this client understands.');
        }
        const rawKey = fromBase64(parsed.sender_key);
        if (![16, 32].includes(rawKey.byteLength)) {
          rawKey.fill(0);
          throw new Error('The unwrapped media key is the wrong length.');
        }
        return { epoch: parsed.epoch!, rawKey };
      } finally {
        plaintext.fill(0);
      }
    } finally {
      material.fill(0);
    }
  }

  /** Destroy the private half. Called when the call ends. */
  dispose(): void {
    this.secret?.fill(0);
    this.secret = null;
    this.peers.clear();
    this.departed.clear();
    for (const userId of Array.from(this.introductions.keys())) {
      this.settleIntroductions(userId, (waiter) =>
        waiter.reject(new Error('This call’s media keys have already been destroyed.')),
      );
    }
  }
}
