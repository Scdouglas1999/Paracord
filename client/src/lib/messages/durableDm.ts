import type { PreparedDeliveryEdit } from './durableEdit';
import type { ForwardedFromRequest, Message, MessageE2eePayload, SendMessageRequest } from '../../types';
import type { DmCipherDependencies } from '../dmCipher';
import type { AccountVault, VaultTransaction } from '../crypto/accountVault';
import { assertSignalMessageId, createSignalSessionCipher, retireSignalSendingSession, type SignalSessionReference } from '../crypto/signalSessions';
import { enqueueMessageIntent, prepareDurableSend, type DurableIntent, type DurableSend, type StageQueuedMessage, OUTBOX_NAMESPACE, INTENT_NAMESPACE } from './durableOutbox';
import { bytesToHex } from '../crypto/util';
// Encrypted attachment seam: descriptors live inside the Signal body, and the
// staged ciphertext lives in this account's vault until the server holds it.
import { encodeEncryptedBodyWithinBudget, type EncryptedAttachmentDescriptor } from './attachments/attachmentEnvelope';
import { collectUploadedDescriptors, listStagedAttachments, markStagedUploaded, nextPendingUpload, removeStagedAttachments, rekeyStagedAttachments } from './attachments/attachmentStaging';
import type { EncryptedAttachmentUploader } from './attachments/attachmentProducer';

const PLAINTEXT_NAMESPACE = 'messages.plaintext';
const SEND_SESSION_NAMESPACE = 'messages.signal-sends';
const EXTERNAL_REMOVALS_NAMESPACE = 'messages.signal-removals';
interface SendSession { channelId: string; peer: Peer; referencedMessageId?: string; forwardedFrom?: ForwardedFromRequest; session: SignalSessionReference }
interface Peer { id: string; publicKey: string }

async function cacheId(channelId: string, peer: Peer, payload: MessageE2eePayload): Promise<string> {
  const envelope = JSON.stringify([channelId, peer.id, peer.publicKey.toLowerCase(), payload.version, payload.nonce, payload.ciphertext, payload.header ?? null]);
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(envelope))));
}

/** Account-owned DM crypto and delivery preparation. The supplied client is fixed to that account's server. */
export function createDurableDm(vault: AccountVault, privateKey: Uint8Array, keysApi: DmCipherDependencies['keysApi'],
  uploadAttachment?: EncryptedAttachmentUploader) {
  async function build(transaction: VaultTransaction, nonce: string, channelId: string, peer: Peer, content: string, referencedMessageId?: string,
    attachments: readonly EncryptedAttachmentDescriptor[] = [], forwardedFrom?: ForwardedFromRequest): Promise<SendMessageRequest> {
    // With attachments the encrypted plaintext becomes a versioned body that
    // carries their keys and real metadata; without them it stays the bare text
    // every earlier message used.
    const body = attachments.length ? encodeEncryptedBodyWithinBudget({ text: content, attachments }) : content;
    const cipher = createSignalSessionCipher(transaction, channelId, keysApi);
    const { payload: e2ee, session } = await cipher.encryptDmMessageWithSession(channelId, body, privateKey, peer.publicKey, peer.id);
    transaction.put(SEND_SESSION_NAMESPACE, nonce, { channelId, peer, referencedMessageId, forwardedFrom, session } satisfies SendSession);
    const id = await cacheId(channelId, peer, e2ee);
    transaction.put(PLAINTEXT_NAMESPACE, id, { content: body });
    return { nonce, content: '', e2ee, referenced_message_id: referencedMessageId,
      ...(attachments.length ? { attachment_ids: attachments.map(attachment => attachment.id) } : {}),
      ...(forwardedFrom ? { forwarded_from: forwardedFrom } : {}) };
  }
  async function restoreFollowers(transaction: VaultTransaction, channelId: string, session: SignalSessionReference, excludedId?: string) {
    await retireSignalSendingSession(transaction, session);
    // Older eager preparation can leave unattempted followers in this same
    // generation. Preserve their ordering and drafts, then prepare them anew.
    for (const { value: follower } of await transaction.list<DurableSend>(OUTBOX_NAMESPACE)) {
      if (follower.id === excludedId || follower.channelId !== channelId) continue;
      const next = await transaction.get<SendSession>(SEND_SESSION_NAMESPACE, follower.nonce);
      if (!next || next.session.registryId !== session.registryId || next.session.generationId !== session.generationId) continue;
      if (follower.mutation?.kind === 'discard') continue; // It will resolve its own immutable request.
      if (follower.attempts !== 0) throw new Error('Another attempted message still depends on this sending generation. Resolve it before removing this message.');
      const { serializedRequest: _request, mutation, ...metadata } = follower;
      const content = mutation?.kind === 'edit' ? mutation.next?.content ?? mutation.content : follower.draft.content;
      const intent: DurableIntent = { ...metadata, draft: { content }, revision: crypto.randomUUID(), status: 'pending', error: null,
        nextAttemptAt: follower.retryAfterAt ?? 0, intent: { encryption: { kind: 'dm', peer: next.peer }, referencedMessageId: next.referencedMessageId } };
      transaction.put(INTENT_NAMESPACE, follower.id, intent);
      transaction.remove(OUTBOX_NAMESPACE, follower.id);
      transaction.remove(SEND_SESSION_NAMESPACE, follower.nonce);
    }
  }
  async function retireForMutation(transaction: VaultTransaction, removed: DurableSend, removeBinding: boolean) {
    const binding = await transaction.get<SendSession>(SEND_SESSION_NAMESPACE, removed.nonce);
    if (!binding || binding.channelId !== removed.channelId) throw new Error('This prepared message needs its original sending-session metadata before it can be removed.');
    await restoreFollowers(transaction, removed.channelId, binding.session, removed.id);
    if (removeBinding) transaction.remove(SEND_SESSION_NAMESPACE, removed.nonce);
  }

  async function retireDeliveredMessage(transaction: VaultTransaction, channelId: string, peer: Peer) {
    const cipher = createSignalSessionCipher(transaction, channelId, keysApi);
    const active = await cipher.retireSendingSession(privateKey, peer.publicKey);
    if (active) await restoreFollowers(transaction, channelId, active);
    // A historical initial message can belong to an archived generation. All
    // eager followers must be restored before an edit/delete removes its body.
    for (const { value: follower } of await transaction.list<DurableSend>(OUTBOX_NAMESPACE)) {
      if (follower.channelId !== channelId || follower.mutation?.kind === 'discard') continue;
      if (!await transaction.get(OUTBOX_NAMESPACE, follower.id)) continue;
      const binding = await transaction.get<SendSession>(SEND_SESSION_NAMESPACE, follower.nonce);
      if (!binding || binding.channelId !== channelId) throw new Error('A queued follower is missing its original encryption metadata.');
      await restoreFollowers(transaction, channelId, binding.session);
    }
  }

  async function reconcileExternalRemovals(transaction: VaultTransaction, channelId: string, peer: Peer) {
    if (!await transaction.get(EXTERNAL_REMOVALS_NAMESPACE, channelId)) return;
    await retireDeliveredMessage(transaction, channelId, peer);
    transaction.remove(EXTERNAL_REMOVALS_NAMESPACE, channelId);
  }

  return {
    retireDeliveredMessage,
    async acknowledgeSend(transaction: VaultTransaction, nonce: string, message: Message) {
      const binding = await transaction.get<SendSession>(SEND_SESSION_NAMESPACE, nonce);
      if (!binding) return;
      if (binding.channelId !== message.channel_id || message.nonce !== nonce || message.author.id !== vault.scope.userId) throw new Error('The send acknowledgement belongs to another message.');
      const cipher = createSignalSessionCipher(transaction, binding.channelId, keysApi);
      await cipher.acknowledgeSendingSession(privateKey, binding.peer.publicKey, binding.session, message.id);
      // The server now holds the ciphertext and the recipient holds the keys.
      await removeStagedAttachments(transaction, nonce);
    },
    async markExternalRemoval(channelId: string) {
      await vault.transact(async tx => tx.put(EXTERNAL_REMOVALS_NAMESPACE, channelId, { observedAt: new Date().toISOString() }));
    },
    async reconcileExternalRemoval(channelId: string, peer: Peer) {
      await vault.transact(tx => reconcileExternalRemovals(tx, channelId, peer));
    },
    async assertPreparedDeliveryAllowed(channelId: string) {
      if (await vault.transact(tx => tx.get(EXTERNAL_REMOVALS_NAMESPACE, channelId))) throw new Error('A message in this encryption generation was deleted. Resolve attempted queued messages before continuing delivery.');
    },
    enqueue(channelId: string, peer: Peer, content: string, referencedMessageId?: string, stage?: StageQueuedMessage) {
      return enqueueMessageIntent(vault, channelId, content, { encryption: { kind: 'dm', peer }, referencedMessageId }, stage);
    },
    /**
     * Upload this draft's staged ciphertext, one body at a time.
     *
     * Deliberately outside any vault transaction: an upload can take minutes and
     * the account lock is held by every draft save and ratchet advance. Each
     * accepted body commits its own server reference, so a reload resumes where
     * the last one finished instead of re-uploading what the server already has.
     */
    async uploadStagedAttachments(messageId: string) {
      for (;;) {
        const pending = await vault.transact(tx => nextPendingUpload(tx, messageId));
        if (!pending) return;
        if (!uploadAttachment) throw new Error('This account has no encrypted attachment uploader.');
        const uploadedId = await uploadAttachment({
          channelId: pending.record.channelId, objectName: pending.record.objectName, ciphertext: pending.ciphertext,
        });
        await vault.transact(async tx => {
          const current = (await listStagedAttachments(tx, messageId)).find(record => record.index === pending.record.index);
          if (!current || current.uploadedId) return;
          markStagedUploaded(tx, current, uploadedId);
        });
      }
    },
    async prepareIntent(transaction: VaultTransaction, intent: DurableIntent) {
      if (intent.intent.encryption.kind !== 'dm') throw new Error('A DM encryptor cannot prepare an unencrypted draft.');
      if (intent.intent.attachmentIds?.length) throw new Error('An encrypted conversation cannot reference a plaintext upload.');
      await reconcileExternalRemovals(transaction, intent.channelId, intent.intent.encryption.peer);
      const attachments = await collectUploadedDescriptors(transaction, intent.id);
      return build(transaction, intent.nonce, intent.channelId, intent.intent.encryption.peer, intent.draft.content, intent.intent.referencedMessageId, attachments, intent.intent.forwardedFrom);
    },
    async prepare(channelId: string, peer: Peer, content: string, referencedMessageId?: string) {
      return prepareDurableSend(vault, channelId, content, (transaction, nonce) => build(transaction, nonce, channelId, peer, content, referencedMessageId));
    },
    async reconcileRemoved(transaction: VaultTransaction, removed: DurableSend) {
      await retireForMutation(transaction, removed, true);
      await removeStagedAttachments(transaction, removed.id);
    },
    async restoreIntent(transaction: VaultTransaction, original: DurableSend, content: string): Promise<DurableIntent> {
      const binding = await transaction.get<SendSession>(SEND_SESSION_NAMESPACE, original.nonce);
      if (!binding || binding.channelId !== original.channelId) throw new Error('The original conversation encryption metadata is missing.');
      const { serializedRequest: _request, mutation: _mutation, ...metadata } = original;
      const nonce = crypto.randomUUID();
      await rekeyStagedAttachments(transaction, original.id, nonce);
      return { ...metadata, id: nonce, nonce, draft: { content }, revision: crypto.randomUUID(),
        status: 'pending', attempts: 0, error: null, nextAttemptAt: original.retryAfterAt ?? 0,
        intent: { encryption: { kind: 'dm', peer: binding.peer }, referencedMessageId: binding.referencedMessageId, forwardedFrom: binding.forwardedFrom } };
    },
    async prepareEdit(transaction: VaultTransaction, original: DurableSend, messageId: string, editNonce: string, content: string): Promise<PreparedDeliveryEdit> {
      const binding = await transaction.get<SendSession>(SEND_SESSION_NAMESPACE, original.nonce);
      if (!binding || binding.channelId !== original.channelId) throw new Error('The original conversation encryption metadata is missing.');
      await retireForMutation(transaction, original, false);
      // An edit replaces the whole encrypted body, so it must re-state the
      // attachment descriptors or their keys would be lost with the old body.
      const attachments = await collectUploadedDescriptors(transaction, original.id);
      const body = attachments.length ? encodeEncryptedBodyWithinBudget({ text: content, attachments }) : content;
      const cipher = createSignalSessionCipher(transaction, original.channelId, keysApi);
      const { payload: e2ee } = await cipher.encryptDmMessageWithSession(original.channelId, body, privateKey, binding.peer.publicKey, binding.peer.id, { independent: true });
      transaction.put(PLAINTEXT_NAMESPACE, await cacheId(original.channelId, binding.peer, e2ee), { content: body });
      return { channelId: original.channelId, messageId, editNonce, serializedRequest: JSON.stringify({ content: '', e2ee, edit_nonce: editNonce }) };
    },
    /** Delivered edits also cover old server messages with no local creation binding. */
    async prepareDeliveredEdit(transaction: VaultTransaction, channelId: string, peer: Peer, messageId: string, editNonce: string, content: string,
      attachments: readonly EncryptedAttachmentDescriptor[] = []): Promise<PreparedDeliveryEdit> {
      assertSignalMessageId(messageId);
      await retireDeliveredMessage(transaction, channelId, peer);
      const body = attachments.length ? encodeEncryptedBodyWithinBudget({ text: content, attachments }) : content;
      const cipher = createSignalSessionCipher(transaction, channelId, keysApi);
      const { payload: e2ee } = await cipher.encryptDmMessageWithSession(channelId, body, privateKey, peer.publicKey, peer.id, { independent: true });
      transaction.put(PLAINTEXT_NAMESPACE, await cacheId(channelId, peer, e2ee), { content: body });
      return { channelId, messageId, editNonce, serializedRequest: JSON.stringify({ content: '', e2ee, edit_nonce: editNonce }) };
    },
    async decrypt(channelId: string, peer: Peer, payload: MessageE2eePayload, messageId: string): Promise<string> {
      assertSignalMessageId(messageId);
      const id = await cacheId(channelId, peer, payload);
      return vault.transact(async transaction => {
        const cached = await transaction.get<{ content: string }>(PLAINTEXT_NAMESPACE, id);
        if (cached) return cached.content;
        const cipher = createSignalSessionCipher(transaction, channelId, keysApi);
        const content = await cipher.decryptDmMessage(channelId, payload, privateKey, peer.publicKey, peer.id, messageId);
        transaction.put(PLAINTEXT_NAMESPACE, id, { content });
        return content;
      });
    },
  };
}
