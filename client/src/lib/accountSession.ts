import { generateRecoveryPhrase, signChallenge } from './account';

let unlockedPrivateKey: Uint8Array | null = null;
const activeLeases = new Set<UnlockedKeyLease>();

export interface UnlockedKeyLease {
  readonly privateKey: Uint8Array;
  readonly signal: AbortSignal;
  assertCurrent(): void;
  dispose(): void;
}

function requireUnlockedPrivateKey(): Uint8Array {
  if (!unlockedPrivateKey) throw new Error('Account not unlocked');
  return unlockedPrivateKey;
}

/** A key operation owns a disposable copy and is invalidated on lock/replacement. */
export function leaseUnlockedPrivateKey(): UnlockedKeyLease {
  const source = requireUnlockedPrivateKey();
  const privateKey = source.slice();
  const controller = new AbortController();
  const lease: UnlockedKeyLease = {
    privateKey,
    signal: controller.signal,
    assertCurrent() {
      if (controller.signal.aborted || source !== unlockedPrivateKey) {
        throw new Error('The unlocked account changed before this operation completed.');
      }
    },
    dispose() {
      activeLeases.delete(lease);
      privateKey.fill(0);
      controller.abort();
    },
  };
  activeLeases.add(lease);
  return lease;
}

export function setUnlockedPrivateKey(privateKey: Uint8Array): void {
  if (privateKey.byteLength !== 32) throw new Error('Account identity keys must contain 32 bytes.');
  // Copy before revoking leases: the caller may be installing a leased key.
  const next = privateKey.slice();
  clearUnlockedPrivateKey();
  unlockedPrivateKey = next;
  privateKey.fill(0);
}

export function clearUnlockedPrivateKey(): void {
  for (const lease of activeLeases) lease.dispose();
  unlockedPrivateKey?.fill(0);
  unlockedPrivateKey = null;
}

export function hasUnlockedPrivateKey(): boolean {
  return unlockedPrivateKey !== null;
}

export async function signServerChallengeWithUnlockedKey(
  nonce: string,
  timestamp: number,
  serverOrigin: string,
): Promise<string> {
  return withUnlockedPrivateKey(key => signChallenge(key, nonce, timestamp, serverOrigin));
}

export function getRecoveryPhraseFromUnlockedKey(): string | null {
  return unlockedPrivateKey ? generateRecoveryPhrase(unlockedPrivateKey) : null;
}

export async function withUnlockedPrivateKey<T>(
  run: (privateKey: Uint8Array, lease: UnlockedKeyLease) => Promise<T>,
): Promise<T> {
  const lease = leaseUnlockedPrivateKey();
  try {
    const result = await run(lease.privateKey, lease);
    lease.assertCurrent();
    return result;
  } finally { lease.dispose(); }
}
