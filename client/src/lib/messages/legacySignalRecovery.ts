import { ed25519 } from '@noble/curves/ed25519.js';
import type { AccountVault } from '../crypto/accountVault';
import { bytesToHex } from '../crypto/util';
import { SIGNAL_CHANNEL_PIN_NAMESPACE } from '../crypto/signalVault';
import { readStoredValueForMigration } from '../secureStorage';

const NAMESPACE = 'messages.legacy-signal-review';
export class LegacySignalRecoveryError extends Error {
  constructor() { super('This conversation has older encryption material without verifiable server ownership. Review recovery before starting a new encrypted session.'); }
}
export async function assertLegacySignalReviewed(vault: AccountVault, privateKey: Uint8Array, channelId: string, peer: { id: string; publicKey: string }) {
  const existing = await vault.transact(async tx => ({ pin: await tx.get(SIGNAL_CHANNEL_PIN_NAMESPACE, channelId), review: await tx.get<{ peerId: string; publicKey: string }>(NAMESPACE, channelId) }));
  if (existing.pin || (existing.review?.peerId === peer.id && existing.review.publicKey === peer.publicKey.toLowerCase())) return;
  const pair = [bytesToHex(ed25519.getPublicKey(privateKey)), peer.publicKey.toLowerCase()].sort().join(':');
  const sessions = await Promise.all([`paracord:signal:session:${pair}`, `signal:session:${pair}`].map(readStoredValueForMigration));
  if (sessions.some(value => value !== null)) throw new LegacySignalRecoveryError();
  for (const [key, id] of [['paracord:dm-peer-identity-pins', channelId], ['paracord:key-verification-store', peer.id], ['paracord:identity-verification:v1', peer.id]]) {
    const raw = await readStoredValueForMigration(key);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') throw new Error('Older identity trust records could not be read. Recover the original device profile.');
      if (parsed[id]) throw new LegacySignalRecoveryError();
    }
  }
}
/** The UI must explain that new sessions do not recover missing historical keys. */
export async function approveNewSignalSession(vault: AccountVault, channelId: string, peer: { id: string; publicKey: string }) {
  await vault.transact(async tx => tx.put(NAMESPACE, channelId, { peerId: peer.id, publicKey: peer.publicKey.toLowerCase(), approvedAt: new Date().toISOString() }));
}
