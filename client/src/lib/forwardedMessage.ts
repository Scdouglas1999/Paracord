import type { ForwardedFrom, Message } from '../types';
import { displayName } from './displayName';
import type { SealedForward } from './messages/attachments/attachmentEnvelope';

/** Splits a note from a quote inside an encrypted forward. Invisible separator. */
const QUOTE_MARK = '\n\u2063\n';

export function composeDmForwardBody(note: string, quote: string): string {
  const trimmed = note.trim();
  return trimmed ? `${trimmed}${QUOTE_MARK}${quote}` : quote;
}

export function splitDmForwardBody(body: string): { note: string; quote: string } {
  const index = body.indexOf(QUOTE_MARK);
  if (index === -1) return { note: '', quote: body };
  return { note: body.slice(0, index), quote: body.slice(index + QUOTE_MARK.length) };
}

/** Bubble text. A direct-message forward keeps its quote on the card, not in the bubble. */
export function messageBubbleText(message: Pick<Message, 'content' | 'forwarded_from'>): string {
  const raw = message.content ?? '';
  const forward = message.forwarded_from;
  if (forward && forward.content == null && !forward.error) {
    return splitDmForwardBody(raw).note;
  }
  return raw;
}

export function forwardQuote(message: Pick<Message, 'content' | 'forwarded_from'>): string {
  const forward = message.forwarded_from;
  if (!forward) return '';
  if (forward.error) return forward.error;
  if (forward.content != null) return forward.content;
  return splitDmForwardBody(message.content ?? '').quote;
}

/**
 * Why a message cannot be forwarded, or null when it can. Direct-message
 * files are end-to-end encrypted and never leave their conversation; a
 * message this device cannot read has no text to forward.
 */
export function forwardBlockedReason(
  message: Pick<Message, 'attachments'>,
  { sourceIsDm, unreadable }: { sourceIsDm: boolean; unreadable: boolean },
): string | null {
  if (sourceIsDm && (message.attachments?.length ?? 0) > 0) {
    return 'Attachments from an end-to-end encrypted conversation cannot be forwarded.';
  }
  if (unreadable) return 'This message cannot be read on this device yet, so it cannot be forwarded.';
  return null;
}

/**
 * What a forward from one encrypted conversation into another carries inside
 * its encrypted body: the quote, and where it came from.
 *
 * Forwarding a forward that added no note of its own points at the original,
 * the same rule the server applies to server channels.
 */
export function sealedForwardFor(
  message: Pick<Message, 'id' | 'channel_id' | 'author' | 'content' | 'forwarded_from' | 'created_at' | 'timestamp'>,
): { quote: string; forward: SealedForward } {
  const inner = message.forwarded_from;
  if (inner && !inner.error && !messageBubbleText(message).trim()) {
    return { quote: forwardQuote(message).trim(), forward: inner.sealed ?? sealedFromAttribution(inner) };
  }
  const sentAt = message.created_at ?? message.timestamp;
  return {
    quote: messageBubbleText(message).trim(),
    forward: {
      channelId: message.channel_id,
      messageId: message.id,
      authorId: message.author.id,
      authorName: displayName(message.author),
      ...(sentAt ? { sentAt } : {}),
    },
  };
}

function sealedFromAttribution(forward: ForwardedFrom): SealedForward {
  return {
    channelId: forward.channel_id,
    messageId: forward.message_id,
    ...(forward.guild_id ? { guildId: forward.guild_id } : {}),
    ...(forward.channel_name ? { channelName: forward.channel_name } : {}),
    ...(forward.author_id ? { authorId: forward.author_id } : {}),
    ...(forward.author_name ? { authorName: forward.author_name } : {}),
    ...(forward.sent_at ? { sentAt: forward.sent_at } : {}),
  };
}

export function forwardAttribution(forward: ForwardedFrom): string {
  const where = forward.guild_id
    ? `#${forward.channel_name || 'Untitled channel'}`
    : 'Direct message';
  const who = forward.author_name || 'Deleted user';
  const when = forward.sent_at ? formatForwardTime(forward.sent_at) : '';
  return when ? `Forwarded from ${where} · ${who} · ${when}` : `Forwarded from ${where} · ${who}`;
}

function formatForwardTime(sentAt: string): string {
  const date = new Date(sentAt);
  if (Number.isNaN(date.getTime())) return sentAt;
  return date
    .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    .replace(/\bAM\b/g, 'am')
    .replace(/\bPM\b/g, 'pm');
}
