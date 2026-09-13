import { useAuthStore } from '../../src/stores/authStore';
import { useServerListStore } from '../../src/stores/serverListStore';
import { useChannelStore } from '../../src/stores/channelStore';
import { setAccessToken } from '../../src/lib/authToken';
import { acceptDatabaseHistoryEpoch } from '../../src/lib/databaseHistory';
import { LOCAL_SERVER_ID } from '../../src/lib/serverScope';
import { openDeviceAccountVault } from '../../src/lib/crypto/deviceAccountVault';
import { AccountMessagingRuntime, startAccountMessagingLifecycle, getAccountMessagingRuntime } from '../../src/lib/messages/accountMessagingRuntime';
import { acceptEncryptedDraft } from '../../src/lib/messages/encryptedDraftSubmission';
import { AccountVault } from '../../src/lib/crypto/accountVault';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '../../src/lib/crypto/util';
import { setUnlockedPrivateKey } from '../../src/lib/accountSession';
import { useAccountStore } from '../../src/stores/accountStore';

export const FIRST_EPOCH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const SECOND_EPOCH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export async function initializeMessagingRuntime(epoch: string | null = FIRST_EPOCH, lifecycle = false, userId = 'alice') {
  const scope = { serverId: LOCAL_SERVER_ID, userId };
  useServerListStore.setState({ activeServerId: LOCAL_SERVER_ID, servers: [] });
  useAuthStore.setState({ token: 'fixture-token', user: { id: userId, username: userId, public_key: null } as never });
  setAccessToken('fixture-token');
  if (epoch) acceptDatabaseHistoryEpoch(scope, epoch);
  const addChannel = () => useChannelStore.getState().addChannel({ id: '2001', guild_id: '1001', type: 0, name: 'general', position: 0 } as never, scope);
  addChannel();
  const stop = lifecycle ? startAccountMessagingLifecycle() : () => {};
  const runtime = lifecycle ? getAccountMessagingRuntime(scope) : new AccountMessagingRuntime(scope);
  await runtime.startLocal();
  return { scope, runtime, addChannel, open: () => openDeviceAccountVault(scope),
    unlockIdentity: () => {
      const key = new Uint8Array(32).fill(31); const publicKey = bytesToHex(ed25519.getPublicKey(key));
      setUnlockedPrivateKey(key);
      useAccountStore.setState({ isUnlocked: true, publicKey });
      useAuthStore.setState(state => ({ user: { ...state.user!, public_key: publicKey } }));
      return publicKey;
    },
    lockIdentity: () => useAccountStore.getState().lock(),
    handshake: () => runtime.acceptHandshake(),
    history: (value: string) => { acceptDatabaseHistoryEpoch(scope, value); addChannel(); },
    logout: () => useAuthStore.setState({ token: null, user: null }),
    close: () => { runtime.dispose(); stop(); }, acceptEncryptedDraft, AccountVault,
  };
}
