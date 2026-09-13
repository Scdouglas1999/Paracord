import type { DmCipherDependencies } from '../dmCipher';
import { IdentityPinError, formatIdentityFingerprint } from '../keyVerification';
import { deserializePrekeyStore, serializePrekeyStore } from './sessionManager';
import type { VaultTransaction } from './accountVault';
import { CHANNEL_PIN_NAMESPACE, IDENTITY_PIN_NAMESPACE } from './identityPinNamespaces';
import { readChannelPin, readIdentityPin, writeChannelPin, writeIdentityPin } from './identityTrust';
import type { LocalPrekeyStore, SerializedLocalPrekeyStore } from './types';

export const SIGNAL_PREKEY_NAMESPACE = 'signal.prekeys';
export const SIGNAL_SESSION_NAMESPACE = 'signal.sessions';
/**
 * The pin namespaces are shared with `identityTrust.ts`: the record this path
 * enforces on is the same record the profile card's verification decision
 * writes, so verifying a peer is what releases a refused rotation.
 */
export const SIGNAL_USER_PIN_NAMESPACE = IDENTITY_PIN_NAMESPACE;
export const SIGNAL_CHANNEL_PIN_NAMESPACE = CHANNEL_PIN_NAMESPACE;

export async function readSignalPrekeys(transaction: VaultTransaction): Promise<LocalPrekeyStore | null> {
  const saved = await transaction.get<SerializedLocalPrekeyStore>(SIGNAL_PREKEY_NAMESPACE, 'current');
  return saved ? deserializePrekeyStore(saved) : null;
}
export function writeSignalPrekeys(transaction: VaultTransaction, prekeys: LocalPrekeyStore): void {
  transaction.put(SIGNAL_PREKEY_NAMESPACE, 'current', serializePrekeyStore(prekeys));
}

/** Prekey and trust changes share the transaction with the session registry. */
export function createSignalVaultDependencies(
  transaction: VaultTransaction,
  channelId: string,
  keysApi: DmCipherDependencies['keysApi'],
): Omit<DmCipherDependencies, 'loadSession' | 'saveSession'> {
  return {
    keysApi,
    loadPrekeyStore: () => readSignalPrekeys(transaction),
    async savePrekeyStore(store) { writeSignalPrekeys(transaction, store); },
    async assertPinnedDmPeerIdentity(channel, identity, peerUserId) {
      if (channel !== channelId) throw new Error('The cipher belongs to a different conversation.');
      const presented = identity.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(presented)) {
        throw new IdentityPinError('IDENTITY_KEY_MISSING', 'The peer has no valid identity key.', { channelId, userId: peerUserId ?? undefined });
      }
      const pinnedChannel = await readChannelPin(transaction, channelId);
      const peer = peerUserId ?? (pinnedChannel?.userId || undefined);
      if (!peer) throw new IdentityPinError('IDENTITY_KEY_MISSING', 'The peer identity for this conversation is unavailable.', { channelId });
      const pinnedUser = await readIdentityPin(transaction, peer);
      const previous = pinnedUser?.identity ?? pinnedChannel?.identity;
      if ((previous && previous !== presented) || (pinnedChannel && (pinnedChannel.userId !== peer || pinnedChannel.identity !== presented))) {
        throw new IdentityPinError('IDENTITY_KEY_ROTATED', 'The peer identity changed. Verify the new fingerprint before sending.', {
          channelId, userId: peer, pinnedFingerprint: previous ? formatIdentityFingerprint(previous) : undefined,
          presentedFingerprint: formatIdentityFingerprint(presented),
        });
      }
      if (!pinnedUser) writeIdentityPin(transaction, peer, { identity: presented, firstSeenAt: new Date().toISOString() });
      if (!pinnedChannel) writeChannelPin(transaction, channelId, { userId: peer, identity: presented, pinnedAt: new Date().toISOString() });
    },
  };
}
