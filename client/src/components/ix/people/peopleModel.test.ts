import { describe, expect, it } from 'vitest';

import type { ChannelPreviewEntry } from '../../../hooks/useChannelPreviews';
import type { ConversationEntry } from '../../../lib/attention/conversationModel';
import type { Message } from '../../../types';
import {
  directConversations,
  dmPreviewLine,
  dmStateWords,
  friendsLine,
  inboxLine,
  inboxNewestLine,
  inboxPageLine,
  messageLine,
  requestsWords,
} from './peopleModel';

/** The words of the People sidebar (docs/index-spec.md §6.6). */

const EPOCH_MS = 1704067200000;
const idAt = (ms: number) => (BigInt(ms - EPOCH_MS) << 22n).toString();
const NOW = new Date(2026, 9, 1, 21, 38).getTime();

const entry = (key: string, over: Partial<ConversationEntry> = {}): ConversationEntry => ({
  key,
  scope: { serverId: 's', userId: 'me' },
  serverId: 's',
  channelId: key,
  guildId: null,
  kind: 'dm',
  title: key,
  contextLabel: null,
  lastActivityId: idAt(NOW - 60_000),
  unread: false,
  mentionCount: 0,
  isDMUnread: false,
  isThreadReply: false,
  hasVoiceActivity: false,
  pinned: false,
  ...over,
});

describe('directConversations', () => {
  it('keeps direct and group messages only, pinned first, then the newest message first', () => {
    const list = directConversations([
      [entry('old', { lastActivityId: idAt(NOW - 3_600_000) }), entry('chan', { kind: 'guild_text', guildId: 'g' })],
      [entry('new', { lastActivityId: idAt(NOW - 1_000) }), entry('pinned', { pinned: true, lastActivityId: idAt(NOW - 9_000_000) })],
      [entry('group', { kind: 'group_dm', lastActivityId: idAt(NOW - 120_000) })],
    ]);
    expect(list.map((item) => item.key)).toEqual(['pinned', 'new', 'group', 'old']);
  });

  it('lists a conversation once however many lists carry it', () => {
    const one = entry('a');
    expect(directConversations([[one], [one], [{ ...one }]])).toHaveLength(1);
  });

  it('breaks a tie by key, so the order never flickers', () => {
    const at = idAt(NOW);
    expect(directConversations([[entry('b', { lastActivityId: at }), entry('a', { lastActivityId: at })]]).map((item) => item.key)).toEqual(['a', 'b']);
  });
});

describe('the Friends row', () => {
  it('says who is online and how many requests wait, in that order', () => {
    expect(friendsLine({ friends: 8, online: 3, requests: 1 })).toBe('3 online · 1 request');
    expect(friendsLine({ friends: 8, online: 3, requests: 2 })).toBe('3 online · 2 requests');
    expect(friendsLine({ friends: 8, online: 0, requests: 2 })).toBe('2 requests');
    expect(friendsLine({ friends: 8, online: 4, requests: 0 })).toBe('4 online');
  });

  it('says so when nobody is online, and what to do when there are no friends', () => {
    expect(friendsLine({ friends: 8, online: 0, requests: 0 })).toBe('None online');
    expect(friendsLine({ friends: 0, online: 0, requests: 0 })).toBe('Add a friend');
  });

  it('words a request count', () => {
    expect(requestsWords(1)).toBe('1 request');
    expect(requestsWords(5)).toBe('5 requests');
  });
});

describe('the Inbox row', () => {
  it('shows the newest thing that needs you when it is known', () => {
    expect(inboxLine({ newest: 'Maya in lfg: need one', mentions: 2, unread: 3, reminders: 0 })).toBe('Maya in lfg: need one');
  });

  it('falls to counts, then to "All caught up"', () => {
    expect(inboxLine({ newest: null, mentions: 2, unread: 3, reminders: 0 })).toBe('2 mentions · 3 unread');
    expect(inboxLine({ newest: null, mentions: 1, unread: 1, reminders: 1 })).toBe('1 mention · 1 unread · 1 reminder');
    expect(inboxLine({ newest: null, mentions: 0, unread: 0, reminders: 0 })).toBe('All caught up');
  });
});

const message = (over: Record<string, unknown> = {}): Message =>
  ({
    id: idAt(NOW),
    channel_id: 'c',
    author: { id: 'u2', username: 'maya', display_name: 'Maya' },
    content: 'need one for ranked',
    type: 0,
    attachments: [],
    created_at: new Date(NOW).toISOString(),
    ...over,
  }) as unknown as Message;

describe('messageLine and inboxNewestLine', () => {
  it('words a message as a last line: who, then what', () => {
    expect(messageLine(message(), 'me')).toBe('Maya: need one for ranked');
    expect(messageLine(message({ author: { id: 'me', username: 'sean', display_name: 'Sean' } }), 'me')).toBe('You: need one for ranked');
  });

  it('words media with no text as what was posted', () => {
    const photos = message({
      content: '',
      attachments: [1, 2, 3, 4].map((n) => ({ id: `a${n}`, filename: `p${n}.png`, content_type: 'image/png', size: 1 })),
    });
    expect(messageLine(photos, 'me')).toBe('Maya posted 4 photos');
  });

  it('never decrypts: an encrypted message says so', () => {
    expect(messageLine(message({ e2ee: { v: 1 }, content: 'ciphertext' }), 'me')).toBe('Maya: Encrypted message');
  });

  it('puts the channel in the line for a server and leaves a direct message as it is', () => {
    expect(inboxNewestLine({ guildId: 'g', title: 'looking-for-group' }, message(), 'me')).toBe('Maya in looking-for-group: need one for ranked');
    const clip = message({ content: '', attachments: [{ id: 'a', filename: 'clip.mp4', content_type: 'video/mp4', size: 1 }] });
    expect(inboxNewestLine({ guildId: 'g', title: 'clips' }, clip, 'me')).toBe('Maya posted a video in clips');
    expect(inboxNewestLine({ guildId: null, title: 'Maya' }, message(), 'me')).toBe('Maya: need one for ranked');
    expect(inboxNewestLine({ guildId: 'g', title: 'clips' }, null, 'me')).toBeNull();
  });
});

describe('inboxPageLine', () => {
  it('says who spoke, except in a one-to-one message where the row\'s head already says it', () => {
    expect(inboxPageLine({ kind: 'guild_text' }, message(), 'me')).toBe('Maya: need one for ranked');
    expect(inboxPageLine({ kind: 'group_dm' }, message(), 'me')).toBe('Maya: need one for ranked');
    expect(inboxPageLine({ kind: 'dm' }, message(), 'me')).toBe('need one for ranked');
    expect(inboxPageLine({ kind: 'dm' }, message({ author: { id: 'me', username: 'sean', display_name: 'Sean' } }), 'me')).toBe('You: need one for ranked');
  });
});

describe('dmPreviewLine', () => {
  const context = { selfUserId: 'me', memberNames: new Map<string, string>(), channelNames: new Map<string, string>(), eventNames: new Map<string, string>() };
  const preview = (over: Partial<ChannelPreviewEntry> = {}): ChannelPreviewEntry => ({
    channelId: 'c',
    messageId: '1',
    messageType: 0,
    author: { id: 'u2', kind: 'user', name: 'Jeremy', avatar: null },
    content: 'see you tonight',
    encrypted: false,
    createdAt: new Date(NOW).toISOString(),
    media: null,
    attachmentCount: 0,
    hasSticker: false,
    ...over,
  });

  it('a direct message says what was said, with no name in front', () => {
    expect(dmPreviewLine(preview(), context, false)).toBe('see you tonight');
  });

  it('your own words start with "You:" in a direct message and in a group', () => {
    const mine = preview({ author: { id: 'me', kind: 'user', name: 'Sean', avatar: null } });
    expect(dmPreviewLine(mine, context, false)).toBe('You: see you tonight');
    expect(dmPreviewLine(mine, context, true)).toBe('You: see you tonight');
  });

  it('a group names who spoke', () => {
    expect(dmPreviewLine(preview(), context, true)).toBe('Jeremy: see you tonight');
  });

  it('media with no text keeps the name ("Nick posted 4 photos")', () => {
    const photos = preview({ content: null, attachmentCount: 4, media: { attachmentId: 'a', contentType: 'image/png', filename: 'p.png', width: 1, height: 1 } });
    expect(dmPreviewLine(photos, context, false)).toBe('Jeremy posted 4 photos');
  });

  it('has nothing to say about no message', () => {
    expect(dmPreviewLine(null, context, false)).toBeNull();
  });
});

describe('dmStateWords', () => {
  it('names what a dot and a count only draw', () => {
    expect(dmStateWords(false, 0)).toEqual([]);
    expect(dmStateWords(true, 0)).toEqual(['unread']);
    expect(dmStateWords(true, 1)).toEqual(['unread', '1 mention']);
    expect(dmStateWords(true, 3)).toEqual(['unread', '3 mentions']);
  });
});
