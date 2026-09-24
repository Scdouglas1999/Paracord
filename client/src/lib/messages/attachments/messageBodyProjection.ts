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
import type { Attachment, ForwardedFrom, Message } from '../../../types';
import { decodeEncryptedBody, EncryptedBodyError, type SealedForward } from './attachmentEnvelope';

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
  // A forward between encrypted conversations carries its attribution in the
  // body. A forward made by a 3.2 client carries it on the server's message
  // instead, and that one is kept as it came.
  const forwarded = body.forward
    ? { forwarded_from: sealedForwardAttribution(body.forward) }
    : message.forwarded_from?.sealed
      // Only a decrypted body can mark an attribution as sealed.
      ? { forwarded_from: { ...message.forwarded_from, sealed: undefined } }
      : {};
  if (body.attachments.length === 0) {
    return { ...message, content: body.text, ...forwarded };
  }
  const existing = new Map((message.attachments ?? []).map(attachment => [attachment.id, attachment]));
  const described = body.attachments.map(descriptor => attachmentFor(descriptor, existing.get(descriptor.id)));
  const describedIds = new Set(described.map(attachment => attachment.id));
  const undescribed = (message.attachments ?? []).filter(attachment => !describedIds.has(attachment.id));
  return { ...message, content: body.text, attachments: [...described, ...undescribed], ...forwarded };
}

/**
 * The attribution the message UI renders for a sealed forward. `content` is
 * null because the quote is the part of the body after the note.
 */
export function sealedForwardAttribution(forward: SealedForward): ForwardedFrom {
  return {
    channel_id: forward.channelId,
    message_id: forward.messageId,
    guild_id: forward.guildId ?? null,
    ...(forward.authorId ? { author_id: forward.authorId } : {}),
    ...(forward.authorName ? { author_name: forward.authorName } : {}),
    ...(forward.sentAt ? { sent_at: forward.sentAt } : {}),
    channel_name: forward.channelName ?? null,
    content: null,
    sealed: forward,
  };
}

/** True when this message's attachments cannot be edited without losing keys. */
export function hasEncryptedAttachments(message: Message): boolean {
  return Boolean(message.e2ee) && Boolean(message.attachments?.length);
}

export { EncryptedBodyError };
