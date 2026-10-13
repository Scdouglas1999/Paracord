import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import type { MessageE2eePayload } from '../../types';
import { createDmCipher, DmE2eeError, type DmCipherDependencies } from '../dmCipher';
import { IdentityPinError } from '../keyVerification';
import type { VaultTransaction } from './accountVault';
import { deserializeState, serializeState } from './sessionManager';
import { createSignalVaultDependencies, SIGNAL_SESSION_NAMESPACE } from './signalVault';
import type { RatchetState, SerializedRatchetState } from './types';
import { bytesToHex, fromBase64, toBase64 } from './util';

export interface SignalSessionReference { registryId: string; generationId: string }
const RETIRED_SEND_NAMESPACE = 'signal.retired-sends';
/**
 * What each ratchet generation was built against, so a sender can tell whether
 * it still reaches the device that holds the peer's current keys.
 *
 * An account publishes one prekey bundle, and the server names it with a
 * prekey generation (a server snowflake) that advances when a new device under
 * the same identity replaces the bundle. A generation this device started via
 * X3DH is anchored to the generation of the bundle it fetched; one the peer
 * started is anchored to the server ID of that initial message, which is
 * ordered against the generation because both are server snowflakes. A ratchet
 * anchored before the peer's current generation leads to a device that no
 * longer receives new sessions, so the next send starts a fresh X3DH session
 * with the current bundle instead.
 */
const GENERATION_ANCHOR_NAMESPACE = 'signal.generation-anchors';
interface GenerationAnchor { version: 1; anchor: string | null }

async function isSendingRetired(transaction: VaultTransaction, session: SignalSessionReference): Promise<boolean> {
  const marker = await transaction.get<{ version: number }>(RETIRED_SEND_NAMESPACE, JSON.stringify([session.registryId, session.generationId]));
  if (marker && marker.version !== 1) throw new Error('The sending-session retirement record is invalid.');
  return marker !== null;
}

/** Retire sending only: delayed messages still need this generation's private keys. */
export async function retireSignalSendingSession(transaction: VaultTransaction, session: SignalSessionReference) {
  const stored = await transaction.get<SerializedRatchetState>(`${SIGNAL_SESSION_NAMESPACE}:${session.registryId}`, session.generationId);
  if (!stored) throw new Error('The sending generation needed to resolve this message is missing.');
  deserializeState(stored);
  transaction.put(RETIRED_SEND_NAMESPACE, JSON.stringify([session.registryId, session.generationId]), { version: 1 });
}

function anchorId(registryId: string, generationId: string) { return JSON.stringify([registryId, generationId]); }

/** True when the generation predates the peer's current prekey generation (or cannot show that it does not). */
async function predatesPeerKeys(transaction: VaultTransaction, session: SignalSessionReference, current: string): Promise<boolean> {
  const record = await transaction.get<GenerationAnchor>(GENERATION_ANCHOR_NAMESPACE, anchorId(session.registryId, session.generationId));
  if (record && (record.version !== 1 || (record.anchor !== null && typeof record.anchor !== 'string'))) {
    throw new Error('The encrypted DM generation anchor is invalid.');
  }
  // Generations from before anchors existed, and sessions built against a
  // bundle the server named no generation for, cannot show they reach the
  // current device; one fresh X3DH session settles it.
  if (!record || record.anchor === null) return true;
  assertSignalMessageId(record.anchor);
  return BigInt(record.anchor) < BigInt(current);
}

/** A peer prekey generation is a server snowflake, like a message ID. */
export function assertPrekeyGeneration(generation: string): void {
  if (typeof generation !== 'string' || !/^[1-9][0-9]{0,18}$/.test(generation)
    || BigInt(generation) > 9223372036854775807n) {
    throw new Error('The server named an invalid prekey generation for this contact.');
  }
}

interface SessionIndex {
  version: 2;
  activeId: string;
  /** Highest authenticated incoming message or acknowledged send, using exact ordering. */
  lastMessageId: string | null;
}

export function assertSignalMessageId(messageId: string): void {
  if (typeof messageId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(messageId)
    || BigInt(messageId) > 9223372036854775807n) {
    throw new Error('DM decryption requires the server message ID.');
  }
}

/**
 * Each authenticated X3DH generation has its own ratchet. Receiving history or a
 * simultaneous initiation must never overwrite another generation's private
 * keys. Normal v2 headers contain no generation ID, so only successful AEAD
 * authentication selects a stored candidate. Failed candidates make no writes.
 */
export function createSignalSessionCipher(
  transaction: VaultTransaction,
  channelId: string,
  keysApi: DmCipherDependencies['keysApi'],
) {
  // The bundle generation of the most recent X3DH fetch in this cipher, so a
  // generation this device starts is anchored to exactly what it encrypted to.
  let fetchedGeneration: string | null | undefined;
  const dependencies = createSignalVaultDependencies(transaction, channelId, {
    async getBundle(userId: string) {
      const response = await keysApi.getBundle(userId);
      const generation = response.data.prekey_generation ?? null;
      if (generation !== null) assertPrekeyGeneration(generation);
      fetchedGeneration = generation;
      return response;
    },
  });

  async function sessions(privateKey: Uint8Array, peerPublicKey: string) {
    const own = bytesToHex(ed25519.getPublicKey(privateKey));
    const peer = peerPublicKey.trim().toLowerCase();
    const id = JSON.stringify([channelId, own, peer]);
    const namespace = `${SIGNAL_SESSION_NAMESPACE}:${id}`;
    const saved = await transaction.get<SessionIndex | SerializedRatchetState>(SIGNAL_SESSION_NAMESPACE, id);
    let index: SessionIndex | null = null;
    if (saved) {
      if ('version' in saved) {
        if (saved.version !== 2 || typeof saved.activeId !== 'string' || !saved.activeId || (saved.lastMessageId !== null && typeof saved.lastMessageId !== 'string')) {
          throw new Error('The encrypted DM session index is invalid.');
        }
        if (saved.lastMessageId !== null) assertSignalMessageId(saved.lastMessageId);
        index = saved;
      } else {
        // This record is already authenticated and account/conversation owned.
        // Unscoped legacy secure-storage sessions are never claimed here.
        deserializeState(saved);
        index = { version: 2, activeId: crypto.randomUUID(), lastMessageId: null };
        transaction.put(namespace, index.activeId, saved);
        transaction.put(SIGNAL_SESSION_NAMESPACE, id, index);
      }
    }
    return { id, namespace, index };
  }

  async function encryptDmMessageWithSession(
    channel: string, plaintext: string, privateKey: Uint8Array, peerPublicKey: string, peerUserId: string,
    options: {
      independent?: boolean;
      /**
       * The peer's current prekey generation as this account last saw it (the
       * DM recipient projection, refreshed on the peer's key publication and on
       * every send). `undefined` or `null`: the server names none, so the
       * active ratchet is used as before.
       */
      peerPrekeyGeneration?: string | null;
    } = {},
  ): Promise<{ payload: MessageE2eePayload; session: SignalSessionReference }> {
    const current = options.peerPrekeyGeneration ?? null;
    if (current !== null) assertPrekeyGeneration(current);
    await dependencies.assertPinnedDmPeerIdentity(channel, peerPublicKey, peerUserId);
    const registry = await sessions(privateKey, peerPublicKey);
    if (!registry.index && (await transaction.list(registry.namespace)).length) {
      throw new Error('The encrypted DM session index is missing.');
    }
    const stored = registry.index
      ? await transaction.get<SerializedRatchetState>(registry.namespace, registry.index.activeId) : null;
    if (registry.index && !stored) throw new Error('The active encrypted DM session is missing.');
    const previousState = stored ? deserializeState(stored) : null;
    let retired = registry.index && await isSendingRetired(transaction, { registryId: registry.id, generationId: registry.index.activeId });
    if (registry.index && !retired && !options.independent && current !== null) {
      const active = { registryId: registry.id, generationId: registry.index.activeId };
      if (await predatesPeerKeys(transaction, active, current)) {
        // The peer's keys moved to another device after this ratchet began.
        // Keep the generation for delayed reads; stop sending on it.
        await retireSignalSendingSession(transaction, active);
        retired = true;
      }
    }
    const index = registry.index && !retired && !options.independent ? registry.index
      : { version: 2 as const, activeId: crypto.randomUUID(), lastMessageId: registry.index?.lastMessageId ?? null };
    const state = retired || options.independent ? null : previousState;
    const cipher = createDmCipher({
      ...dependencies,
      async loadSession() { return state; },
      async saveSession(_own, _peer, updated) {
        transaction.put(registry.namespace, index.activeId, serializeState(updated));
        if (!options.independent || !registry.index) transaction.put(SIGNAL_SESSION_NAMESPACE, registry.id, index);
      },
    });
    fetchedGeneration = undefined;
    const payload = await cipher.encryptDmMessageV2(channel, plaintext, privateKey, peerPublicKey, peerUserId);
    const session = { registryId: registry.id, generationId: index.activeId };
    if (!state) {
      // A new X3DH generation: anchor it to the bundle it was encrypted to.
      if (fetchedGeneration === undefined) throw new Error('A new encrypted DM session was started without the contact’s published keys.');
      transaction.put(GENERATION_ANCHOR_NAMESPACE, anchorId(registry.id, index.activeId), { version: 1, anchor: fetchedGeneration } satisfies GenerationAnchor);
    }
    // Mutable messages must not introduce a ratchet dependency for later sends.
    // The independent generation remains available for decrypting replies.
    if (options.independent) await retireSignalSendingSession(transaction, session);
    return { payload, session };
  }

  async function decryptDmMessage(
    channel: string, payload: MessageE2eePayload, privateKey: Uint8Array,
    peerPublicKey: string, peerUserId: string, messageId: string,
  ): Promise<string> {
    assertSignalMessageId(messageId);
    await dependencies.assertPinnedDmPeerIdentity(channel, peerPublicKey, peerUserId);
    if (payload.version !== 2) {
      // Explicit historical v1 reader; it never creates or selects a ratchet.
      return createDmCipher({
        ...dependencies,
        async loadSession() { return null; },
        async saveSession() { throw new Error('Historical v1 reads cannot write a Signal session.'); },
      }).decryptDmMessage(channel, payload, privateKey, peerPublicKey, peerUserId);
    }
    const registry = await sessions(privateKey, peerPublicKey);
    async function* candidates() {
      const activeId = registry.index?.activeId;
      if (activeId) {
        const active = await transaction.get<SerializedRatchetState>(registry.namespace, activeId);
        if (!active) throw new Error('The active encrypted DM session is missing.');
        yield { id: activeId, state: deserializeState(active) };
      }
      // Usually the active ratchet authenticates immediately; don't decrypt all
      // retired private keys for every message. Storage reads stay outside the
      // crypto catch, so missing/corrupted records cannot trigger initialization.
      for (const record of await transaction.list<SerializedRatchetState>(registry.namespace)) {
        if (record.id !== activeId) yield { id: record.id, state: deserializeState(record.value) };
      }
    }
    const remember = (id: string, state: RatchetState, retired = false) => {
      transaction.put(registry.namespace, id, serializeState(state));
      const previous = registry.index;
      const newer = !previous?.lastMessageId || BigInt(messageId) > BigInt(previous.lastMessageId);
      transaction.put(SIGNAL_SESSION_NAMESPACE, registry.id, newer
        ? { version: 2, activeId: retired ? previous?.activeId ?? id : id, lastMessageId: messageId }
        : previous);
    };
    for await (const candidate of candidates()) {
      let updated: RatchetState | undefined;
      const cipher = createDmCipher({
        ...dependencies,
        async assertPinnedDmPeerIdentity() {}, // Checked once, before reading any session.
        async loadSession() { return candidate.state; },
        async saveSession(_own, _peer, state) { updated = state; },
      });
      let plaintext: string;
      try {
        plaintext = await cipher.decryptDmMessageWithSession(channel, payload, privateKey, peerPublicKey, peerUserId);
      } catch (error) {
        if (error instanceof IdentityPinError || error instanceof DmE2eeError) throw error;
        continue;
      }
      if (!updated) throw new Error('Authenticated DM did not update its ratchet.');
      remember(candidate.id, updated, await isSendingRetired(transaction, { registryId: registry.id, generationId: candidate.id }));
      return plaintext;
    }
    // A new initial message gets a new slot. The cipher validates the sender
    // identity and authenticates X3DH before saving a ratchet or consuming a key.
    if (!payload.header) throw new Error('Signal v2 messages require an authenticated ratchet header.');
    const header = JSON.parse(payload.header);
    // X3DH extensions are not in the v2 AEAD header. Their spelling/order must
    // not let a replay rebuild a consumed generation (especially with a reusable
    // last-resort prekey). Bind the slot to the authenticated ciphertext bytes.
    const newId = bytesToHex(sha256(utf8ToBytes(JSON.stringify([
      header.dh, header.pn, header.n,
      toBase64(fromBase64(payload.nonce)), toBase64(fromBase64(payload.ciphertext)),
    ]))));
    if (await transaction.get(registry.namespace, newId)) {
      throw new Error('This initial DM was already authenticated; its session cannot be restarted.');
    }
    const cipher = createDmCipher({
      ...dependencies,
      async loadSession() { return null; },
      async saveSession(_own, _peer, state) {
        remember(newId, state);
        // The peer's device started this generation when the server accepted
        // this message; that orders it against the peer's prekey generations.
        transaction.put(GENERATION_ANCHOR_NAMESPACE, anchorId(registry.id, newId), { version: 1, anchor: messageId } satisfies GenerationAnchor);
      },
    });
    return cipher.decryptDmMessage(channel, payload, privateKey, peerPublicKey, peerUserId);
  }

  return {
    /** An authoritative send acknowledgment also prevents old history selecting a former generation. */
    async acknowledgeSendingSession(privateKey: Uint8Array, peerPublicKey: string, session: SignalSessionReference, messageId: string) {
      assertSignalMessageId(messageId);
      const registry = await sessions(privateKey, peerPublicKey);
      if (registry.id !== session.registryId || !registry.index
        || !await transaction.get(registry.namespace, session.generationId)) throw new Error('The acknowledged message has no owned encryption generation.');
      if (registry.index.lastMessageId && BigInt(registry.index.lastMessageId) >= BigInt(messageId)) return;
      const retired = await isSendingRetired(transaction, session);
      transaction.put(SIGNAL_SESSION_NAMESPACE, registry.id, { ...registry.index,
        activeId: retired ? registry.index.activeId : session.generationId, lastMessageId: messageId });
    },
    /** Retire only sending; all generations remain available for delayed reads. */
    async retireSendingSession(privateKey: Uint8Array, peerPublicKey: string) {
      const registry = await sessions(privateKey, peerPublicKey);
      if (!registry.index) {
        if ((await transaction.list(registry.namespace)).length) throw new Error('The encrypted DM session index is missing.');
        return null;
      }
      const session = { registryId: registry.id, generationId: registry.index.activeId };
      await retireSignalSendingSession(transaction, session);
      return session;
    },
    encryptDmMessageWithSession,
    async encryptDmMessageV2(...args: Parameters<typeof encryptDmMessageWithSession>) {
      return (await encryptDmMessageWithSession(...args)).payload;
    },
    decryptDmMessage,
  };
}
