import { ed25519 } from '@noble/curves/ed25519.js';
import { leaseUnlockedPrivateKey } from '../accountSession';
import { captureScopedOperation } from '../operationContext';
import { getServerUser } from '../serverIdentity';
import type { AccountScope } from '../serverScope';
import { bytesToHex } from './util';
import { AccountVault } from './accountVault';

/** Bind durable records to both the verified server account and unlocked identity. */
export async function openAccountVault(scope: AccountScope) {
  const context = captureScopedOperation(scope);
  let releaseKey: (() => void) | undefined;
  try {
    const lease = leaseUnlockedPrivateKey();
    releaseKey = lease.dispose;
    const publicKey = bytesToHex(ed25519.getPublicKey(lease.privateKey));
    if (!context.user.public_key || context.user.public_key.toLowerCase() !== publicKey) {
      throw new Error('Unlock the identity enrolled for this server account before accessing encrypted messages.');
    }
    const assertCurrent = () => {
      context.assertCurrent(); lease.assertCurrent();
      if (getServerUser(scope.serverId)?.public_key?.toLowerCase() !== publicKey) {
        context.dispose();
        throw new Error('The identity enrolled for this server account changed. Unlock its current identity to continue.');
      }
    };
    const signal = AbortSignal.any([context.signal, lease.signal]);
    const vault = await AccountVault.open(context.scope, lease.privateKey, { signal, assertCurrent });
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      vault.close(); lease.dispose(); context.dispose();
    };
    signal.addEventListener('abort', dispose, { once: true });
    assertCurrent();
    return { vault, context, privateKey: lease.privateKey, signal, assertCurrent, dispose };
  } catch (error) { releaseKey?.(); context.dispose(); throw error; }
}
