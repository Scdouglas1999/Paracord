import type { ConversationSubject } from './types';

/**
 * The line under the large title (docs/index-spec.md §4.11): the topic; "Direct
 * message"; "Group · 4 people"; and, for an encrypted conversation, a lock and
 * "End-to-end encrypted" after it. The server's first channel with no topic says
 * whose it is ("Fuel’s main channel", the prototype's line), so the line under
 * the title is never an empty hole in the one channel everybody lands on.
 */

export interface SubtitleFacts {
  serverName?: string;
  /** This is the server's first channel (the one it opens on). */
  isLanding: boolean;
  /** The server has said whether this conversation is encrypted (not still asking, not failed). */
  known: boolean;
  encrypted: boolean;
  /** `useConversationActions().encryption`: 'ready', 'unlock', 'identity_mismatch', or a setup state. */
  encryption: string;
}

export interface SubtitleParts {
  text: string | null;
  /** The encryption words; drawn with a lock glyph. Null when there is nothing to say. */
  lock: string | null;
}

export function encryptionCaption(encryption: string): string {
  if (encryption === 'ready') return 'End-to-end encrypted';
  if (encryption === 'unlock') return 'Encryption locked on this device';
  if (encryption === 'identity_mismatch') return 'Encryption keys do not match';
  return 'Encryption needs setup';
}

export function subtitleFor(subject: ConversationSubject, facts: SubtitleFacts): SubtitleParts {
  // How a conversation is protected is only said once the server has said it:
  // before that, "not encrypted" would be a guess, and a wrong one.
  const lock = facts.known && facts.encrypted ? encryptionCaption(facts.encryption) : null;
  if (subject.kind === 'dm') {
    const text = subject.isGroup
      ? subject.participants && subject.participants > 1
        ? `Group · ${subject.participants} people`
        : 'Group message'
      : 'Direct message';
    return { text, lock };
  }
  const topic = subject.topic?.trim();
  const text =
    subject.subtitle?.trim() ||
    topic ||
    (facts.isLanding && facts.serverName?.trim() ? `${facts.serverName.trim()}’s main channel` : null);
  return { text, lock };
}
