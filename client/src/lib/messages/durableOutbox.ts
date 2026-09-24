import type { PreparedDeliveryEdit } from './durableEdit';
import type { ForwardedFromRequest, SendMessageRequest } from '../../types';
import type { AccountVault, VaultTransaction } from '../crypto/accountVault';
import type { SealedForward } from './attachments/attachmentEnvelope';
// Encrypted attachment seam: a discarded draft must take its staged ciphertext
// with it, so no encrypted body outlives the message that owned it.
import { removeStagedAttachments } from './attachments/attachmentStaging';

export const OUTBOX_NAMESPACE = 'messages.outbox';
export const INTENT_NAMESPACE = 'messages.intents';

export interface DurableSend {
  readonly id: string;
  readonly sequence: number;
  readonly channelId: string;
  /** Exact JSON body. Replays must never rebuild or re-encrypt it. */
  readonly serializedRequest: string;
  readonly nonce: string;
  draft: { content: string };
  readonly createdAt: string;
  /** Persisted user intent; once set, the original POST must never be replayed. */
  mutation?: { kind: 'discard' } | { kind: 'edit'; editNonce: string; content: string;
    prepared?: PreparedDeliveryEdit; next?: { editNonce: string; content: string } };
  status: 'pending' | 'failed';
  attempts: number;
  nextAttemptAt: number;
  /** Server-mandated earliest retry; manual retry cannot bypass it. */
  retryAfterAt?: number;
  error: string | null;
  /**
   * The server *refused* this message on policy — an AutoMod block, a lost
   * permission, a validation 4xx — rather than failing to take it. A refusal is
   * terminal: the same bytes under the same nonce will be refused identically
   * for as long as the rule stands, so the queue must offer Edit and Discard
   * and must never offer Retry. A network failure, a 5xx or a timeout is not a
   * refusal and keeps its retry.
   */
  refused?: boolean;
}

/** Build ciphertext and persist its ratchet state and original request atomically. */
export async function prepareDurableSend(
  vault: AccountVault,
  channelId: string,
  content: string,
  build: (transaction: VaultTransaction, nonce: string) => Promise<SendMessageRequest>,
): Promise<DurableSend> {
  if (!channelId) throw new Error('A conversation is required to queue a message.');
  const nonce = crypto.randomUUID();
  return vault.transact(async transaction => {
    const previous = await transaction.get<number>('messages.delivery', 'sequence') ?? 0;
    const sequence = previous + 1;
    if (!Number.isSafeInteger(previous) || previous < 0 || !Number.isSafeInteger(sequence)) throw new Error('The delivery sequence cannot advance safely.');
    const request = await build(transaction, nonce);
    if (request.nonce !== nonce) throw new Error('The queued request must retain its original nonce.');
    const queued: DurableSend = {
      id: nonce, sequence, channelId, nonce, serializedRequest: JSON.stringify(request), draft: { content },
      createdAt: new Date().toISOString(), status: 'pending', attempts: 0, nextAttemptAt: 0, error: null,
    };
    transaction.put('messages.delivery', 'sequence', sequence);
    transaction.put(OUTBOX_NAMESPACE, nonce, queued);
    return queued;
  });
}

export async function listDurableSends(vault: AccountVault): Promise<DurableSend[]> {
  return vault.transact(async transaction => (await transaction.list<DurableSend>(OUTBOX_NAMESPACE))
    .map(record => record.value)
    .sort((a, b) => a.sequence - b.sequence));
}

/** A draft has no wire payload or advanced ratchet until it reaches its lane head. */
export interface DurableIntent extends Omit<DurableSend, 'serializedRequest'> {
  readonly revision: string;
  readonly intent: {
    encryption:
      | { kind: 'dm'; peer: { id: string; publicKey: string } }
      | { kind: 'group'; members: Array<{ id: string; publicKey: string }> }
      | { kind: 'plain' };
    referencedMessageId?: string;
    attachmentIds?: string[];
    stickerIds?: string[];
    forwardedFrom?: ForwardedFromRequest;
    /** Attribution for a forward between encrypted conversations; sealed into the body, never sent in the clear. */
    sealedForward?: SealedForward;
  };
}
export type QueuedSend = DurableSend | DurableIntent;
export function isPreparedSend(record: QueuedSend): record is DurableSend {
  return 'serializedRequest' in record;
}

export async function enqueueMessageIntent(
  vault: AccountVault, channelId: string, content: string, intent: DurableIntent['intent'],
  stage?: StageQueuedMessage,
): Promise<DurableIntent> {
  if (!channelId) throw new Error('A conversation is required to queue a message.');
  const nonce = crypto.randomUUID();
  return vault.transact(tx => enqueueMessageIntentInTransaction(tx, channelId, content, intent, nonce, stage));
}

/**
 * Extra durable state committed with a queued draft, in the same transaction.
 * Used by the encrypted attachment producer so a draft and the encrypted bodies
 * it owns can never exist without each other.
 */
export type StageQueuedMessage = (tx: VaultTransaction, messageId: string) => void | Promise<void>;

/** Shared transaction entrypoint for idempotent encrypted composer acceptance. */
export async function enqueueMessageIntentInTransaction(
  tx: VaultTransaction, channelId: string, content: string, intent: DurableIntent['intent'], nonce: string,
  stage?: StageQueuedMessage,
): Promise<DurableIntent> {
    if (!channelId || !nonce) throw new Error('An owned conversation and delivery identity are required.');
    const previous = await tx.get<number>('messages.delivery', 'sequence') ?? 0;
    const sequence = previous + 1;
    if (!Number.isSafeInteger(previous) || previous < 0 || !Number.isSafeInteger(sequence)) throw new Error('The delivery sequence cannot advance safely.');
    const record: DurableIntent = {
      id: nonce, nonce, sequence, channelId, draft: { content }, intent: structuredClone(intent),
      revision: crypto.randomUUID(), createdAt: new Date().toISOString(), status: 'pending',
      attempts: 0, nextAttemptAt: 0, error: null,
    };
    tx.put('messages.delivery', 'sequence', sequence);
    tx.put(INTENT_NAMESPACE, nonce, record);
    await stage?.(tx, nonce);
    return record;
}

export async function listQueuedSends(vault: AccountVault): Promise<QueuedSend[]> {
  return vault.transact(async tx => {
    const prepared = await tx.list<DurableSend>(OUTBOX_NAMESPACE);
    const intents = await tx.list<DurableIntent>(INTENT_NAMESPACE);
    return [...prepared.map(row => row.value), ...intents.map(row => row.value)].sort((a, b) => a.sequence - b.sequence);
  });
}

async function requireEditableIntent(tx: VaultTransaction, id: string, revision: string) {
  const current = await tx.get<DurableIntent>(INTENT_NAMESPACE, id);
  if (!current) {
    if (await tx.get(OUTBOX_NAMESPACE, id)) throw new Error('This message has been prepared for delivery. Resolve its delivery before changing it.');
    throw new Error('This draft is no longer in the outbox.');
  }
  if (current.revision !== revision) throw new Error('This draft changed in another window. Review its latest contents before changing it.');
  return current;
}

/** The vault transaction arbitrates editing versus preparation across all tabs. */
export async function editMessageIntent(vault: AccountVault, id: string, revision: string, content: string) {
  return vault.transact(async tx => {
    const current = await requireEditableIntent(tx, id, revision);
    const updated = { ...current, draft: { content }, revision: crypto.randomUUID(), status: 'pending' as const,
      error: null, refused: false, nextAttemptAt: current.retryAfterAt ?? 0 };
    tx.put(INTENT_NAMESPACE, id, updated);
    return updated;
  });
}

export async function discardMessageIntent(vault: AccountVault, id: string, revision: string) {
  return vault.transact(async tx => {
    await requireEditableIntent(tx, id, revision);
    tx.remove(INTENT_NAMESPACE, id);
    await removeStagedAttachments(tx, id);
  });
}

/** Called only for a lane head, inside the same transaction as its crypto writes. */
export function commitPreparedIntent(tx: VaultTransaction, intent: DurableIntent, request: SendMessageRequest): DurableSend {
  if (request.nonce !== intent.nonce) throw new Error('The queued request must retain its original nonce.');
  const { revision: _revision, intent: _intent, ...metadata } = intent;
  const prepared = { ...metadata, serializedRequest: JSON.stringify(request) };
  tx.put(OUTBOX_NAMESPACE, intent.id, prepared);
  tx.remove(INTENT_NAMESPACE, intent.id);
  return prepared;
}
