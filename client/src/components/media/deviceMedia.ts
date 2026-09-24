/**
 * The media panel for a direct message, built on this device.
 *
 * The instance cannot list an encrypted conversation's files: it holds opaque
 * blobs under random names. What a person sent is only known once a message
 * has been decrypted here, so the panel collects from the decrypted history
 * this device holds (the same messages direct-message search looks through).
 */
import { isAllowedImageMimeType } from '../../lib/security';
import { isEncryptedAttachment, type EncryptedAttachment } from '../../lib/messages/attachments/attachmentDecryption';
import type { Message } from '../../types';

export interface DeviceAuthor {
  username: string;
  display_name?: string | null;
}

export interface DeviceAttachment {
  id: string;
  message_id: string;
  created_at: string;
  author: DeviceAuthor;
  kind: 'image' | 'video' | 'file';
  attachment: EncryptedAttachment;
}

export interface DeviceLink {
  key: string;
  url: string;
  message_id: string;
  created_at: string;
  author: DeviceAuthor;
}

export interface DeviceMedia {
  media: DeviceAttachment[];
  files: DeviceAttachment[];
  links: DeviceLink[];
}

/** The instance's gallery takes at most this many links from one message. */
const MAX_URLS_PER_MESSAGE = 5;

/**
 * `http://` and `https://` addresses in plain text, the same rule the instance
 * uses to list a server channel's links: up to whitespace, a quote or an angle
 * bracket, without trailing punctuation.
 */
export function extractUrls(text: string): string[] {
  const urls: string[] = [];
  const pattern = /https?:\/\/[^\s"<>]+/g;
  for (const match of text.matchAll(pattern)) {
    const url = match[0].replace(/[.,)\]!?]+$/, '');
    if (url && !urls.includes(url)) urls.push(url);
    if (urls.length >= MAX_URLS_PER_MESSAGE) break;
  }
  return urls;
}

function snowflake(id: string): bigint {
  try {
    return BigInt(id);
  } catch {
    return 0n;
  }
}

/** Newest first, by message id: ids are time-ordered, timestamps can be missing. */
function newestFirst(a: Message, b: Message): number {
  const left = snowflake(a.id);
  const right = snowflake(b.id);
  return left === right ? 0 : left > right ? -1 : 1;
}

function attachmentKind(contentType: string): DeviceAttachment['kind'] {
  const type = contentType.toLowerCase();
  if (isAllowedImageMimeType(type)) return 'image';
  if (type.startsWith('video/')) return 'video';
  return 'file';
}

/**
 * Merge the conversation's loaded messages with older pages the panel read,
 * dropping duplicates, deleted messages and any still being decrypted.
 */
export function mergeDeviceHistory(
  loaded: readonly Message[],
  older: readonly Message[],
  skip: { deleted: ReadonlySet<string>; decrypting: ReadonlySet<string> },
): Message[] {
  const byId = new Map<string, Message>();
  // Older pages first so the live copy of a message wins over a snapshot.
  for (const message of [...older, ...loaded]) {
    if (skip.deleted.has(message.id) || skip.decrypting.has(message.id)) continue;
    byId.set(message.id, message);
  }
  return [...byId.values()].sort(newestFirst);
}

/** Images, videos, files and links in decrypted messages, newest first. */
export function collectDeviceMedia(messages: readonly Message[]): DeviceMedia {
  const result: DeviceMedia = { media: [], files: [], links: [] };
  for (const message of [...messages].sort(newestFirst)) {
    const created_at = message.created_at ?? message.timestamp ?? '';
    const author = { username: message.author?.username ?? 'unknown', display_name: message.author?.display_name ?? null };
    // Only files whose key arrived inside the encrypted body can be opened
    // here. The message itself says so for any other file.
    for (const attachment of message.attachments ?? []) {
      if (!isEncryptedAttachment(attachment)) continue;
      const kind = attachmentKind(attachment.encryption.contentType);
      const item: DeviceAttachment = { id: attachment.id, message_id: message.id, created_at, author, kind, attachment };
      (kind === 'file' ? result.files : result.media).push(item);
    }
    extractUrls(message.content ?? '').forEach((url, index) => {
      result.links.push({ key: `${message.id}:${index}`, url, message_id: message.id, created_at, author });
    });
  }
  return result;
}

/** The oldest message id in either set: where "Load older" continues from. */
export function oldestMessageId(...sets: ReadonlyArray<readonly Message[]>): string | null {
  let oldest: Message | null = null;
  for (const set of sets) {
    for (const message of set) {
      if (!oldest || snowflake(message.id) < snowflake(oldest.id)) oldest = message;
    }
  }
  return oldest?.id ?? null;
}
