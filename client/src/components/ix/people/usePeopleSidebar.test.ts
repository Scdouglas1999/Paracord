import { describe, expect, it } from 'vitest';

import type { ConversationEntry } from '../../../lib/attention/conversationModel';
import { inboxEntries, needsYou, summarizeInbox } from './usePeopleSidebar';

/** What belongs in the Inbox (docs/index-spec.md §6.6): a mention, or something unread; never a voice channel. */

const EPOCH_MS = 1704067200000;
const idAt = (min: number) => (BigInt(min * 60_000 + 1_800_000_000_000 - EPOCH_MS) << 22n).toString();

const entry = (key: string, over: Partial<ConversationEntry> = {}): ConversationEntry => ({
  key,
  scope: { serverId: 's', userId: 'me' },
  serverId: 's',
  channelId: key,
  guildId: 'g',
  kind: 'guild_text',
  title: key,
  contextLabel: 'Fuel',
  lastActivityId: idAt(1),
  unread: false,
  mentionCount: 0,
  isDMUnread: false,
  isThreadReply: false,
  hasVoiceActivity: false,
  pinned: false,
  ...over,
});

describe('needsYou', () => {
  it('is a mention, an unread channel, an unread message or a thread reply', () => {
    expect(needsYou(entry('a', { mentionCount: 1 }))).toBe(true);
    expect(needsYou(entry('a', { unread: true }))).toBe(true);
    expect(needsYou(entry('a', { kind: 'dm', guildId: null, isDMUnread: true }))).toBe(true);
    expect(needsYou(entry('a', { kind: 'thread', isThreadReply: true }))).toBe(true);
    expect(needsYou(entry('a'))).toBe(false);
  });

  it('is never a voice channel, however busy', () => {
    expect(needsYou(entry('a', { kind: 'voice', hasVoiceActivity: true, unread: true }))).toBe(false);
  });
});

describe('inboxEntries', () => {
  it('lists mentions first, then by the newest message, once each', () => {
    const list = inboxEntries([
      entry('quiet'),
      entry('older', { unread: true, lastActivityId: idAt(1) }),
      entry('newer', { unread: true, lastActivityId: idAt(5) }),
      entry('mentioned', { mentionCount: 2, lastActivityId: idAt(0) }),
      entry('newer', { unread: true, lastActivityId: idAt(5) }),
    ]);
    expect(list.map((item) => item.key)).toEqual(['mentioned', 'newer', 'older']);
  });
});

describe('summarizeInbox', () => {
  it('counts mentions across conversations, the conversations waiting, and names the one on top', () => {
    const summary = summarizeInbox([entry('a', { mentionCount: 2 }), entry('b', { mentionCount: 1 }), entry('c', { unread: true })]);
    expect(summary).toMatchObject({ mentions: 3, unread: 3 });
    expect(summary.top?.key).toBeDefined();
  });

  it('says nothing is waiting', () => {
    expect(summarizeInbox([entry('a')])).toEqual({ mentions: 0, unread: 0, top: null });
  });
});
