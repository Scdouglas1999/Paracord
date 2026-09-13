import type { AccountVault } from '../crypto/accountVault';
import { accountScopeKey, entityScopeKey } from '../serverScope';

export const RECOVERY_NAMESPACE = 'messages.recovery-drafts';
export interface RecoveryDraft { id: string; channelId: string | null; content: string; reason: string; createdAt: string; source: string }
const fingerprint = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join('');

/** Verified account ownership permits recovery, never automatic delivery/history adoption. */
export async function migrateLegacyMessageDrafts(vault: AccountVault, channelId?: string) {
  if (channelId) {
    const key = `paracord:account-draft:${entityScopeKey(vault.scope, channelId)}`;
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      const value = JSON.parse(raw) as { revision?: unknown; content?: unknown };
      if (typeof value.revision !== 'string' || typeof value.content !== 'string') throw new Error('A legacy draft could not be read. Its original storage has been preserved.');
      const id = await fingerprint(JSON.stringify([key, raw]));
      await vault.transact(async tx => tx.put(RECOVERY_NAMESPACE, id, { id, channelId, content: value.content as string,
        source: key, reason: 'Saved before durable encrypted delivery. Review before sending into the current server history.', createdAt: new Date().toISOString() } satisfies RecoveryDraft));
      if (localStorage.getItem(key) === raw) localStorage.removeItem(key);
    }
  }
  for (const queueKey of ['paracord:v2:offline-message-queue', 'paracord:offline-message-queue']) {
    const raw = localStorage.getItem(queueKey);
    if (raw === null) continue;
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows)) throw new Error('The legacy outbox could not be read. Its original storage has been preserved.');
    const owned = rows.filter(row => row?.scope && accountScopeKey(row.scope) === accountScopeKey(vault.scope));
    const recovered: RecoveryDraft[] = [];
    for (const row of owned) {
      if (typeof row.content !== 'string' || typeof row.channelId !== 'string') throw new Error('A legacy queued message is malformed. Recover its original stored data before continuing.');
      const id = await fingerprint(JSON.stringify([queueKey, row]));
      recovered.push({ id, channelId: row.channelId, content: row.content, source: queueKey,
        reason: 'Previous delivery may already have committed. Review the conversation before sending this recovered draft.',
        createdAt: typeof row.createdAt === 'string' ? row.createdAt : new Date().toISOString() });
    }
    await vault.transact(async tx => { for (const row of recovered) tx.put(RECOVERY_NAMESPACE, row.id, row); });
    if (recovered.length && localStorage.getItem(queueKey) === raw) {
      localStorage.setItem(queueKey, JSON.stringify(rows.filter(row => !owned.includes(row))));
    }
  }
}
