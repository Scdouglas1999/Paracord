import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { channelApi, type GroupSenderKeyRecord } from '../api/channels';
import type { MessageE2eePayload } from '../types';
import { fromBase64, toArrayBuffer, toBase64 } from './crypto/util';
import { assertPinnedIdentityKey, assertPinnedIdentityKeys, IdentityPinError } from './keyVerification';
import { secureGet, secureSet } from './secureStorage';

const GROUP_DM_CONTEXT_PREFIX = 'paracord:group-dm-sender-key:v1:';
const GROUP_DM_NONCE_BYTES = 12;
const SECURE_STORAGE_KEY = 'paracord:group-e2ee';
const LEGACY_STORAGE_KEY = 'paracord:v2:group-dm-sender-keys';

interface StoredLocalSenderKey {
  epoch: number;
  key: string;
  distributed_to: string[];
  distributed_public_keys?: Record<string, string>;
}

interface StoredChannelSenderKeys {
  local?: StoredLocalSenderKey;
  received: Record<string, string>;
}

type StoredSenderKeyMap = Record<string, StoredChannelSenderKeys>;

async function loadStore(): Promise<StoredSenderKeyMap> {
  const raw = await secureGet(SECURE_STORAGE_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as StoredSenderKeyMap;
    } catch {
      return {};
    }
  }
  // Migrate from legacy localStorage
  if (typeof localStorage !== 'undefined') {
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      try {
        const parsed = JSON.parse(legacy) as StoredSenderKeyMap;
        await secureSet(SECURE_STORAGE_KEY, legacy);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
        return parsed;
      } catch {
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      }
    }
  }
  return {};
}

async function persistStore(store: StoredSenderKeyMap): Promise<void> {
  await secureSet(SECURE_STORAGE_KEY, JSON.stringify(store));
}

function ensureChannelState(
  store: StoredSenderKeyMap,
  channelId: string,
): StoredChannelSenderKeys {
  const current = store[channelId];
  if (current) {
    if (!current.received) {
      current.received = {};
    }
    return current;
  }
  const created: StoredChannelSenderKeys = { received: {} };
  store[channelId] = created;
  return created;
}

function activeRecipientPublicKeys(
  recipients: Array<{ id: string; public_key?: string | null }>,
  myUserId: string,
): Map<string, string> {
  const active = new Map<string, string>();
  for (const recipient of recipients) {
    if (recipient.id === myUserId || !recipient.public_key) {
      continue;
    }
    active.set(recipient.id, recipient.public_key);
  }
  return active;
}

function recipientSetChanged(
  local: StoredLocalSenderKey,
  activeRecipientKeys: Map<string, string>,
): boolean {
  if (local.distributed_to.length === 0) {
    return false;
  }

  const distributed = new Set(local.distributed_to);
  if (distributed.size !== activeRecipientKeys.size) {
    return true;
  }

  if (!local.distributed_public_keys) {
    return true;
  }

  for (const [recipientId, publicKey] of activeRecipientKeys.entries()) {
    if (!distributed.has(recipientId) || local.distributed_public_keys[recipientId] !== publicKey) {
      return true;
    }
  }

  return false;
}

function createLocalSenderKey(epoch: number): StoredLocalSenderKey {
  return {
    epoch,
    key: toBase64(crypto.getRandomValues(new Uint8Array(32))),
    distributed_to: [],
    distributed_public_keys: {},
  };
}

function markDistributedRecipients(
  local: StoredLocalSenderKey,
  recipients: Array<{ id: string; public_key?: string | null }>,
  recipientIds: string[],
): StoredLocalSenderKey {
  const publicKeysById = new Map(
    recipients
      .filter((recipient) => recipient.public_key)
      .map((recipient) => [recipient.id, recipient.public_key!]),
  );
  local.distributed_to = Array.from(new Set([...local.distributed_to, ...recipientIds])).sort();
  local.distributed_public_keys = Object.fromEntries(
    local.distributed_to
      .map((recipientId) => [recipientId, publicKeysById.get(recipientId)] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
  );
  return local;
}

function deriveEnvelopeKeyMaterial(
  channelId: string,
  myPrivateKeyEd25519: Uint8Array,
  peerPublicKeyEd25519Hex: string,
): Uint8Array {
  const myPrivateX25519 = ed25519.utils.toMontgomerySecret(myPrivateKeyEd25519);
  const peerPublicEd25519 = hexToBytes(peerPublicKeyEd25519Hex);
  const peerPublicX25519 = ed25519.utils.toMontgomery(peerPublicEd25519);
  const sharedSecret = x25519.getSharedSecret(myPrivateX25519, peerPublicX25519);
  const context = utf8ToBytes(`${GROUP_DM_CONTEXT_PREFIX}${channelId}`);
  return sha256(concatBytes(context, sharedSecret));
}

async function importAesKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    toArrayBuffer(rawKey),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptSenderKeyEnvelope(
  channelId: string,
  senderKeyB64: string,
  epoch: number,
  myPrivateKeyEd25519: Uint8Array,
  recipientPublicKeyEd25519Hex: string,
): Promise<{ ciphertext: string; header: string }> {
  const keyMaterial = deriveEnvelopeKeyMaterial(
    channelId,
    myPrivateKeyEd25519,
    recipientPublicKeyEd25519Hex,
  );
  const key = await importAesKey(keyMaterial);
  const nonce = crypto.getRandomValues(new Uint8Array(GROUP_DM_NONCE_BYTES));
  const payload = JSON.stringify({ sender_key: senderKeyB64, epoch });
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce) },
    key,
    toArrayBuffer(utf8ToBytes(payload)),
  );
  return {
    ciphertext: toBase64(new Uint8Array(ciphertext)),
    header: JSON.stringify({ nonce: toBase64(nonce) }),
  };
}

async function decryptSenderKeyEnvelope(
  channelId: string,
  envelope: GroupSenderKeyRecord,
  myPrivateKeyEd25519: Uint8Array,
  senderPublicKeyEd25519Hex: string,
): Promise<{ senderKey: string; epoch: number }> {
  const headerValue = envelope.header ? JSON.parse(envelope.header) : {};
  const nonceB64 = typeof headerValue.nonce === 'string' ? headerValue.nonce : null;
  if (!nonceB64) {
    throw new Error('sender-key envelope is missing nonce');
  }
  const nonce = fromBase64(nonceB64);
  if (nonce.length !== GROUP_DM_NONCE_BYTES) {
    throw new Error('sender-key envelope nonce is invalid');
  }
  const keyMaterial = deriveEnvelopeKeyMaterial(
    channelId,
    myPrivateKeyEd25519,
    senderPublicKeyEd25519Hex,
  );
  const key = await importAesKey(keyMaterial);
  const plaintextRaw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce) },
    key,
    toArrayBuffer(fromBase64(envelope.ciphertext)),
  );
  const plaintext = new TextDecoder().decode(plaintextRaw);
  const parsed = JSON.parse(plaintext);
  if (typeof parsed.sender_key !== 'string' || typeof parsed.epoch !== 'number') {
    throw new Error('sender-key envelope payload is invalid');
  }
  return { senderKey: parsed.sender_key, epoch: parsed.epoch };
}

function parseGroupHeader(payload: MessageE2eePayload): {
  senderId: string;
  epoch: number;
} {
  if (!payload.header) {
    throw new Error('missing group sender-key header');
  }
  const header = JSON.parse(payload.header);
  if (header.kind !== 'group_sender_key') {
    throw new Error('not a group sender-key message');
  }
  if (typeof header.sender_id !== 'string' || typeof header.epoch !== 'number') {
    throw new Error('invalid group sender-key header');
  }
  return { senderId: header.sender_id, epoch: header.epoch };
}

export async function encryptGroupDmMessage(
  channelId: string,
  plaintext: string,
  myUserId: string,
  myPrivateKeyEd25519: Uint8Array,
  recipients: Array<{ id: string; public_key?: string | null }>,
): Promise<MessageE2eePayload> {
  const store = await loadStore();
  const channelState = ensureChannelState(store, channelId);
  let local = channelState.local;
  if (!local) {
    local = createLocalSenderKey(0);
    channelState.local = local;
  }

  const activeRecipientKeys = activeRecipientPublicKeys(recipients, myUserId);
  if (recipientSetChanged(local, activeRecipientKeys)) {
    local = createLocalSenderKey(local.epoch + 1);
    channelState.local = local;
  }

  const pendingRecipients = recipients.filter(
    (recipient) =>
      recipient.id !== myUserId &&
      Boolean(recipient.public_key) &&
      local!.distributed_public_keys?.[recipient.id] !== recipient.public_key,
  );
  if (pendingRecipients.length > 0) {
    // Recipient keys come from the server's channel object, so the sender key
    // would otherwise be wrapped to whatever key the server supplies. Assert
    // every pin up front (one store round trip) and fail the whole send on a
    // rotation rather than handing the group key to an unverified identity.
    await assertPinnedIdentityKeys(
      pendingRecipients.map((recipient) => ({
        userId: recipient.id,
        identityKeyHex: recipient.public_key!,
      })),
    );
    const envelopes = await Promise.all(
      pendingRecipients.map(async (recipient) => {
        const envelope = await encryptSenderKeyEnvelope(
          channelId,
          local!.key,
          local!.epoch,
          myPrivateKeyEd25519,
          recipient.public_key!,
        );
        return {
          recipient_id: recipient.id,
          ciphertext: envelope.ciphertext,
          header: envelope.header,
        };
      }),
    );
    await channelApi.postGroupSenderKeys(channelId, local.epoch, envelopes);
    local = markDistributedRecipients(
      local,
      recipients,
      pendingRecipients.map((recipient) => recipient.id),
    );
    channelState.local = local;
    store[channelId] = channelState;
    await persistStore(store);
  } else if (channelState.local && channelState.local.distributed_to.length === 0) {
    store[channelId] = channelState;
    await persistStore(store);
  }

  const key = await importAesKey(fromBase64(local.key));
  const nonce = crypto.getRandomValues(new Uint8Array(GROUP_DM_NONCE_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce) },
    key,
    toArrayBuffer(utf8ToBytes(plaintext)),
  );
  return {
    version: 2,
    nonce: toBase64(nonce),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
    header: JSON.stringify({
      kind: 'group_sender_key',
      sender_id: myUserId,
      epoch: local.epoch,
    }),
  };
}

export async function decryptGroupDmMessage(
  channelId: string,
  payload: MessageE2eePayload,
  myUserId: string,
  myPrivateKeyEd25519: Uint8Array,
  resolvePublicKey: (userId: string) => string | null,
): Promise<string> {
  const { senderId, epoch } = parseGroupHeader(payload);
  const store = await loadStore();
  const channelState = ensureChannelState(store, channelId);
  const cacheKey = `${senderId}:${epoch}`;
  let senderKey = channelState.received[cacheKey];

  if (!senderKey && senderId === myUserId) {
    if (channelState.local?.epoch === epoch) {
      senderKey = channelState.local.key;
    }
  }

  if (!senderKey) {
    const { data } = await channelApi.getGroupSenderKeys(channelId, epoch);
    for (const record of data.sender_keys || []) {
      const senderPublicKey = resolvePublicKey(record.sender_id);
      if (!senderPublicKey) {
        continue;
      }
      try {
        // Accepting a sender key derived against a substituted identity key
        // would let the server hand the group a key it knows.
        await assertPinnedIdentityKey(record.sender_id, senderPublicKey);
      } catch (err) {
        if (err instanceof IdentityPinError) {
          console.warn(
            `[group-e2ee] ignoring sender key from ${record.sender_id}: ${err.message}`,
          );
          continue;
        }
        throw err;
      }
      try {
        const decrypted = await decryptSenderKeyEnvelope(
          channelId,
          record,
          myPrivateKeyEd25519,
          senderPublicKey,
        );
        const keyId = `${record.sender_id}:${decrypted.epoch}`;
        channelState.received[keyId] = decrypted.senderKey;
      } catch {
        // Keep processing; a single corrupt envelope should not block others.
      }
    }
    store[channelId] = channelState;
    await persistStore(store);
    senderKey = channelState.received[cacheKey];
    if (senderKey) {
      void channelApi.ackGroupSenderKeys(channelId, {
        sender_id: senderId,
        up_to_epoch: epoch,
      });
    }
  }

  if (!senderKey) {
    throw new Error('No sender key available for this group DM message');
  }

  const key = await importAesKey(fromBase64(senderKey));
  const nonce = fromBase64(payload.nonce);
  if (nonce.length !== GROUP_DM_NONCE_BYTES) {
    throw new Error('Invalid group DM nonce');
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce) },
    key,
    toArrayBuffer(fromBase64(payload.ciphertext)),
  );
  return new TextDecoder().decode(plaintext);
}
