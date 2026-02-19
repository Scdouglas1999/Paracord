import { withUnlockedPrivateKey } from './accountSession';
import { keysApi } from '../api/keys';
import { toBase64 } from './crypto/util';
import {
  loadPrekeyStore,
  savePrekeyStore,
  generatePrekeyBundle,
  generateAdditionalOPKs,
} from './crypto/sessionManager';
import { OPK_LOW_THRESHOLD, OPK_BATCH_SIZE, SIGNED_PREKEY_ROTATION_MS } from './crypto/types';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';

/**
 * Ensure the local user's Signal prekeys are generated and uploaded.
 * Called on READY after gateway connection is established.
 *
 * 1. Loads or generates local prekey store
 * 2. Checks server-side OPK count
 * 3. Uploads signed prekey if not yet uploaded
 * 4. Generates + uploads more OPKs if below threshold
 * 5. Rotates signed prekey if older than 7 days
 */
export async function ensurePrekeysUploaded(): Promise<void> {
  await withUnlockedPrivateKey(async (privateKey) => {
    let store = await loadPrekeyStore();

    if (!store) {
      // First time: generate a fresh prekey bundle
      store = generatePrekeyBundle(privateKey);
      await savePrekeyStore(store);

      // Upload everything
      const spkSig = ed25519.sign(store.signedPrekey.publicKey, privateKey);
      await keysApi.uploadKeys({
        signed_prekey: {
          id: store.signedPrekey.id,
          public_key: toBase64(store.signedPrekey.publicKey),
          signature: toBase64(spkSig),
        },
        one_time_prekeys: store.oneTimePrekeys.map((k) => ({
          id: k.id,
          public_key: toBase64(k.publicKey),
        })),
      });
      return;
    }

    // Check server-side key counts
    const { data: counts } = await keysApi.getKeyCount();

    // Upload signed prekey if not yet uploaded or if it needs rotation
    const needsRotation =
      Date.now() - store.signedPrekey.createdAt > SIGNED_PREKEY_ROTATION_MS;

    if (!counts.signed_prekey_uploaded || needsRotation) {
      if (needsRotation) {
        // Generate a new signed prekey
        const newPriv = x25519.utils.randomSecretKey();
        const newPub = x25519.getPublicKey(newPriv);
        const newId = Date.now();
        store = {
          ...store,
          signedPrekey: {
            id: newId,
            publicKey: newPub,
            privateKey: newPriv,
            createdAt: Date.now(),
          },
        };
        await savePrekeyStore(store);
      }

      const spkSig = ed25519.sign(store.signedPrekey.publicKey, privateKey);
      await keysApi.uploadKeys({
        signed_prekey: {
          id: store.signedPrekey.id,
          public_key: toBase64(store.signedPrekey.publicKey),
          signature: toBase64(spkSig),
        },
      });
    }

    // Replenish OPKs if below threshold
    if (counts.one_time_prekeys_remaining < OPK_LOW_THRESHOLD) {
      const needed = OPK_BATCH_SIZE - counts.one_time_prekeys_remaining;
      if (needed > 0) {
        const { store: updatedStore, newPublicKeys } = generateAdditionalOPKs(store, needed);
        store = updatedStore;
        await savePrekeyStore(store);

        await keysApi.uploadKeys({
          one_time_prekeys: newPublicKeys.map((k) => ({
            id: k.id,
            public_key: toBase64(k.publicKey),
          })),
        });
      }
    }
  });
}
