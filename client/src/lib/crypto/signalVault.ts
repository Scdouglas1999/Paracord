import type { DmCipherDependencies } from '../dmCipher';
import { IdentityPinError, formatIdentityFingerprint } from '../keyVerification';
import { deserializePrekeyStore, serializePrekeyStore } from './sessionManager';
import type { VaultTransaction } from './accountVault';
import type { LocalPrekeyStore, SerializedLocalPrekeyStore } from './types';

export const SIGNAL_PREKEY_NAMESPACE = 'signal.prekeys';
export const SIGNAL_SESSION_NAMESPACE = 'signal.sessions';
export const SIGNAL_USER_PIN_NAMESPACE = 'signal.identity-pins';
export const SIGNAL_CHANNEL_PIN_NAMESPACE = 'signal.channel-pins';

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
      const pinnedChannel = await transaction.get<{ userId: string; identity: string }>(SIGNAL_CHANNEL_PIN_NAMESPACE, channelId);
      const peer = peerUserId ?? pinnedChannel?.userId;
      if (!peer) throw new IdentityPinError('IDENTITY_KEY_MISSING', 'The peer identity for this conversation is unavailable.', { channelId });
      const pinnedUser = await transaction.get<{ identity: string }>(SIGNAL_USER_PIN_NAMESPACE, peer);
      const previous = pinnedUser?.identity ?? pinnedChannel?.identity;
      if ((previous && previous !== presented) || (pinnedChannel && (pinnedChannel.userId !== peer || pinnedChannel.identity !== presented))) {
        throw new IdentityPinError('IDENTITY_KEY_ROTATED', 'The peer identity changed. Verify the new fingerprint before sending.', {
          channelId, userId: peer, pinnedFingerprint: previous ? formatIdentityFingerprint(previous) : undefined,
          presentedFingerprint: formatIdentityFingerprint(presented),
        });
      }
      if (!pinnedUser) transaction.put(SIGNAL_USER_PIN_NAMESPACE, peer, { identity: presented, firstSeenAt: new Date().toISOString() });
      if (!pinnedChannel) transaction.put(SIGNAL_CHANNEL_PIN_NAMESPACE, channelId, { userId: peer, identity: presented });
    },
  };
}
