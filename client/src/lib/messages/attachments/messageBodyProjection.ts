/**
 * Project a decrypted message body onto the message the UI renders.
 *
 * The server's own attachment rows for an encrypted conversation are opaque by
 * construction: a random `.bin` name, `application/octet-stream`, and a length
 * that is the ciphertext's. Everything a person should see comes from the
 * descriptor inside the encrypted body, so that is what replaces those rows.
 *
 * Attachments the server lists but the body never described are kept, without a
 * descriptor, so the renderer can say plainly that they were not end-to-end
 * encrypted instead of presenting them as if they were.
 */
import type { Attachment, Message } from '../../../types';
import { decodeEncryptedBody, EncryptedBodyError } from './attachmentEnvelope';

function attachmentFor(
  descriptor: NonNullable<Attachment['encryption']>, existing: Attachment | undefined,
): Attachment {
  return {
    id: descriptor.id,
    filename: descriptor.filename,
    size: descriptor.size,
    content_type: descriptor.contentType,
    url: existing?.url ?? `/api/v1/attachments/${descriptor.id}`,
    ...(descriptor.width ? { width: descriptor.width } : {}),
    ...(descriptor.height ? { height: descriptor.height } : {}),
    ...(existing?.origin_server ? { origin_server: existing.origin_server } : {}),
    encryption: descriptor,
  };
}

/**
 * Apply a decrypted body to `message`.
 *
 * A body this build cannot read never degrades into "the text without the
 * attachments": the error is returned so the caller can show it in place of the
 * message.
 */
export function applyDecryptedBody(message: Message, plaintext: string): Message {
  const body = decodeEncryptedBody(plaintext);
  if (body.attachments.length === 0) {
    return { ...message, content: body.text };
  }
  const existing = new Map((message.attachments ?? []).map(attachment => [attachment.id, attachment]));
  const described = body.attachments.map(descriptor => attachmentFor(descriptor, existing.get(descriptor.id)));
  const describedIds = new Set(described.map(attachment => attachment.id));
  const undescribed = (message.attachments ?? []).filter(attachment => !describedIds.has(attachment.id));
  return { ...message, content: body.text, attachments: [...described, ...undescribed] };
}

/** True when this message's attachments cannot be edited without losing keys. */
export function hasEncryptedAttachments(message: Message): boolean {
  return Boolean(message.e2ee) && Boolean(message.attachments?.length);
}

export { EncryptedBodyError };
