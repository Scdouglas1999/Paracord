/**
 * Durable, encrypted staging for outbound attachment ciphertext.
 *
 * A queued message keeps its bytes in the account vault, which encrypts every
 * record under a key derived from the unlocked identity. Nothing an attachment
 * carries — its ciphertext, its file key, its real name — is ever written to
 * IndexedDB or `localStorage` in the clear, and nothing survives logout in a
 * readable form. Reloading the app resumes the same staged bytes; discarding the
 * queued message removes them.
 *
 * Bodies are chunked so one record never has to hold a whole file: each record
 * is at most `STAGED_CHUNK_BYTES` of ciphertext, base64-encoded for JSON.
 */
import type { VaultTransaction } from '../../crypto/accountVault';
import { base64ToBytes, bytesToBase64 } from './attachmentCrypto';
import type { EncryptedAttachmentDescriptor } from './attachmentEnvelope';

export const STAGED_ATTACHMENTS_NAMESPACE = 'messages.attachment-staging';
export const STAGED_BODIES_NAMESPACE = 'messages.attachment-bodies';
/** 192 KiB of ciphertext per record (256 KiB once base64-encoded). */
export const STAGED_CHUNK_BYTES = 192 * 1024;

/** A descriptor before upload: everything but the server's object reference. */
export type StagedDescriptor = Omit<EncryptedAttachmentDescriptor, 'id'>;

export interface StagedAttachment {
  readonly messageId: string;
  readonly index: number;
  readonly channelId: string;
  readonly descriptor: StagedDescriptor;
  /** Opaque stored-object name; fixed at staging so a retry reuses it. */
  readonly objectName: string;
  readonly chunks: number;
  readonly ciphertextSize: number;
  /** Set once the ciphertext is accepted by the server. */
  readonly uploadedId?: string;
}

function stageId(messageId: string, index: number): string {
  return `${messageId}:${index}`;
}

function chunkId(messageId: string, index: number, chunk: number): string {
  return `${messageId}:${index}:${chunk}`;
}

export interface StageInput {
  readonly descriptor: StagedDescriptor;
  readonly ciphertext: Uint8Array;
  readonly objectName: string;
}

/** Write one queued message's attachment bodies inside the caller's transaction. */
export function stageAttachments(
  tx: VaultTransaction, messageId: string, channelId: string, inputs: readonly StageInput[],
): StagedAttachment[] {
  if (!messageId || !channelId) throw new Error('Staged attachments require an owned message and conversation.');
  return inputs.map((input, index) => {
    const chunks = Math.max(1, Math.ceil(input.ciphertext.byteLength / STAGED_CHUNK_BYTES));
    for (let chunk = 0; chunk < chunks; chunk += 1) {
      const slice = input.ciphertext.subarray(chunk * STAGED_CHUNK_BYTES, (chunk + 1) * STAGED_CHUNK_BYTES);
      tx.put(STAGED_BODIES_NAMESPACE, chunkId(messageId, index, chunk), { body: bytesToBase64(slice) });
    }
    const record: StagedAttachment = {
      messageId, index, channelId, descriptor: input.descriptor, objectName: input.objectName,
      chunks, ciphertextSize: input.ciphertext.byteLength,
    };
    tx.put(STAGED_ATTACHMENTS_NAMESPACE, stageId(messageId, index), record);
    return record;
  });
}

export async function listStagedAttachments(tx: VaultTransaction, messageId: string): Promise<StagedAttachment[]> {
  const rows = await tx.list<StagedAttachment>(STAGED_ATTACHMENTS_NAMESPACE);
  return rows
    .map(row => row.value)
    .filter(value => value.messageId === messageId)
    .sort((a, b) => a.index - b.index);
}

export async function readStagedCiphertext(tx: VaultTransaction, record: StagedAttachment): Promise<Uint8Array> {
  const ciphertext = new Uint8Array(record.ciphertextSize);
  let offset = 0;
  for (let chunk = 0; chunk < record.chunks; chunk += 1) {
    const stored = await tx.get<{ body: string }>(STAGED_BODIES_NAMESPACE, chunkId(record.messageId, record.index, chunk));
    if (!stored) throw new Error('This queued attachment is missing part of its encrypted body. Discard the message and attach the file again.');
    const bytes = base64ToBytes(stored.body);
    if (offset + bytes.byteLength > ciphertext.byteLength) {
      throw new Error('This queued attachment’s stored body is longer than it was staged. Discard the message and attach the file again.');
    }
    ciphertext.set(bytes, offset);
    offset += bytes.byteLength;
  }
  if (offset !== ciphertext.byteLength) {
    throw new Error('This queued attachment’s stored body is incomplete. Discard the message and attach the file again.');
  }
  return ciphertext;
}

export function markStagedUploaded(tx: VaultTransaction, record: StagedAttachment, uploadedId: string): StagedAttachment {
  const updated: StagedAttachment = { ...record, uploadedId };
  tx.put(STAGED_ATTACHMENTS_NAMESPACE, stageId(record.messageId, record.index), updated);
  // The body is only needed until the server holds it; keeping it would grow
  // the vault without bound for every message ever sent.
  for (let chunk = 0; chunk < record.chunks; chunk += 1) {
    tx.remove(STAGED_BODIES_NAMESPACE, chunkId(record.messageId, record.index, chunk));
  }
  return updated;
}

/** Remove every trace of one queued message's attachments. */
export async function removeStagedAttachments(tx: VaultTransaction, messageId: string): Promise<void> {
  for (const record of await listStagedAttachments(tx, messageId)) {
    for (let chunk = 0; chunk < record.chunks; chunk += 1) {
      tx.remove(STAGED_BODIES_NAMESPACE, chunkId(record.messageId, record.index, chunk));
    }
    tx.remove(STAGED_ATTACHMENTS_NAMESPACE, stageId(record.messageId, record.index));
  }
}

/**
 * The descriptors for a queued message, refusing to build a body that names an
 * attachment the server has not accepted yet.
 */
export async function collectUploadedDescriptors(
  tx: VaultTransaction, messageId: string,
): Promise<EncryptedAttachmentDescriptor[]> {
  const staged = await listStagedAttachments(tx, messageId);
  return staged.map(record => {
    if (!record.uploadedId) {
      throw new Error('This message’s encrypted attachments have not finished uploading.');
    }
    return { ...record.descriptor, id: record.uploadedId };
  });
}

/**
 * Move staged attachments onto a replacement queue entry.
 *
 * A cancelled delivery is replaced by a fresh draft with a new delivery nonce.
 * Its attachments are already accepted by the server, so only the records move;
 * losing them here would silently send the replacement without its files.
 */
export async function rekeyStagedAttachments(
  tx: VaultTransaction, from: string, to: string,
): Promise<void> {
  if (from === to) return;
  for (const record of await listStagedAttachments(tx, from)) {
    if (!record.uploadedId) {
      throw new Error('This message’s encrypted attachments must finish uploading before it can be replaced.');
    }
    tx.put(STAGED_ATTACHMENTS_NAMESPACE, `${to}:${record.index}`, { ...record, messageId: to });
    tx.remove(STAGED_ATTACHMENTS_NAMESPACE, `${from}:${record.index}`);
  }
}

/** The next staged body awaiting upload for this queued message, if any. */
export async function nextPendingUpload(
  tx: VaultTransaction, messageId: string,
): Promise<{ record: StagedAttachment; ciphertext: Uint8Array } | null> {
  for (const record of await listStagedAttachments(tx, messageId)) {
    if (record.uploadedId) continue;
    return { record, ciphertext: await readStagedCiphertext(tx, record) };
  }
  return null;
}
