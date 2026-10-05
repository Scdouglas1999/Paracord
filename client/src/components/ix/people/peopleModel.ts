import { previewFromMessage, snowflakeTime, type ChannelPreviewEntry } from '../../../hooks/useChannelPreviews';
import type { ConversationEntry } from '../../../lib/attention/conversationModel';
import type { Message } from '../../../types';
import { authorLabel, previewLine, type PreviewContext } from '../../glass/places/model';

/**
 * What the People sidebar says (docs/index-spec.md §6.6): the words of its rows, as
 * pure functions so every rule is a unit test. The rows themselves are in
 * `PeopleSidebar.tsx`; the data they read is in `usePeopleSidebar.ts`.
 */

/** Direct and group conversations, pinned first, then the newest message first. */
export function directConversations(lists: readonly (readonly ConversationEntry[])[]): ConversationEntry[] {
  const seen = new Set<string>();
  const entries: ConversationEntry[] = [];
  for (const list of lists) {
    for (const entry of list) {
      if ((entry.kind !== 'dm' && entry.kind !== 'group_dm') || seen.has(entry.key)) continue;
      seen.add(entry.key);
      entries.push(entry);
    }
  }
  const time = (entry: ConversationEntry) => snowflakeTime(entry.lastActivityId) ?? 0;
  return entries.sort((a, b) => Number(b.pinned) - Number(a.pinned) || time(b) - time(a) || a.key.localeCompare(b.key));
}

/** "1 request", "3 requests". */
export function requestsWords(count: number): string {
  return count === 1 ? '1 request' : `${count} requests`;
}

/**
 * The Friends row's line: "3 online · 1 request". Requests are the incoming ones
 * (they are waiting on you); what you sent is on the page. With nobody online and
 * nothing waiting it says so rather than going blank, and with no friends at all it
 * says what to do.
 */
export function friendsLine(input: { friends: number; online: number; requests: number }): string {
  const parts: string[] = [];
  if (input.online > 0) parts.push(`${input.online} online`);
  if (input.requests > 0) parts.push(requestsWords(input.requests));
  if (parts.length > 0) return parts.join(' · ');
  return input.friends > 0 ? 'None online' : 'Add a friend';
}

/**
 * The Inbox row's line. The newest thing waiting, in the words a channel row uses
 * ("Maya in looking-for-group: need one for ranked"), else what is waiting in
 * counts, else that nothing is.
 */
export function inboxLine(input: { newest: string | null; mentions: number; unread: number; reminders: number }): string {
  if (input.newest) return input.newest;
  const parts: string[] = [];
  if (input.mentions > 0) parts.push(input.mentions === 1 ? '1 mention' : `${input.mentions} mentions`);
  if (input.unread > 0) parts.push(input.unread === 1 ? '1 unread' : `${input.unread} unread`);
  if (input.reminders > 0) parts.push(input.reminders === 1 ? '1 reminder' : `${input.reminders} reminders`);
  return parts.length > 0 ? parts.join(' · ') : 'All caught up';
}

const NO_NAMES: Pick<PreviewContext, 'memberNames' | 'channelNames' | 'eventNames'> = {
  memberNames: new Map(),
  channelNames: new Map(),
  eventNames: new Map(),
};

/** What a line knows about names: nobody's but your own, whom a mention reads as "@you", not "@someone". */
function namesFor(selfUserId: string | null): Pick<PreviewContext, 'memberNames' | 'channelNames' | 'eventNames'> {
  return selfUserId ? { ...NO_NAMES, memberNames: new Map([[selfUserId, 'you']]) } : NO_NAMES;
}

/**
 * A message as an Inbox line, the way a channel's last line words it: "Maya: need one for
 * ranked", "Jeremy posted a video", "You: ...". An end-to-end encrypted message says so and
 * nothing more (nothing here decrypts).
 */
export function messageLine(message: Message, selfUserId: string | null): string {
  const entry = previewFromMessage(message);
  if (entry.encrypted) return `${authorLabel(entry, selfUserId)}: Encrypted message`;
  return previewLine(entry, { selfUserId, ...namesFor(selfUserId) }) ?? 'New activity';
}

/**
 * A message as the line under an Inbox page's row, whose head already names the conversation: the
 * same as `messageLine`, except that in a one-to-one message the other person's name (the row's own
 * name) is not said twice.
 */
export function inboxPageLine(entry: Pick<ConversationEntry, 'kind'>, message: Message, selfUserId: string | null): string {
  const line = messageLine(message, selfUserId);
  if (entry.kind !== 'dm') return line;
  const who = authorLabel(previewFromMessage(message), selfUserId);
  return who !== 'You' && line.startsWith(`${who}: `) ? line.slice(who.length + 2) : line;
}

/**
 * The newest thing that needs you as the Inbox row's line: "Maya in looking-for-group: need
 * one for ranked", "Jeremy posted a video in clips" in a server, "Jeremy: see you tonight" in a
 * direct message. Null until its message is known (the row then says it in counts).
 */
export function inboxNewestLine(
  entry: Pick<ConversationEntry, 'guildId' | 'title'>,
  message: Message | null | undefined,
  selfUserId: string | null,
): string | null {
  if (!message) return null;
  const line = messageLine(message, selfUserId);
  if (!entry.guildId) return line;
  const who = authorLabel(previewFromMessage(message), selfUserId);
  if (line.startsWith(`${who}: `)) return `${who} in ${entry.title}: ${line.slice(who.length + 2)}`;
  return `${line} in ${entry.title}`;
}

/**
 * The line under a conversation's name. A direct message says what was said, with
 * no name in front ("see you tonight"); your own words start with "You:"; a group
 * names who spoke ("Nick: lol yeah"). Media with no text reads as what was posted,
 * with the name ("Nick posted 4 photos"), the way a channel's does.
 */
export function dmPreviewLine(
  entry: ChannelPreviewEntry | null | undefined,
  context: PreviewContext,
  group: boolean,
): string | null {
  if (!entry) return null;
  const line = previewLine(entry, context);
  if (!line) return null;
  if (group) return line;
  const who = authorLabel(entry, context.selfUserId);
  const prefix = `${who}: `;
  return who !== 'You' && line.startsWith(prefix) ? line.slice(prefix.length) : line;
}

/** What a row's state is in words, for its accessible name ("unread", "2 mentions"). */
export function dmStateWords(unread: boolean, mentions: number): string[] {
  const words: string[] = [];
  if (unread) words.push('unread');
  if (mentions > 0) words.push(mentions === 1 ? '1 mention' : `${mentions} mentions`);
  return words;
}
