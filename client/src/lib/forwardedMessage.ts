import type { ForwardedFrom, Message } from '../types';

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
