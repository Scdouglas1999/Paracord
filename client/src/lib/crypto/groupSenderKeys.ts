import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { MessageE2eePayload } from '../../types';
import { assertPinnedIdentityKey, assertPinnedIdentityKeys, IdentityPinError } from '../keyVerification';
import { bytesToHex, fromBase64, hexToBytes, toArrayBuffer, toBase64 } from './util';
import type { VaultTransaction } from './accountVault';

/**
 * Group-DM message encryption, owned by one server account.
 *
 * The shape is Signal's sender-key idea: each member mints a symmetric key,
 * wraps it once per peer under a pairwise ECDH secret, and encrypts every
 * message to the group under their own key. What the earlier draft of this got
 * wrong, and what this module fixes, is everything around that idea:
 *
 * 1. **The state is account-owned.** It lives in the account vault, addressed
 *    `[serverId, userId, namespace, id]`, exactly like the identity pins and
 *    the 1:1 ratchet. The previous draft kept one process-wide secure-storage
 *    slot (`paracord:group-e2ee`) with no scope in the key, so two accounts on
 *    one device shared one blob.
 * 2. **Every message is signed.** A sender key is held by *every* member, so
 *    AES-GCM alone proves only that *somebody in the group* wrote the message.
 *    Without a signature any member could re-encrypt under a peer's sender key,
 *    claim that peer's id in the header, and be believed. Each message now
 *    carries an Ed25519 signature over a transcript that binds the channel, the
 *    authenticated header and the ciphertext, verified against the *pinned*
 *    identity key of the claimed sender.
 * 3. **The header is part of the AEAD.** The authenticated header is the
 *    AES-GCM AAD, so `sender_id`, `epoch` and the membership fingerprint cannot
 *    be edited away from the body they describe.
 * 4. **Rotation is bound to membership.** The epoch turns over whenever the
 *    membership fingerprint changes — a member joining or leaving, or *any*
 *    member's identity key rotating. The fingerprint is signed, and the wrapped
 *    key names the roster it was minted for, so a recipient can refuse a key
 *    minted for a roster wider than the one it can see rather than silently
 *    accepting a group key a departed member also holds.
 *
 * What this still does not have is a server-authenticated membership epoch: the
 * roster is the one the account's own channel view reports. A sender whose view
 * is stale can still mint one key against it, which is why the recipient-side
 * roster check in {@link adoptSenderKeyEnvelopes} exists. See
 * `docs/known-limitations.md`.
 */

export const GROUP_LOCAL_NAMESPACE = 'messages.group-sender-local';
export const GROUP_RECEIVED_NAMESPACE = 'messages.group-sender-received';

const MESSAGE_VERSION = 3;
const MESSAGE_TRANSCRIPT_PREFIX = 'paracord:group-dm-message:v3';
const ENVELOPE_CONTEXT_PREFIX = 'paracord:group-dm-sender-key:v3';
const NONCE_BYTES = 12;
const SENDER_KEY_BYTES = 32;

export interface GroupMember {
  id: string;
  publicKey: string;
}

export class GroupE2eeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GroupE2eeError';
  }
}

/** The local sender key this account encrypts its own group messages under. */
export interface LocalSenderKey {
  epoch: number;
  /** base64 AES-256 key. */
  key: string;
  /** The membership this epoch was minted for. */
  membersHash: string;
  /** Sorted member ids the epoch was minted for. */
  members: string[];
  /** Identity key each member held when the key was wrapped to them. */
  distributed: Record<string, string>;
}

export interface ReceivedSenderKey {
  key: string;
  epoch: number;
  senderId: string;
  membersHash: string;
  members: string[];
}

/** The part of the header the AEAD and the signature both cover. */
interface AuthenticatedHeader {
  kind: 'group_sender_key';
  v: number;
  sender_id: string;
  epoch: number;
  members: string;
}

function normalizeIdentity(value: string): string {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new GroupE2eeError('A group member identity key must be 32 bytes of hexadecimal.');
  }
  return normalized;
}

/**
 * The fingerprint an epoch is bound to.
 *
 * It covers the channel, every member id and every member's identity key, so a
 * key rotation is as much a membership change as a departure is: both must mint
 * a new epoch, because both change who can read what the old epoch wrapped.
 */
export function membershipFingerprint(channelId: string, members: readonly GroupMember[]): string {
  const canonical = [...members]
    .map(member => [member.id, normalizeIdentity(member.publicKey)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const seen = new Set<string>();
  for (const [id] of canonical) {
    if (seen.has(id)) throw new GroupE2eeError('A group membership cannot list the same member twice.');
    seen.add(id);
  }
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify([channelId, canonical]))));
}

/**
 * Fixed field order, so the bytes the sender signed are the bytes the recipient
 * verifies. Parsing into an object and re-stringifying would hand the ordering
 * to whoever wrote the JSON.
 */
function canonicalAuthHeader(header: AuthenticatedHeader): string {
  return JSON.stringify([header.kind, header.v, header.sender_id, header.epoch, header.members]);
}

function messageTranscript(channelId: string, canonicalHeader: string, nonce: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const separator = new Uint8Array([0]);
  return sha256(concatBytes(
    utf8ToBytes(MESSAGE_TRANSCRIPT_PREFIX), separator,
    utf8ToBytes(channelId), separator,
    utf8ToBytes(canonicalHeader), separator,
    nonce, separator,
    ciphertext,
  ));
}

function envelopeContext(channelId: string, senderId: string, recipientId: string, epoch: number): string {
  return `${ENVELOPE_CONTEXT_PREFIX}:${channelId}:${senderId}:${recipientId}:${epoch}`;
}

/**
 * The pairwise secret a sender key is wrapped under. Both identities and the
 * epoch are inside the KDF context, so an envelope cannot be replayed at a
 * different member, channel or epoch even if the raw ECDH secret were reused.
 */
function envelopeKeyMaterial(context: string, myPrivateKeyEd25519: Uint8Array, peerPublicKeyEd25519Hex: string): Uint8Array {
  const myPrivateX25519 = ed25519.utils.toMontgomerySecret(myPrivateKeyEd25519);
  const peerPublicX25519 = ed25519.utils.toMontgomery(hexToBytes(normalizeIdentity(peerPublicKeyEd25519Hex)));
  const shared = x25519.getSharedSecret(myPrivateX25519, peerPublicX25519);
  return sha256(concatBytes(utf8ToBytes(context), shared));
}

async function importAesKey(rawKey: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  if (rawKey.length !== SENDER_KEY_BYTES) throw new GroupE2eeError('A group sender key must be 32 bytes.');
  return crypto.subtle.importKey('raw', toArrayBuffer(rawKey), { name: 'AES-GCM' }, false, usages);
}

// ---------------------------------------------------------------------------
// Local sender key: minting and rotation
// ---------------------------------------------------------------------------

function receivedId(channelId: string, senderId: string, epoch: number): string {
  return `${channelId}:${senderId}:${epoch}`;
}

export async function readLocalSenderKey(tx: VaultTransaction, channelId: string): Promise<LocalSenderKey | null> {
  return tx.get<LocalSenderKey>(GROUP_LOCAL_NAMESPACE, channelId);
}

function mintLocalSenderKey(epoch: number, membersHash: string, members: string[]): LocalSenderKey {
  return {
    epoch,
    key: toBase64(crypto.getRandomValues(new Uint8Array(SENDER_KEY_BYTES))),
    membersHash,
    members: [...members].sort(),
    distributed: {},
  };
}

/**
 * The sender key this account should encrypt under right now.
 *
 * A changed membership fingerprint always mints a new epoch, never reuses the
 * old key against a new roster. That is the whole of the rotation rule: the key
 * a departed member holds is never the key the next message uses.
 */
export async function ensureLocalSenderKey(
  tx: VaultTransaction,
  channelId: string,
  members: readonly GroupMember[],
  myUserId: string,
): Promise<LocalSenderKey> {
  const membersHash = membershipFingerprint(channelId, members);
  const memberIds = members.map(member => member.id);
  const current = await readLocalSenderKey(tx, channelId);
  if (current && current.membersHash === membersHash) return current;
  if (current) {
    // The outgoing epoch is retired beside every other member's, not dropped.
    // Without this, rotating would make this account's *own* older messages
    // unreadable the moment its plaintext cache is cleared: it is the one
    // member it never wrapped a copy of the key to.
    tx.put(GROUP_RECEIVED_NAMESPACE, receivedId(channelId, myUserId, current.epoch), {
      key: current.key, epoch: current.epoch, senderId: myUserId,
      membersHash: current.membersHash, members: current.members,
    } satisfies ReceivedSenderKey);
  }
  const next = mintLocalSenderKey(current ? current.epoch + 1 : 0, membersHash, memberIds);
  tx.put(GROUP_LOCAL_NAMESPACE, channelId, next);
  return next;
}

/** The peers this epoch has not yet been wrapped to under their current key. */
export function pendingDistribution(local: LocalSenderKey, members: readonly GroupMember[], myUserId: string): GroupMember[] {
  return members.filter(member =>
    member.id !== myUserId
    && Boolean(member.publicKey)
    && local.distributed[member.id] !== normalizeIdentity(member.publicKey));
}

export function markDistributed(
  tx: VaultTransaction,
  channelId: string,
  local: LocalSenderKey,
  delivered: readonly GroupMember[],
): LocalSenderKey {
  const next: LocalSenderKey = {
    ...local,
    distributed: { ...local.distributed },
  };
  for (const member of delivered) next.distributed[member.id] = normalizeIdentity(member.publicKey);
  tx.put(GROUP_LOCAL_NAMESPACE, channelId, next);
  return next;
}

// ---------------------------------------------------------------------------
// Sender key distribution envelopes
// ---------------------------------------------------------------------------

export interface SenderKeyEnvelope {
  recipient_id: string;
  ciphertext: string;
  header: string;
}

/**
 * Wrap this account's sender key for each peer that still needs it.
 *
 * Every recipient key is asserted against its pin *before* anything is wrapped,
 * and the whole batch fails on a single rotation: the recipient list arrives
 * from the server's channel object, so wrapping first and checking later would
 * hand the group key to whatever identity the server chose to serve.
 */
export async function buildSenderKeyEnvelopes(
  channelId: string,
  local: LocalSenderKey,
  myUserId: string,
  myPrivateKeyEd25519: Uint8Array,
  recipients: readonly GroupMember[],
): Promise<SenderKeyEnvelope[]> {
  if (recipients.length === 0) return [];
  await assertPinnedIdentityKeys(recipients.map(member => ({ userId: member.id, identityKeyHex: member.publicKey })));

  return Promise.all(recipients.map(async recipient => {
    const context = envelopeContext(channelId, myUserId, recipient.id, local.epoch);
    const key = await importAesKey(envelopeKeyMaterial(context, myPrivateKeyEd25519, recipient.publicKey), ['encrypt']);
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const plaintext = JSON.stringify({
      sender_key: local.key,
      epoch: local.epoch,
      members: local.members,
      members_hash: local.membersHash,
    });
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(utf8ToBytes(context)) },
      key,
      toArrayBuffer(utf8ToBytes(plaintext)),
    );
    return {
      recipient_id: recipient.id,
      ciphertext: toBase64(new Uint8Array(ciphertext)),
      header: JSON.stringify({ v: MESSAGE_VERSION, nonce: toBase64(nonce) }),
    } satisfies SenderKeyEnvelope;
  }));
}

export interface IncomingSenderKeyEnvelope {
  sender_id: string;
  recipient_id: string;
  epoch: number;
  ciphertext: string;
  header?: string | null;
}

export async function readReceivedSenderKey(
  tx: VaultTransaction,
  channelId: string,
  senderId: string,
  epoch: number,
): Promise<ReceivedSenderKey | null> {
  return tx.get<ReceivedSenderKey>(GROUP_RECEIVED_NAMESPACE, receivedId(channelId, senderId, epoch));
}

async function openSenderKeyEnvelope(
  channelId: string,
  envelope: IncomingSenderKeyEnvelope,
  myUserId: string,
  myPrivateKeyEd25519: Uint8Array,
  senderPublicKeyEd25519Hex: string,
): Promise<ReceivedSenderKey> {
  const header = envelope.header ? JSON.parse(envelope.header) : {};
  const nonceB64 = typeof header.nonce === 'string' ? header.nonce : null;
  if (!nonceB64) throw new GroupE2eeError('A sender-key envelope is missing its nonce.');
  const nonce = fromBase64(nonceB64);
  if (nonce.length !== NONCE_BYTES) throw new GroupE2eeError('A sender-key envelope nonce is the wrong length.');

  const context = envelopeContext(channelId, envelope.sender_id, myUserId, envelope.epoch);
  const key = await importAesKey(envelopeKeyMaterial(context, myPrivateKeyEd25519, senderPublicKeyEd25519Hex), ['decrypt']);
  const plaintextRaw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(utf8ToBytes(context)) },
    key,
    toArrayBuffer(fromBase64(envelope.ciphertext)),
  );
  const parsed = JSON.parse(new TextDecoder().decode(plaintextRaw));
  if (typeof parsed.sender_key !== 'string' || parsed.epoch !== envelope.epoch
    || !Array.isArray(parsed.members) || typeof parsed.members_hash !== 'string') {
    throw new GroupE2eeError('A sender-key envelope payload is malformed.');
  }
  const members: string[] = parsed.members.map((id: unknown) => String(id));
  if (!members.includes(myUserId)) {
    throw new GroupE2eeError('A sender key was minted for a group this account is not part of.');
  }
  return {
    key: parsed.sender_key,
    epoch: parsed.epoch,
    senderId: envelope.sender_id,
    membersHash: parsed.members_hash,
    members,
  };
}

export interface SenderKeyAdoption {
  adopted: ReceivedSenderKey[];
  refused: Array<{ senderId: string; epoch: number; reason: string }>;
}

/**
 * Decide which of these sender keys this account will take, and why not for the
 * rest. **Runs outside any vault transaction, and must.**
 *
 * The pin assertions below open the identity-trust vault, which for a signed-in
 * account is the *same* `AccountVault` this module's records live in, and
 * `AccountVault.transact` takes an exclusive `navigator.locks` lease. Verifying
 * from inside a transaction therefore waits on a lock the caller is already
 * holding, and deadlocks — silently, with the conversation stuck on a spinner
 * and the account's enrolment never completing. Splitting verification from the
 * write is what keeps that impossible rather than merely avoided.
 *
 * `currentMembers` is the roster this account can see. A key minted for a
 * *wider* roster than that — one naming somebody who has since left — is
 * refused, because adopting it would mean reading messages the departed member
 * can read too. A key minted for a narrower roster is history: it predates
 * whoever has joined since, and is adopted normally.
 */
export async function verifySenderKeyEnvelopes(
  channelId: string,
  envelopes: readonly IncomingSenderKeyEnvelope[],
  myUserId: string,
  myPrivateKeyEd25519: Uint8Array,
  resolvePublicKey: (userId: string) => string | null,
  currentMembers: readonly GroupMember[],
): Promise<SenderKeyAdoption> {
  const known = new Set(currentMembers.map(member => member.id));
  const adopted: ReceivedSenderKey[] = [];
  const refused: Array<{ senderId: string; epoch: number; reason: string }> = [];

  for (const envelope of envelopes) {
    const senderPublicKey = resolvePublicKey(envelope.sender_id);
    if (!senderPublicKey) {
      refused.push({ senderId: envelope.sender_id, epoch: envelope.epoch, reason: 'This member has no published identity key.' });
      continue;
    }
    try {
      // A sender key wrapped against a substituted identity key would be a key
      // the server itself could unwrap, so the pin is asserted before the
      // envelope is opened, not after.
      await assertPinnedIdentityKey(envelope.sender_id, senderPublicKey);
    } catch (error) {
      if (error instanceof IdentityPinError) {
        refused.push({ senderId: envelope.sender_id, epoch: envelope.epoch, reason: error.message });
        continue;
      }
      throw error;
    }
    let opened: ReceivedSenderKey;
    try {
      opened = await openSenderKeyEnvelope(channelId, envelope, myUserId, myPrivateKeyEd25519, senderPublicKey);
    } catch (error) {
      refused.push({ senderId: envelope.sender_id, epoch: envelope.epoch, reason: error instanceof Error ? error.message : 'unreadable envelope' });
      continue;
    }
    const departed = opened.members.filter(id => !known.has(id));
    if (departed.length > 0) {
      refused.push({
        senderId: envelope.sender_id,
        epoch: envelope.epoch,
        reason: 'This group key was shared with a member who has since left the conversation. It will be replaced when its sender next writes.',
      });
      continue;
    }
    adopted.push(opened);
  }
  return { adopted, refused };
}

/** Commit verified sender keys. The caller owns the transaction. */
export function commitSenderKeys(
  tx: VaultTransaction,
  channelId: string,
  adopted: readonly ReceivedSenderKey[],
): void {
  for (const key of adopted) {
    tx.put(GROUP_RECEIVED_NAMESPACE, receivedId(channelId, key.senderId, key.epoch), key);
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Encrypt one group message under this account's current sender key.
 *
 * The caller has already committed the epoch (and distributed it) — this only
 * seals a body against it, so it stays synchronous with the vault transaction
 * that records the send.
 */
export async function sealGroupMessage(
  channelId: string,
  plaintext: string,
  myUserId: string,
  myPrivateKeyEd25519: Uint8Array,
  local: LocalSenderKey,
): Promise<MessageE2eePayload> {
  const header: AuthenticatedHeader = {
    kind: 'group_sender_key',
    v: MESSAGE_VERSION,
    sender_id: myUserId,
    epoch: local.epoch,
    members: local.membersHash,
  };
  const canonical = canonicalAuthHeader(header);
  const key = await importAesKey(fromBase64(local.key), ['encrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(utf8ToBytes(canonical)) },
    key,
    toArrayBuffer(utf8ToBytes(plaintext)),
  ));
  // Every member holds this sender key, so the AEAD tag proves only that some
  // member wrote this. The signature is what names which one.
  const signature = ed25519.sign(messageTranscript(channelId, canonical, nonce, ciphertext), myPrivateKeyEd25519);
  return {
    version: MESSAGE_VERSION,
    nonce: toBase64(nonce),
    ciphertext: toBase64(ciphertext),
    header: JSON.stringify({ ...header, sig: toBase64(signature) }),
  };
}

export interface OpenedGroupMessage {
  content: string;
  senderId: string;
  epoch: number;
  /** The membership fingerprint the sender signed this message against. */
  attestedMembers: string;
}

/**
 * Open one group message, or refuse it.
 *
 * Order matters: the claimed sender's identity pin is asserted, then the
 * signature over the header and ciphertext is verified, and only then is the
 * body decrypted. A message that fails any of those is not "undecryptable", it
 * is *rejected* — the caller must not present it as unreadable-but-genuine.
 */
export async function openGroupMessage(
  channelId: string,
  payload: MessageE2eePayload,
  senderKey: string,
  senderPublicKeyEd25519Hex: string,
): Promise<OpenedGroupMessage> {
  if (!payload.header) throw new GroupE2eeError('A group message is missing its sender-key header.');
  const parsed = JSON.parse(payload.header);
  if (parsed.kind !== 'group_sender_key') throw new GroupE2eeError('This is not a group sender-key message.');
  if (parsed.v !== MESSAGE_VERSION) {
    throw new GroupE2eeError('This group message uses an encryption version this build does not accept.');
  }
  if (typeof parsed.sender_id !== 'string' || typeof parsed.epoch !== 'number'
    || typeof parsed.members !== 'string' || typeof parsed.sig !== 'string') {
    throw new GroupE2eeError('A group message header is malformed.');
  }
  // Only the five fields below are canonicalised into the signature and the
  // AAD, so an unrecognised sixth would ride along unauthenticated — invisible
  // to this verifier and available to anything downstream that reads the raw
  // header. The header is exactly these keys or it is not a header.
  const keys = Object.keys(parsed).sort();
  if (keys.join(',') !== 'epoch,kind,members,sender_id,sig,v') {
    throw new GroupE2eeError('A group message header carries fields this build does not authenticate.');
  }
  const header: AuthenticatedHeader = {
    kind: 'group_sender_key', v: parsed.v, sender_id: parsed.sender_id, epoch: parsed.epoch, members: parsed.members,
  };
  const canonical = canonicalAuthHeader(header);
  const nonce = fromBase64(payload.nonce);
  if (nonce.length !== NONCE_BYTES) throw new GroupE2eeError('A group message nonce is the wrong length.');
  const ciphertext = fromBase64(payload.ciphertext);

  const verified = ed25519.verify(
    fromBase64(parsed.sig),
    messageTranscript(channelId, canonical, nonce, ciphertext),
    hexToBytes(normalizeIdentity(senderPublicKeyEd25519Hex)),
  );
  if (!verified) {
    throw new GroupE2eeError('This group message was not signed by the member it claims to be from.');
  }

  const key = await importAesKey(fromBase64(senderKey), ['decrypt']);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(utf8ToBytes(canonical)) },
    key,
    toArrayBuffer(ciphertext),
  );
  return {
    content: new TextDecoder().decode(plaintext),
    senderId: header.sender_id,
    epoch: header.epoch,
    attestedMembers: header.members,
  };
}

/** The sender and epoch a payload claims, for routing before any key is held. */
export function readGroupMessageClaim(payload: MessageE2eePayload): { senderId: string; epoch: number } {
  if (!payload.header) throw new GroupE2eeError('A group message is missing its sender-key header.');
  const parsed = JSON.parse(payload.header);
  if (parsed.kind !== 'group_sender_key' || typeof parsed.sender_id !== 'string' || typeof parsed.epoch !== 'number') {
    throw new GroupE2eeError('A group message header is malformed.');
  }
  return { senderId: parsed.sender_id, epoch: parsed.epoch };
}
