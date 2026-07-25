import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { withUnlockedPrivateKey } from '../accountSession';
import { assertPinnedIdentityKey, IdentityPinError } from '../keyVerification';
import { fromBase64, toArrayBuffer, toBase64 } from '../crypto/util';
import { useAuthStore } from '../../stores/authStore';
import { useChannelStore } from '../../stores/channelStore';
import { useMemberStore } from '../../stores/memberStore';

const MEDIA_SENDER_KEY_CONTEXT_PREFIX = 'paracord:media-sender-key:v1:';
const MEDIA_SENDER_KEY_NONCE_BYTES = 12;

interface MediaSenderKeyEnvelopePayload {
  v: 1;
  nonce: string;
  ciphertext: string;
}

function resolveMediaUserPublicKey(userId: string): string | null {
  const myUser = useAuthStore.getState().user;
  if (myUser?.id === userId && typeof myUser.public_key === 'string' && myUser.public_key.trim().length > 0) {
    return myUser.public_key.trim();
  }

  const channels = useChannelStore.getState().channelsById;
  for (const channel of Object.values(channels)) {
    if (channel.recipient?.id === userId && typeof channel.recipient.public_key === 'string' && channel.recipient.public_key.trim().length > 0) {
      return channel.recipient.public_key.trim();
    }
    const recipient = channel.recipients?.find((entry) => entry.id === userId);
    if (recipient?.public_key && recipient.public_key.trim().length > 0) {
      return recipient.public_key.trim();
    }
  }

  const guildMembers = useMemberStore.getState().members;
  for (const members of guildMembers.values()) {
    const member = members.find((entry) => entry.user.id === userId);
    if (member?.user.public_key && member.user.public_key.trim().length > 0) {
      return member.user.public_key.trim();
    }
  }

  return null;
}

function deriveMediaEnvelopeKeyMaterial(
  scope: string,
  myPrivateKeyEd25519: Uint8Array,
  peerPublicKeyEd25519Hex: string,
): Uint8Array {
  const myPrivateX25519 = ed25519.utils.toMontgomerySecret(myPrivateKeyEd25519);
  const peerPublicEd25519 = hexToBytes(peerPublicKeyEd25519Hex);
  const peerPublicX25519 = ed25519.utils.toMontgomery(peerPublicEd25519);
  const sharedSecret = x25519.getSharedSecret(myPrivateX25519, peerPublicX25519);
  return sha256(concatBytes(utf8ToBytes(`${MEDIA_SENDER_KEY_CONTEXT_PREFIX}${scope}`), sharedSecret));
}

async function importEnvelopeAesKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', toArrayBuffer(rawKey), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function encodeEnvelopePayload(payload: MediaSenderKeyEnvelopePayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

function decodeEnvelopePayload(data: Uint8Array): MediaSenderKeyEnvelopePayload {
  const decoded = JSON.parse(new TextDecoder().decode(data)) as Partial<MediaSenderKeyEnvelopePayload>;
  if (decoded.v !== 1 || typeof decoded.nonce !== 'string' || typeof decoded.ciphertext !== 'string') {
    throw new Error('media sender-key envelope payload is invalid');
  }
  return decoded as MediaSenderKeyEnvelopePayload;
}

export async function wrapMediaSenderKeyForRecipient(
  scope: string,
  rawSenderKey: Uint8Array,
  epoch: number,
  recipientUserId: string,
): Promise<Uint8Array | null> {
  const recipientPublicKey = resolveMediaUserPublicKey(recipientUserId);
  if (!recipientPublicKey) {
    return null;
  }

  // The recipient key above comes straight out of server-supplied member /
  // channel objects. Without the pin, a malicious server substitutes its own
  // identity key, receives the wrapped sender key, and decrypts all call media.
  // Fail closed: no envelope is produced for an unverified key change, so the
  // peer visibly fails to receive media rather than the server silently getting
  // a copy.
  try {
    await assertPinnedIdentityKey(recipientUserId, recipientPublicKey);
  } catch (err) {
    if (err instanceof IdentityPinError) {
      console.warn(
        `[media-e2ee] refusing to wrap sender key for ${recipientUserId}: ${err.message}`,
      );
      return null;
    }
    throw err;
  }

  return withUnlockedPrivateKey(async (privateKey) => {
    const keyMaterial = deriveMediaEnvelopeKeyMaterial(scope, privateKey, recipientPublicKey);
    const envelopeKey = await importEnvelopeAesKey(keyMaterial);
    const nonce = crypto.getRandomValues(new Uint8Array(MEDIA_SENDER_KEY_NONCE_BYTES));
    const plaintext = JSON.stringify({
      sender_key: toBase64(rawSenderKey),
      epoch,
    });
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(nonce) },
      envelopeKey,
      toArrayBuffer(utf8ToBytes(plaintext)),
    );
    return encodeEnvelopePayload({
      v: 1,
      nonce: toBase64(nonce),
      ciphertext: toBase64(new Uint8Array(ciphertext)),
    });
  });
}

export async function unwrapDeliveredMediaSenderKey(
  scope: string,
  senderUserId: string,
  payload: Uint8Array,
): Promise<{ epoch: number; rawKey: Uint8Array }> {
  const senderPublicKey = resolveMediaUserPublicKey(senderUserId);
  if (!senderPublicKey) {
    throw new Error(`missing sender public key for user ${senderUserId}`);
  }
  // Same substitution risk in reverse: unwrapping against a swapped key would
  // accept a sender key the server chose. Let the pin error propagate.
  await assertPinnedIdentityKey(senderUserId, senderPublicKey);

  return withUnlockedPrivateKey(async (privateKey) => {
    const envelope = decodeEnvelopePayload(payload);
    const nonce = fromBase64(envelope.nonce);
    if (nonce.byteLength !== MEDIA_SENDER_KEY_NONCE_BYTES) {
      throw new Error('media sender-key envelope nonce is invalid');
    }
    const keyMaterial = deriveMediaEnvelopeKeyMaterial(scope, privateKey, senderPublicKey);
    const envelopeKey = await importEnvelopeAesKey(keyMaterial);
    const plaintextRaw = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(nonce) },
      envelopeKey,
      toArrayBuffer(fromBase64(envelope.ciphertext)),
    );
    const parsed = JSON.parse(new TextDecoder().decode(plaintextRaw)) as {
      sender_key?: string;
      epoch?: number;
    };
    if (typeof parsed.sender_key !== 'string' || typeof parsed.epoch !== 'number') {
      throw new Error('media sender-key envelope plaintext is invalid');
    }
    return {
      epoch: parsed.epoch,
      rawKey: fromBase64(parsed.sender_key),
    };
  });
}
