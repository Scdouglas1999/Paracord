import type { AccountVault } from '../crypto/accountVault';
import { RECOVERY_NAMESPACE, type RecoveryDraft } from './legacyRecovery';

const NAMESPACE = 'messages.runtime-history';
export const HISTORY_ARCHIVE_NAMESPACE = 'messages.history-archive';
const LOCAL_HISTORY_NAMESPACES = ['messages.outbox', 'messages.intents', 'messages.drafts', 'messages.delivered-mutations',
  'messages.delivery-receipts', 'messages.mutation-receipts', 'messages.deleted', 'messages.delivery', 'messages.submissions', 'messages.encrypted-inbox', 'messages.recovery-cursors', 'messages.recovery-envelopes', 'messages.authoritative-state', 'messages.recovery-blocks'];
interface HistoryBinding { epoch: string | null; initialLease: string | null }
export type VaultHistoryState = { kind: 'ready' } | { kind: 'awaiting-handshake' } | { kind: 'review'; previousEpoch: string | null };

/** Only the original in-memory account lease can adopt first-handshake drafts. */
export async function bindMessagingHistory(vault: AccountVault, epoch: string | null, initialLease: string): Promise<VaultHistoryState> {
  return vault.transact(async tx => {
    const saved = async () => (await Promise.all([...LOCAL_HISTORY_NAMESPACES, 'signal.prekeys', 'signal.sessions', 'signal.identity-pins', 'signal.channel-pins']
      .map(namespace => tx.list(namespace)))).some(rows => rows.length);
    const previous = await tx.get<HistoryBinding>(NAMESPACE, 'current');
    if (!previous) {
      if (await saved()) return { kind: 'review', previousEpoch: null };
      tx.put(NAMESPACE, 'current', { epoch, initialLease: epoch ? null : initialLease });
      return { kind: epoch ? 'ready' : 'awaiting-handshake' };
    }
    if (previous.epoch === epoch && epoch) return { kind: 'ready' };
    // A pre-handshake binding that saved nothing has no records to review, so a
    // reload before this account's first authenticated handshake takes over the
    // lease instead of claiming the server's database history changed.
    if (previous.epoch === null && previous.initialLease !== initialLease && !(await saved())) previous.initialLease = initialLease;
    if (previous.epoch === null && previous.initialLease === initialLease) {
      if (!epoch) { tx.put(NAMESPACE, 'current', { epoch: null, initialLease }); return { kind: 'awaiting-handshake' }; }
      tx.put(NAMESPACE, 'current', { epoch, initialLease: null });
      return { kind: 'ready' };
    }
    return { kind: 'review', previousEpoch: previous.epoch };
  });
}

/**
 * Explicit review action for the device vault only. Preserve exact old records
 * and text before retiring their active addresses, then allow fresh local work.
 * This does not import old IDs, retry old requests or reset Signal keys.
 */
export async function archiveLocalMessagingHistory(vault: AccountVault, epoch: string, expectedPreviousEpoch: string | null) {
  if (!epoch) throw new Error('Wait for an authenticated server history before reviewing saved messages.');
  return vault.transact(async tx => {
    const previous = await tx.get<HistoryBinding>(NAMESPACE, 'current');
    if ((previous?.epoch ?? null) !== expectedPreviousEpoch) throw new Error('Saved history changed in another window. Review it again.');
    if (previous?.epoch === epoch) return;
    if ((await Promise.all(['signal.prekeys', 'signal.sessions', 'signal.identity-pins', 'signal.channel-pins'].map(namespace => tx.list(namespace)))).some(rows => rows.length)) throw new Error('Encryption state requires identity recovery and cannot use local draft recovery.');
    const batch = crypto.randomUUID(); const createdAt = new Date().toISOString();
    for (const namespace of LOCAL_HISTORY_NAMESPACES) {
      for (const { id, value } of await tx.list<Record<string, unknown>>(namespace)) {
        const archiveId = JSON.stringify([batch, namespace, id]);
        tx.put(HISTORY_ARCHIVE_NAMESPACE, archiveId, { namespace, id, value, previousEpoch: previous?.epoch ?? null, archivedAt: createdAt });
        const row = value as { content?: unknown; channelId?: unknown; draft?: { content?: unknown }; target?: { channelId?: unknown } };
        const content = namespace === 'messages.drafts' ? row.content : row.draft?.content;
        if (typeof content === 'string') {
          const channelId = namespace === 'messages.drafts' ? id : row.channelId ?? row.target?.channelId;
          tx.put(RECOVERY_NAMESPACE, archiveId, { id: archiveId, channelId: typeof channelId === 'string' ? channelId : null,
            content, reason: 'Saved for a different or unknown server history. Original delivery may have committed. Review the current conversation before copying this text into a fresh draft.',
            createdAt, source: `history:${previous?.epoch ?? 'unknown'}:${namespace}` } satisfies RecoveryDraft);
        }
        tx.remove(namespace, id);
      }
    }
    for (const [source, target] of [[`messages.held-inbox:${epoch}`, 'messages.encrypted-inbox'], [`messages.held-deletions:${epoch}`, 'messages.deleted']]) {
      for (const { id, value } of await tx.list(source)) { tx.put(target, id, value); tx.remove(source, id); }
    }
    tx.put(NAMESPACE, 'current', { epoch, initialLease: null });
  });
}
