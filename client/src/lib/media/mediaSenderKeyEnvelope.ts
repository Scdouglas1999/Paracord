import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { openAccountVault } from '../crypto/accountVaultSession';
import { SIGNAL_USER_PIN_NAMESPACE } from '../crypto/signalVault';
import { readStoredValueForMigration } from '../secureStorage';
import type { OperationContext } from '../operationContext';
import { bindMessagingHistory } from '../messages/runtimeHistory';
import { IdentityPinError, formatIdentityFingerprint } from '../keyVerification';
import { fromBase64, toArrayBuffer, toBase64 } from '../crypto/util';
import { getServerUser } from '../serverIdentity';
import { entityKeyBelongsToScope } from '../serverScope';
import { useChannelStore } from '../../stores/channelStore';
import { useMemberStore } from '../../stores/memberStore';

const MEDIA_SENDER_KEY_CONTEXT_PREFIX = 'paracord:media-sender-key:v1:';
const MEDIA_SENDER_KEY_NONCE_BYTES = 12;

interface MediaSenderKeyEnvelopePayload {
  v: 1;
  nonce: string;
  ciphertext: string;
}

function resolveMediaUserPublicKey(userId: string, account: OperationContext): string | null {
  account.assertCurrent();
  const accountScope = account.scope; const serverId = accountScope.serverId;
  const myUser = getServerUser(serverId);
  if (myUser?.id === userId && typeof myUser.public_key === 'string' && myUser.public_key.trim().length > 0) {
    return myUser.public_key.trim();
  }

  const channels = useChannelStore.getState().channelsById;
  for (const [key, channel] of Object.entries(channels)) {
    if (!entityKeyBelongsToScope(key, accountScope)) continue;
    if (channel.recipient?.id === userId && typeof channel.recipient.public_key === 'string' && channel.recipient.public_key.trim().length > 0) {
      return channel.recipient.public_key.trim();
    }
    const recipient = channel.recipients?.find((entry) => entry.id === userId);
    if (recipient?.public_key && recipient.public_key.trim().length > 0) {
      return recipient.public_key.trim();
    }
  }

  const guildMembers = useMemberStore.getState().members;
  for (const [key, members] of guildMembers) {
    if (!entityKeyBelongsToScope(key, accountScope)) continue;
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
  try { return sha256(concatBytes(utf8ToBytes(`${MEDIA_SENDER_KEY_CONTEXT_PREFIX}${scope}`), sharedSecret)); }
  finally { myPrivateX25519.fill(0); sharedSecret.fill(0); }
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

async function withMediaIdentity<T>(account: OperationContext | undefined, peerId: string, run: (privateKey: Uint8Array, peerKey: string, assertCurrent: () => void) => Promise<T>): Promise<T> {
  if (!account) throw new Error('An owned account context is required for encrypted media.');
  account.assertCurrent();
  if (!account.historyEpoch) throw new Error('Wait for an authenticated server history before preparing encrypted media.');
  const publicKey = resolveMediaUserPublicKey(peerId, account)?.trim().toLowerCase();
  if (!publicKey || !/^[0-9a-f]{64}$/.test(publicKey)) throw new Error('The media participant has no verified account identity key.');
  const session = await openAccountVault(account.scope);
  const assertCurrent = () => {
    account.assertCurrent(); session.assertCurrent();
    if (session.context.historyEpoch !== account.historyEpoch) throw new Error('The call belongs to a different server history.');
    if (resolveMediaUserPublicKey(peerId, account)?.trim().toLowerCase() !== publicKey) throw new Error('The media participant identity changed while preparing encryption.');
  };
  account.signal.addEventListener('abort', session.dispose, { once: true });
  try {
    assertCurrent();
    const history = await bindMessagingHistory(session.vault, account.historyEpoch, crypto.randomUUID());
    assertCurrent();
    if (history.kind !== 'ready') throw new Error('The encrypted media account has older or unknown server history. Review identity recovery before calling.');
    const previous = await session.vault.transact(tx => tx.get<{ identity: string }>(SIGNAL_USER_PIN_NAMESPACE, peerId));
    if (!previous) {
      for (const key of ['paracord:key-verification-store', 'paracord:identity-verification:v1']) {
        const legacy = await readStoredValueForMigration(key); assertCurrent();
        if (legacy !== null) {
          const records = JSON.parse(legacy) as Record<string, unknown>;
          if (!records || typeof records !== 'object' || Array.isArray(records)) throw new Error('Older media identity trust records need recovery review.');
          if (records[peerId]) throw new Error('Review this participant’s older identity trust in the owned account before using encrypted media.');
        }
      }
    }
    return await session.vault.transact(async tx => {
      assertCurrent();
      const pin = await tx.get<{ identity: string }>(SIGNAL_USER_PIN_NAMESPACE, peerId);
      if (pin && pin.identity !== publicKey) throw new IdentityPinError('IDENTITY_KEY_ROTATED', 'The media participant identity changed. Verify it before continuing.', {
        userId: peerId, pinnedFingerprint: formatIdentityFingerprint(pin.identity), presentedFingerprint: formatIdentityFingerprint(publicKey),
      });
      const result = await run(session.privateKey, publicKey, assertCurrent); assertCurrent();
      if (!pin) tx.put(SIGNAL_USER_PIN_NAMESPACE, peerId, { identity: publicKey, firstSeenAt: new Date().toISOString() });
      return result;
    });
  } finally { account.signal.removeEventListener('abort', session.dispose); session.dispose(); }
}

export async function wrapMediaSenderKeyForRecipient(
  scope: string,
  rawSenderKey: Uint8Array,
  epoch: number,
  recipientUserId: string,
  account?: OperationContext,
): Promise<Uint8Array | null> {
  if (!scope || !Number.isSafeInteger(epoch) || epoch < 0 || ![16, 32].includes(rawSenderKey.byteLength)) throw new Error('Invalid media sender key or epoch.');
  const capturedKey = rawSenderKey.slice();
  try {
    return await withMediaIdentity(account, recipientUserId, async (privateKey, publicKey, assertCurrent) => {
      const material = deriveMediaEnvelopeKeyMaterial(scope, privateKey, publicKey);
      try {
        const key = await importEnvelopeAesKey(material); assertCurrent();
        const nonce = crypto.getRandomValues(new Uint8Array(MEDIA_SENDER_KEY_NONCE_BYTES));
        const plaintext = utf8ToBytes(JSON.stringify({ sender_key: toBase64(capturedKey), epoch }));
        try {
          const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(nonce) }, key, toArrayBuffer(plaintext));
          assertCurrent(); return encodeEnvelopePayload({ v: 1, nonce: toBase64(nonce), ciphertext: toBase64(new Uint8Array(ciphertext)) });
        } finally { plaintext.fill(0); }
      } finally { material.fill(0); }
    });
  } finally { capturedKey.fill(0); }
}

export async function unwrapDeliveredMediaSenderKey(
  scope: string,
  senderUserId: string,
  payload: Uint8Array,
  account?: OperationContext,
): Promise<{ epoch: number; rawKey: Uint8Array }> {
  if (!scope) throw new Error('A media scope is required.');
  const envelope = decodeEnvelopePayload(payload);
  const nonce = fromBase64(envelope.nonce);
  if (nonce.byteLength !== MEDIA_SENDER_KEY_NONCE_BYTES) throw new Error('media sender-key envelope nonce is invalid');
  return withMediaIdentity(account, senderUserId, async (privateKey, publicKey, assertCurrent) => {
    const material = deriveMediaEnvelopeKeyMaterial(scope, privateKey, publicKey);
    try {
      const key = await importEnvelopeAesKey(material); assertCurrent();
      const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toArrayBuffer(nonce) }, key, toArrayBuffer(fromBase64(envelope.ciphertext))));
      try {
        assertCurrent();
        const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as { sender_key?: string; epoch?: number };
        if (typeof parsed.sender_key !== 'string' || !Number.isSafeInteger(parsed.epoch) || parsed.epoch! < 0) throw new Error('media sender-key envelope plaintext is invalid');
        const rawKey = fromBase64(parsed.sender_key);
        if (![16, 32].includes(rawKey.byteLength)) { rawKey.fill(0); throw new Error('media sender key length is invalid'); }
        return { epoch: parsed.epoch!, rawKey };
      } finally { plaintext.fill(0); }
    } finally { material.fill(0); }
  });
}
