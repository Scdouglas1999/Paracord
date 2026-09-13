import { ed25519 } from '@noble/curves/ed25519.js';
import { useAuthStore } from '../../src/stores/authStore';
import { useServerListStore } from '../../src/stores/serverListStore';
import { setAccessToken } from '../../src/lib/authToken';
import { setUnlockedPrivateKey, clearUnlockedPrivateKey } from '../../src/lib/accountSession';
import { LOCAL_SERVER_ID } from '../../src/lib/serverScope';
import { openAccountVault } from '../../src/lib/crypto/accountVaultSession';
import { createAccountPrekeyEnrollment } from '../../src/lib/crypto/prekeyEnrollment';
import { bytesToHex, toBase64 } from '../../src/lib/crypto/util';
import { generatePrekeyBundle, serializePrekeyStore } from '../../src/lib/crypto/sessionManager';
import { readSignalPrekeys, writeSignalPrekeys } from '../../src/lib/crypto/signalVault';

export async function initializePrekeyFixture() {
  const key = new Uint8Array(32).fill(31);
  const identity = bytesToHex(ed25519.getPublicKey(key));
  useServerListStore.setState({ activeServerId: LOCAL_SERVER_ID, servers: [] });
  useAuthStore.setState({ token: 'fixture-token', user: { id: 'alice', username: 'Alice', public_key: identity } as never });
  setAccessToken('fixture-token'); setUnlockedPrivateKey(key.slice());
  const session = await openAccountVault({ serverId: LOCAL_SERVER_ID, userId: 'alice' });
  const driver = createAccountPrekeyEnrollment(session);
  return { session, driver, identity, lock: clearUnlockedPrivateKey,
    inspect: () => session.vault.transact(async tx => ({ keys: await readSignalPrekeys(tx), pending: await tx.list('signal.publications') })),
    consumeFirstPrivatePrekey: () => session.vault.transact(async tx => {
      const store = await readSignalPrekeys(tx);
      if (!store?.oneTimePrekeys.length) throw new Error('No private prekey to consume');
      const id = store.oneTimePrekeys[0].id;
      writeSignalPrekeys(tx, { ...store, oneTimePrekeys: store.oneTimePrekeys.slice(1) });
      return id;
    }),
    seedLegacy() {
      const store = generatePrekeyBundle(key);
      localStorage.setItem('paracord:signal:prekeys', JSON.stringify(serializePrekeyStore(store)));
      return { identity_key: identity, signed_prekey: { id: store.signedPrekey.id, public_key: toBase64(store.signedPrekey.publicKey), signature: toBase64(ed25519.sign(store.signedPrekey.publicKey, key)) },
        one_time_prekeys: store.oneTimePrekeys.map(key => ({ id: key.id, public_key: toBase64(key.publicKey) })),
        last_resort_prekey: { id: store.lastResortPrekey!.id, public_key: toBase64(store.lastResortPrekey!.publicKey) } };
    },
  };
}
