import type { AccountVault } from '../crypto/accountVault';
import { accountScopeKey } from '../serverScope';
import { enqueueMessageIntentInTransaction, type DurableIntent, type StageQueuedMessage } from './durableOutbox';

export interface EncryptedMessageDraft { revision: string; content: string }
export const DRAFTS_NAMESPACE = 'messages.drafts';
const SUBMISSIONS_NAMESPACE = 'messages.submissions';
interface Submission {
  id: string; nonce: string; channelId: string; draft: EncryptedMessageDraft;
  intent: DurableIntent['intent']; destination: 'local' | 'identity'; accepted: boolean;
}

/**
 * A device draft and an identity outbox cannot share an IndexedDB transaction.
 * Persist the immutable handoff first, then an idempotent acceptance receipt in
 * the destination transaction. A crash never requires a second delivery nonce.
 * Staged handoffs are resumed only by an explicit submission of that revision.
 */
export async function acceptEncryptedDraft(
  local: AccountVault, destination: AccountVault, destinationKind: Submission['destination'],
  channelId: string, draft: EncryptedMessageDraft, intent: DurableIntent['intent'],
  // Encrypted attachment seam: staged ciphertext commits with the accepted
  // draft, in the destination account's own transaction, so a crash can never
  // leave a queued message whose attachment bodies are missing.
  stage?: StageQueuedMessage,
) {
  if (accountScopeKey(local.scope) !== accountScopeKey(destination.scope)) throw new Error('Draft submission cannot cross account ownership.');
  const id = JSON.stringify([channelId, draft.revision]);
  const staged = await local.transact(async tx => {
    const previous = await tx.get<Submission>(SUBMISSIONS_NAMESPACE, id);
    if (previous) {
      if (previous.destination !== destinationKind || previous.draft.content !== draft.content
        || JSON.stringify(previous.intent) !== JSON.stringify(intent)) throw new Error('This draft revision already has a different saved submission. Review the queue before submitting again.');
      return previous;
    }
    const submission: Submission = { id, nonce: crypto.randomUUID(), channelId, draft: structuredClone(draft),
      intent: structuredClone(intent), destination: destinationKind, accepted: false };
    tx.put(SUBMISSIONS_NAMESPACE, id, submission); return submission;
  });
  await destination.transact(async tx => {
    const accepted = await tx.get<Submission>(SUBMISSIONS_NAMESPACE, id);
    if (accepted?.accepted) {
      if (accepted.nonce !== staged.nonce) throw new Error('The encrypted draft acceptance identity changed.');
      return;
    }
    await enqueueMessageIntentInTransaction(tx, channelId, staged.draft.content.trim(), staged.intent, staged.nonce, stage);
    tx.put(SUBMISSIONS_NAMESPACE, id, { ...staged, accepted: true });
  });
  await local.transact(async tx => {
    tx.put(SUBMISSIONS_NAMESPACE, id, { ...staged, accepted: true });
    if ((await tx.get<EncryptedMessageDraft>(DRAFTS_NAMESPACE, channelId))?.revision === draft.revision) tx.remove(DRAFTS_NAMESPACE, channelId);
  });
  return { nonce: staged.nonce, draftRevision: draft.revision };
}
