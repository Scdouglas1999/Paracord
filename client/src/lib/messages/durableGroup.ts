import type { PreparedDeliveryEdit } from './durableEdit';
import type { ForwardedFromRequest, Message, MessageE2eePayload, SendMessageRequest } from '../../types';
import type { AccountVault, VaultTransaction } from '../crypto/accountVault';
import {
  buildSenderKeyEnvelopes,
  commitSenderKeys,
  ensureLocalSenderKey,
  GroupE2eeError,
  markDistributed,
  openGroupMessage,
  pendingDistribution,
  readGroupMessageClaim,
  readLocalSenderKey,
  readReceivedSenderKey,
  sealGroupMessage,
  verifySenderKeyEnvelopes,
  type GroupMember,
  type IncomingSenderKeyEnvelope,
} from '../crypto/groupSenderKeys';
import { assertSignalMessageId } from '../crypto/signalSessions';
import { bytesToHex } from '../crypto/util';
import { enqueueMessageIntent, prepareDurableSend, type DurableIntent, type DurableSend, type StageQueuedMessage } from './durableOutbox';
// Encrypted attachment seam: descriptors live inside the sealed group body, and
// the staged ciphertext lives in this account's vault until the server holds it.
import { encodeMessageBody, type EncryptedAttachmentDescriptor, type SealedForward } from './attachments/attachmentEnvelope';
import { collectUploadedDescriptors, listStagedAttachments, markStagedUploaded, nextPendingUpload, removeStagedAttachments, rekeyStagedAttachments } from './attachments/attachmentStaging';
import type { EncryptedAttachmentUploader } from './attachments/attachmentProducer';

const PLAINTEXT_NAMESPACE = 'messages.plaintext';
const SEND_BINDING_NAMESPACE = 'messages.group-sends';

interface SendBinding {
  channelId: string;
  members: GroupMember[];
  membersVersion?: string;
  epoch: number;
  referencedMessageId?: string;
  forwardedFrom?: ForwardedFromRequest;
  sealedForward?: SealedForward;
}

/** The server client this account's group key distribution speaks to. */
export interface GroupSenderKeyApi {
  postGroupSenderKeys(channelId: string, epoch: number, envelopes: Array<{ recipient_id: string; ciphertext: string; header: string }>, membersVersion?: string): Promise<unknown>;
  getGroupSenderKeys(channelId: string, sinceEpoch?: number): Promise<{ data: { sender_keys: IncomingSenderKeyEnvelope[]; members_version?: string } }>;
  ackGroupSenderKeys(channelId: string, payload: { sender_id?: string; up_to_epoch?: number }): Promise<unknown>;
}

async function cacheId(channelId: string, payload: MessageE2eePayload): Promise<string> {
  const envelope = JSON.stringify([channelId, payload.version, payload.nonce, payload.ciphertext, payload.header ?? null]);
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(envelope))));
}

/**
 * Account-owned group-DM crypto and delivery preparation.
 *
 * Unlike the 1:1 lane there is no ratchet generation to retire: a sender key is
 * an epoch, not a chain, so deleting or editing a delivered message cannot
 * strand a follower's keys. That is why this lane has no equivalent of
 * `restoreFollowers` or `retireDeliveredMessage` — the whole class of prepared
 * message left depending on a removed message's ratchet state does not exist
 * here. What *does* need care is the epoch: distribution talks to the server, so
 * it happens outside the vault transaction that seals the body.
 */
export function createDurableGroup(
  vault: AccountVault,
  privateKey: Uint8Array,
  api: GroupSenderKeyApi,
  uploadAttachment?: EncryptedAttachmentUploader,
) {
  const myUserId = vault.scope.userId;

  async function build(
    transaction: VaultTransaction,
    nonce: string,
    channelId: string,
    members: readonly GroupMember[],
    content: string,
    referencedMessageId?: string,
    attachments: readonly EncryptedAttachmentDescriptor[] = [],
    membersVersion?: string,
    forwardedFrom?: ForwardedFromRequest,
    sealedForward?: SealedForward,
  ): Promise<SendMessageRequest> {
    if (forwardedFrom && sealedForward) throw new Error('A forward names its source either in the clear or inside the encrypted body, not both.');
    const local = await ensureLocalSenderKey(transaction, channelId, members, myUserId);
    if (pendingDistribution(local, members, myUserId).length > 0) {
      // `distribute` runs before preparation; reaching here means the roster
      // moved underneath it, and sealing anyway would produce a body some
      // member has no key for.
      throw new GroupE2eeError('This group’s membership changed while the message was being prepared. It will be sent once the new key reaches everyone.');
    }
    const body = encodeMessageBody(content, attachments, sealedForward);
    const e2ee = await sealGroupMessage(channelId, body, myUserId, privateKey, local);
    transaction.put(SEND_BINDING_NAMESPACE, nonce, {
      channelId, members: [...members], membersVersion, epoch: local.epoch, referencedMessageId, forwardedFrom, sealedForward,
    } satisfies SendBinding);
    transaction.put(PLAINTEXT_NAMESPACE, await cacheId(channelId, e2ee), { content: body });
    return {
      nonce, content: '', e2ee, referenced_message_id: referencedMessageId,
      ...(attachments.length ? { attachment_ids: attachments.map(attachment => attachment.id) } : {}),
      ...(forwardedFrom ? { forwarded_from: forwardedFrom } : {}),
    };
  }

  /**
   * Mint this account's epoch for the current roster and wrap it to whoever
   * still needs it.
   *
   * Deliberately outside any vault transaction: it makes an HTTP request, and
   * the account lock is held by every draft save. The mint is committed first,
   * so a crash between the mint and the POST re-wraps the same epoch rather
   * than burning one; `distributed` is only recorded once the server has the
   * envelopes.
   */
  async function distribute(channelId: string, members: readonly GroupMember[], membersVersion?: string | null): Promise<void> {
    const local = await vault.transact(tx => ensureLocalSenderKey(tx, channelId, members, myUserId));
    const pending = pendingDistribution(local, members, myUserId);
    if (pending.length === 0) return;
    const envelopes = await buildSenderKeyEnvelopes(channelId, local, myUserId, privateKey, pending);
    if (envelopes.length === 0) return;
    if (!membersVersion) {
      // The server refuses an undeclared membership, and it is right to: this
      // client would be promising it wrapped the key to the right people
      // without naming who they are.
      throw new GroupE2eeError('This group’s membership has not loaded yet. Reopen the conversation before sending.');
    }
    await api.postGroupSenderKeys(channelId, local.epoch, envelopes, membersVersion);
    await vault.transact(async tx => {
      const current = await readLocalSenderKey(tx, channelId);
      // Another window may have rotated past this epoch while the POST was in
      // flight; its own distribution owns the newer record.
      if (!current || current.epoch !== local.epoch) return;
      markDistributed(tx, channelId, current, pending);
    });
  }

  /** Fetch and adopt any sender keys this account is missing for a channel. */
  async function receiveSenderKeys(channelId: string, members: readonly GroupMember[], resolvePublicKey: (userId: string) => string | null) {
    const { data } = await api.getGroupSenderKeys(channelId);
    const envelopes = (data?.sender_keys ?? []).filter(record => record.recipient_id === myUserId);
    if (envelopes.length === 0) return { adopted: [], refused: [] };
    // Verification first, with no transaction open: it asserts identity pins,
    // and those live in this same vault behind the same exclusive lock.
    const outcome = await verifySenderKeyEnvelopes(channelId, envelopes, myUserId, privateKey, resolvePublicKey, members);
    if (outcome.adopted.length > 0) {
      await vault.transact(async tx => { commitSenderKeys(tx, channelId, outcome.adopted); });
    }
    for (const key of outcome.adopted) {
      // Acknowledged keys stop being served as pending, but stay readable by
      // explicit epoch so a reinstalled device can still fetch them.
      void api.ackGroupSenderKeys(channelId, { sender_id: key.senderId, up_to_epoch: key.epoch }).catch(() => {});
    }
    return outcome;
  }

  return {
    distribute,
    receiveSenderKeys,
    /**
     * Whether this lane prepared the given send.
     *
     * A prepared record has already consumed its intent, so the encryption kind
     * is no longer on it; the binding this lane wrote when it sealed the body is
     * what identifies it. The 1:1 lane answers the same question with its own
     * binding, so the two never both claim a nonce.
     */
    async ownsSend(transaction: VaultTransaction, nonce: string): Promise<boolean> {
      return Boolean(await transaction.get<SendBinding>(SEND_BINDING_NAMESPACE, nonce));
    },
    async acknowledgeSend(transaction: VaultTransaction, nonce: string, message: Message) {
      const binding = await transaction.get<SendBinding>(SEND_BINDING_NAMESPACE, nonce);
      if (!binding) return;
      if (binding.channelId !== message.channel_id || message.nonce !== nonce || message.author.id !== myUserId) {
        throw new Error('The send acknowledgement belongs to another message.');
      }
      // The server holds the ciphertext and every member holds the epoch.
      await removeStagedAttachments(transaction, nonce);
    },
    enqueue(channelId: string, members: GroupMember[], content: string, referencedMessageId?: string, stage?: StageQueuedMessage) {
      return enqueueMessageIntent(vault, channelId, content, { encryption: { kind: 'group', members }, referencedMessageId }, stage);
    },
    /**
     * Upload this draft's staged ciphertext, one body at a time. Outside any
     * vault transaction for the same reason the 1:1 lane is: an upload can take
     * minutes, and each accepted body commits its own server reference so a
     * reload resumes instead of re-uploading.
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
    /**
     * `live` is the roster as of this attempt, not the one the draft was
     * written against. A draft can sit in the outbox across a membership
     * change, and sealing it to the stale roster would either exclude a new
     * member or include a departed one.
     */
    async prepareIntent(transaction: VaultTransaction, intent: DurableIntent, live?: { members: readonly GroupMember[]; membersVersion: string }) {
      if (intent.intent.encryption.kind !== 'group') throw new Error('A group encryptor cannot prepare another conversation’s draft.');
      if (intent.intent.attachmentIds?.length) throw new Error('An encrypted conversation cannot reference a plaintext upload.');
      const attachments = await collectUploadedDescriptors(transaction, intent.id);
      const members = live?.members ?? intent.intent.encryption.members;
      return build(transaction, intent.nonce, intent.channelId, members, intent.draft.content,
        intent.intent.referencedMessageId, attachments, live?.membersVersion, intent.intent.forwardedFrom, intent.intent.sealedForward);
    },
    async prepare(channelId: string, members: GroupMember[], content: string, referencedMessageId?: string, membersVersion?: string | null) {
      await distribute(channelId, members, membersVersion);
      return prepareDurableSend(vault, channelId, content, (transaction, nonce) =>
        build(transaction, nonce, channelId, members, content, referencedMessageId, [], membersVersion ?? undefined));
    },
    async reconcileRemoved(transaction: VaultTransaction, removed: DurableSend) {
      transaction.remove(SEND_BINDING_NAMESPACE, removed.nonce);
      await removeStagedAttachments(transaction, removed.id);
    },
    async restoreIntent(transaction: VaultTransaction, original: DurableSend, content: string): Promise<DurableIntent> {
      const binding = await transaction.get<SendBinding>(SEND_BINDING_NAMESPACE, original.nonce);
      if (!binding || binding.channelId !== original.channelId) throw new Error('The original conversation encryption metadata is missing.');
      const { serializedRequest: _request, mutation: _mutation, ...metadata } = original;
      const nonce = crypto.randomUUID();
      await rekeyStagedAttachments(transaction, original.id, nonce);
      transaction.remove(SEND_BINDING_NAMESPACE, original.nonce);
      return {
        ...metadata, id: nonce, nonce, draft: { content }, revision: crypto.randomUUID(),
        status: 'pending', attempts: 0, error: null, nextAttemptAt: original.retryAfterAt ?? 0,
        intent: { encryption: { kind: 'group', members: binding.members }, referencedMessageId: binding.referencedMessageId, forwardedFrom: binding.forwardedFrom,
          sealedForward: binding.sealedForward },
      };
    },
    async prepareEdit(transaction: VaultTransaction, original: DurableSend, messageId: string, editNonce: string, content: string): Promise<PreparedDeliveryEdit> {
      const binding = await transaction.get<SendBinding>(SEND_BINDING_NAMESPACE, original.nonce);
      if (!binding || binding.channelId !== original.channelId) throw new Error('The original conversation encryption metadata is missing.');
      // An edit replaces the whole encrypted body, so it must re-state the
      // attachment descriptors (or their keys would be lost with the old body)
      // and a sealed forward's attribution.
      const attachments = await collectUploadedDescriptors(transaction, original.id);
      const body = encodeMessageBody(content, attachments, binding.sealedForward);
      const local = await ensureLocalSenderKey(transaction, original.channelId, binding.members, myUserId);
      const e2ee = await sealGroupMessage(original.channelId, body, myUserId, privateKey, local);
      transaction.put(PLAINTEXT_NAMESPACE, await cacheId(original.channelId, e2ee), { content: body });
      return { channelId: original.channelId, messageId, editNonce, serializedRequest: JSON.stringify({ content: '', e2ee, edit_nonce: editNonce }) };
    },
    /** Delivered edits also cover old server messages with no local creation binding. */
    async prepareDeliveredEdit(
      transaction: VaultTransaction, channelId: string, members: readonly GroupMember[], messageId: string,
      editNonce: string, content: string, attachments: readonly EncryptedAttachmentDescriptor[] = [],
      sealedForward?: SealedForward,
    ): Promise<PreparedDeliveryEdit> {
      assertSignalMessageId(messageId);
      const body = encodeMessageBody(content, attachments, sealedForward);
      const local = await ensureLocalSenderKey(transaction, channelId, members, myUserId);
      const e2ee = await sealGroupMessage(channelId, body, myUserId, privateKey, local);
      transaction.put(PLAINTEXT_NAMESPACE, await cacheId(channelId, e2ee), { content: body });
      return { channelId, messageId, editNonce, serializedRequest: JSON.stringify({ content: '', e2ee, edit_nonce: editNonce }) };
    },
    /**
     * Open one delivered group message.
     *
     * `authorId` is the author the *server* attributed the message to. The
     * header's `sender_id` is what the signature covers, and the two must be
     * the same person: a member who re-sealed a peer's body under that peer's
     * sender key would still be posting it under their own account, so the
     * mismatch is the tell.
     */
    async decrypt(
      channelId: string, members: readonly GroupMember[], payload: MessageE2eePayload, messageId: string,
      authorId: string, resolvePublicKey: (userId: string) => string | null,
    ): Promise<string> {
      assertSignalMessageId(messageId);
      const id = await cacheId(channelId, payload);
      const cached = await vault.transact(tx => tx.get<{ content: string }>(PLAINTEXT_NAMESPACE, id));
      if (cached) return cached.content;

      const claim = readGroupMessageClaim(payload);
      if (claim.senderId !== authorId) {
        throw new GroupE2eeError('This group message claims a different author than the one it was delivered under.');
      }
      const senderPublicKey = resolvePublicKey(claim.senderId);
      if (!senderPublicKey) throw new GroupE2eeError('This member has no published identity key, so their message cannot be verified.');

      // Own messages come from the live local epoch; retired ones were filed
      // beside every peer's when they rotated, so the same lookup finds them.
      const held = await vault.transact(async tx => {
        if (claim.senderId === myUserId) {
          const local = await readLocalSenderKey(tx, channelId);
          if (local?.epoch === claim.epoch) return local.key;
        }
        return (await readReceivedSenderKey(tx, channelId, claim.senderId, claim.epoch))?.key ?? null;
      });

      let senderKey = held;
      if (!senderKey) {
        await receiveSenderKeys(channelId, members, resolvePublicKey);
        senderKey = (await vault.transact(tx => readReceivedSenderKey(tx, channelId, claim.senderId, claim.epoch)))?.key ?? null;
      }
      if (!senderKey) throw new GroupE2eeError('No group key for this message has reached this device yet.');

      // `attestedMembers` records the roster the body was sealed against. For a
      // reader it is history — an older roster is the normal shape of an older
      // message — so it is not a refusal here. It is enforced where it can
      // still change the outcome: when a key is minted, and when one is adopted.
      const opened = await openGroupMessage(channelId, payload, senderKey, senderPublicKey);
      await vault.transact(async tx => { tx.put(PLAINTEXT_NAMESPACE, id, { content: opened.content }); });
      return opened.content;
    },
  };
}
