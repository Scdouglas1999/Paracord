/**
 * Recipient-side attachment decryption.
 *
 * Ciphertext is fetched with the ordinary authenticated attachment download and
 * opened on this device. No key, no filename and no plaintext byte is ever sent
 * back to the server, and nothing is written to disk by this module: callers get
 * an object URL over an in-memory blob and revoke it when the view goes away.
 */
import { fileApi } from '../../../api/files';
import type { Attachment } from '../../../types';
import { toArrayBuffer } from '../../crypto/util';
import { base64ToBytes, decryptAttachmentBytes } from './attachmentCrypto';
import type { EncryptedAttachmentDescriptor } from './attachmentEnvelope';

export type EncryptedAttachment = Attachment & { encryption: EncryptedAttachmentDescriptor };

export function isEncryptedAttachment(attachment: Attachment): attachment is EncryptedAttachment {
  return Boolean(attachment.encryption);
}

/** Decrypt an attachment body into a blob of its real type. */
export async function decryptAttachmentBlob(
  attachment: EncryptedAttachment,
  onProgress?: (percent: number) => void,
): Promise<Blob> {
  const descriptor = attachment.encryption;
  const { data } = await fileApi.download(descriptor.id, onProgress);
  const ciphertext = new Uint8Array(await data.arrayBuffer());
  const plaintext = await decryptAttachmentBytes(ciphertext, descriptor, {
    size: descriptor.size, sha256: descriptor.sha256,
  });
  return new Blob([toArrayBuffer(plaintext)], { type: descriptor.contentType });
}

/** Decrypt the inline preview the sender attached, when there is one. */
export async function decryptAttachmentThumbnail(attachment: EncryptedAttachment): Promise<Blob | null> {
  const thumbnail = attachment.encryption.thumbnail;
  if (!thumbnail) return null;
  const plaintext = await decryptAttachmentBytes(base64ToBytes(thumbnail.data), thumbnail, {
    size: thumbnail.size, sha256: thumbnail.sha256,
  });
  return new Blob([toArrayBuffer(plaintext)], { type: thumbnail.contentType });
}
