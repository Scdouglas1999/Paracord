import { describe, expect, it } from 'vitest';

import type { ChannelPreviewEntry } from '../../../hooks/useChannelPreviews';
import { ChannelType } from '../../../types';
import {
  BADGE_CAP,
  QUIET_AFTER_MS,
  badgeFor,
  badgeWords,
  capped,
  clockDigits,
  eventLine,
  eventTile,
  formatRowTime,
  glyphFor,
  isPlaceChannel,
  isQuietChannel,
  leadFaces,
  liveKicker,
  liveLine,
  mentionBadge,
  orderChannels,
  previewLine,
  previewText,
  serverLine,
  thumbnailOf,
  unreadBadge,
} from './model';

/** Thursday 1 October 2026, 9:12 PM in whatever zone the test runs in. */
const NOW = new Date(2026, 9, 1, 21, 12).getTime();
const at = (month: number, day: number, hour = 12, minute = 0) => new Date(2026, month, day, hour, minute).getTime();

describe('formatRowTime', () => {
  it('writes today as a clock time', () => {
    expect(formatRowTime(at(9, 1, 21, 9), NOW)).toBe('9:09 PM');
    expect(formatRowTime(new Date(at(9, 1, 6, 5)).toISOString(), NOW)).toBe('6:05 AM');
  });

  it('writes the last six days as a weekday, as the reference does', () => {
    expect(formatRowTime(at(8, 29, 16, 30), NOW)).toBe('Tue');
    expect(formatRowTime(at(8, 27, 11, 20), NOW)).toBe('Sun');
    expect(formatRowTime(at(8, 26), NOW)).toBe('Sat');
    // Six days back is still a weekday; a week back would read the same as today's.
    expect(formatRowTime(at(8, 25), NOW)).toBe('Fri');
  });

  it('writes anything older as a date, with the year only when it is another year', () => {
    expect(formatRowTime(at(8, 24), NOW)).toBe('Sep 24');
    expect(formatRowTime(at(8, 22), NOW)).toBe('Sep 22');
    expect(formatRowTime(new Date(2025, 11, 3).getTime(), NOW)).toBe('Dec 3, 2025');
  });

  it('is empty for no time and for a time that is not one', () => {
    expect(formatRowTime(null, NOW)).toBeNull();
    expect(formatRowTime(undefined, NOW)).toBeNull();
    expect(formatRowTime('not a date', NOW)).toBeNull();
  });

  it('counts calendar days, not 24 hour spans', () => {
    // 11:50 PM last night is yesterday even though it was 22 minutes ago.
    const late = new Date(2026, 9, 1, 0, 10).getTime();
    expect(formatRowTime(new Date(2026, 8, 30, 23, 50).getTime(), late)).toBe('Wed');
  });
});

describe('clockDigits', () => {
  it('drops the AM or PM for a date tile that says TODAY', () => {
    expect(clockDigits(at(9, 1, 21, 30))).toBe('9:30');
    expect(clockDigits(at(9, 1, 7, 5))).toBe('7:05');
  });
});

describe('quiet channels', () => {
  it('is quiet after a week with nothing unread', () => {
    const lastMessageMs = NOW - QUIET_AFTER_MS - 1;
    expect(isQuietChannel({ lastMessageMs, nowMs: NOW, unread: false, mentions: 0 })).toBe(true);
  });

  it('is not quiet inside the week, at the boundary or after', () => {
    expect(isQuietChannel({ lastMessageMs: NOW - QUIET_AFTER_MS, nowMs: NOW, unread: false, mentions: 0 })).toBe(false);
    expect(isQuietChannel({ lastMessageMs: NOW - 2 * 24 * 3600_000, nowMs: NOW, unread: false, mentions: 0 })).toBe(false);
  });

  it('is never quiet with something unread or a mention, however old', () => {
    const old = NOW - 90 * 24 * 3600_000;
    expect(isQuietChannel({ lastMessageMs: old, nowMs: NOW, unread: true, mentions: 0 })).toBe(false);
    expect(isQuietChannel({ lastMessageMs: old, nowMs: NOW, unread: false, mentions: 1 })).toBe(false);
  });

  it('is quiet when a channel has never had a message', () => {
    expect(isQuietChannel({ lastMessageMs: null, nowMs: NOW, unread: false, mentions: 0 })).toBe(true);
  });
});

describe('badges', () => {
  it('writes a single mention as a bare @ and more as @N', () => {
    expect(mentionBadge(1)).toEqual({ kind: 'mention', count: 1, label: '@' });
    expect(mentionBadge(2)).toEqual({ kind: 'mention', count: 2, label: '@2' });
    expect(mentionBadge(250)).toMatchObject({ label: '@99+' });
  });

  it('writes a known unread count, and a dot when it is not known', () => {
    expect(unreadBadge(4)).toEqual({ kind: 'count', count: 4, label: '4' });
    expect(unreadBadge(null)).toEqual({ kind: 'dot' });
    expect(capped(BADGE_CAP)).toBe('99');
    expect(capped(BADGE_CAP + 1)).toBe('99+');
  });

  it('lets a mention outrank a count, and a muted channel say nothing', () => {
    expect(badgeFor({ muted: false, mentions: 1, unread: true, unreadCount: 6 })).toMatchObject({ kind: 'mention' });
    expect(badgeFor({ muted: false, mentions: 0, unread: true, unreadCount: 6 })).toMatchObject({ kind: 'count', label: '6' });
    expect(badgeFor({ muted: false, mentions: 0, unread: true, unreadCount: null })).toEqual({ kind: 'dot' });
    expect(badgeFor({ muted: false, mentions: 0, unread: false, unreadCount: null })).toBeNull();
    expect(badgeFor({ muted: true, mentions: 3, unread: true, unreadCount: 2 })).toBeNull();
  });

  it('gives every badge words for a screen reader', () => {
    expect(badgeWords(mentionBadge(1))).toBe('1 mention');
    expect(badgeWords(mentionBadge(3))).toBe('3 mentions');
    expect(badgeWords(unreadBadge(4))).toBe('4 unread');
    expect(badgeWords(unreadBadge(100))).toBe('more than 99 unread');
    expect(badgeWords({ kind: 'dot' })).toBe('unread');
    expect(badgeWords(null)).toBeNull();
  });
});

describe('channel order', () => {
  const channel = (id: string, type: ChannelType, position: number, parent_id: string | null = null) => ({ id, type, position, parent_id });

  it('puts uncategorized channels first, then each category in position order', () => {
    const ordered = orderChannels([
      channel('c-b', ChannelType.Text, 1, 'cat2'),
      channel('cat2', ChannelType.Category, 2),
      channel('c-a', ChannelType.Voice, 0, 'cat1'),
      channel('cat1', ChannelType.Category, 1),
      channel('loose-2', ChannelType.Text, 5),
      channel('loose-1', ChannelType.Text, 3),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(['loose-1', 'loose-2', 'c-a', 'c-b']);
  });

  it('keeps only channels that are rows: no categories, no threads', () => {
    const ordered = orderChannels([
      channel('cat', ChannelType.Category, 0),
      channel('thread', ChannelType.Thread, 0, 'text'),
      channel('text', ChannelType.Text, 0),
      channel('forum', ChannelType.Forum, 1),
      channel('stage', ChannelType.Stage, 2),
      channel('news', ChannelType.Announcement, 3),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(['text', 'forum', 'stage', 'news']);
    expect(isPlaceChannel(ChannelType.Thread)).toBe(false);
    expect(isPlaceChannel(ChannelType.DM)).toBe(false);
  });

  it('treats a channel whose category is gone as uncategorized', () => {
    const ordered = orderChannels([channel('orphan', ChannelType.Text, 0, 'missing-category')]);
    expect(ordered.map((entry) => entry.id)).toEqual(['orphan']);
  });

  it('gives each kind of channel its glyph', () => {
    expect(glyphFor(ChannelType.Text)).toBe('chat');
    expect(glyphFor(ChannelType.Voice)).toBe('voice');
    expect(glyphFor(ChannelType.Stage)).toBe('stage');
    expect(glyphFor(ChannelType.Announcement)).toBe('announcement');
    expect(glyphFor(ChannelType.Forum)).toBe('forum');
  });
});

function preview(over: Partial<ChannelPreviewEntry> = {}): ChannelPreviewEntry {
  return {
    channelId: 'c1',
    messageId: '100',
    messageType: 0,
    author: { id: 'u2', kind: 'user', name: 'Jeremy', avatar: null },
    content: 'hello there',
    encrypted: false,
    createdAt: new Date(NOW).toISOString(),
    media: null,
    attachmentCount: 0,
    hasSticker: false,
    ...over,
  };
}

const CONTEXT = {
  selfUserId: 'u1',
  memberNames: new Map([['42', 'Sean'], ['u2', 'Jeremy']]),
  channelNames: new Map([['9', 'Lounge']]),
  eventNames: new Map([['7002', 'Movie night'], ['7003', 'snake_case_run *final*']]),
};

describe('previewLine', () => {
  it('is "Author: text", with a mention as the person’s name', () => {
    expect(previewLine(preview({ content: '<@42> is movie night still on?' }), CONTEXT)).toBe('Jeremy: @Sean is movie night still on?');
  });

  it('says You for your own message', () => {
    expect(previewLine(preview({ author: { id: 'u1', kind: 'user', name: 'Sean', avatar: null } }), CONTEXT)).toBe('You: hello there');
  });

  it('never adds a # of its own: a channel mention is the channel’s name', () => {
    const line = previewLine(preview({ content: 'meet in <#9> and <#77>' }), CONTEXT);
    expect(line).toBe('Jeremy: meet in Lounge and a channel');
    expect(line).not.toContain('#');
  });

  it('names a shared event when the client knows it, and says "an event" when it does not', () => {
    // The reference: "Jeremy: @Sean is movie n…". An `<event:id>` is only an id on the wire.
    expect(previewLine(preview({ content: '<@42> is <event:7002> still on?' }), CONTEXT)).toBe('Jeremy: @Sean is Movie night still on?');
    const unknown = previewLine(preview({ content: '<@42> is <event:9999> still on?' }), CONTEXT);
    expect(unknown).toBe('Jeremy: @Sean is an event still on?');
    expect(unknown).not.toContain('9999');
  });

  it('names an event that is the whole message, and every event in a message that shares two', () => {
    expect(previewLine(preview({ content: '<event:7002>' }), CONTEXT)).toBe('Jeremy: Movie night');
    expect(previewLine(preview({ content: '<event:7002> <event:9999>' }), CONTEXT)).toBe('Jeremy: Movie night an event');
  });

  it('does not read a name as formatting', () => {
    expect(previewLine(preview({ content: 'come to <event:7003>' }), CONTEXT)).toBe('Jeremy: come to snake_case_run *final*');
  });

  it('strips markdown and collapses whitespace', () => {
    expect(previewLine(preview({ content: '**bold**\n\n`code`   and _more_' }), CONTEXT)).toBe('Jeremy: bold code and more');
  });

  it('does not unwrap a spoiler', () => {
    const line = previewLine(preview({ content: 'the twist is ||the butler||' }), CONTEXT);
    expect(line).not.toContain('butler');
    expect(line).toContain('spoiler');
  });

  it('reads media with no text as what was shared, without a colon', () => {
    const image = { attachmentId: 'a', contentType: 'image/png', filename: 'x.png', width: 1, height: 1 };
    expect(previewLine(preview({ content: null, media: image, attachmentCount: 1 }), CONTEXT)).toBe('Jeremy shared a photo');
    expect(previewLine(preview({ content: null, media: { ...image, contentType: 'video/mp4' }, attachmentCount: 1 }), CONTEXT)).toBe('Jeremy shared a video');
    expect(previewLine(preview({ content: null, media: { ...image, contentType: 'application/pdf' }, attachmentCount: 1 }), CONTEXT)).toBe('Jeremy shared a file');
    expect(previewLine(preview({ content: null, media: image, attachmentCount: 12 }), CONTEXT)).toBe('Jeremy shared 12 files');
  });

  it('keeps the text of a message that also has media', () => {
    const image = { attachmentId: 'a', contentType: 'image/png', filename: 'x.png', width: 1, height: 1 };
    expect(previewLine(preview({ content: 'new personal best, 41:07', media: image, attachmentCount: 1 }), CONTEXT)).toBe('Jeremy: new personal best, 41:07');
  });

  it('says an encrypted message is one, and never shows text for it', () => {
    expect(previewLine(preview({ content: null, encrypted: true }), CONTEXT)).toBe('Jeremy: Encrypted message');
  });

  it('writes a poll, a sticker and a system message in words', () => {
    expect(previewLine(preview({ messageType: 20, content: 'Late one after the run?' }), CONTEXT)).toBe('Jeremy started a poll: Late one after the run?');
    expect(previewLine(preview({ content: null, hasSticker: true }), CONTEXT)).toBe('Jeremy sent a sticker');
    expect(previewLine(preview({ messageType: 7, content: null }), CONTEXT)).toBe('Jeremy joined the server');
    expect(previewLine(preview({ messageType: 6, content: null }), CONTEXT)).toBe('Jeremy pinned a message');
    expect(previewLine(preview({ messageType: 99, content: null }), CONTEXT)).toBe('New activity');
  });

  it('is null for a channel with nothing in it, and uses "Someone" for an author it lost', () => {
    expect(previewLine(null, CONTEXT)).toBeNull();
    expect(previewLine(preview({ author: { id: 'gone', kind: 'user', name: null, avatar: null } }), CONTEXT)).toBe('Someone: hello there');
  });

  it('exposes the text step on its own', () => {
    expect(previewText('hi <@42>', CONTEXT)).toBe('hi @Sean');
    expect(previewText('hi <@777>', CONTEXT)).toBe('hi @someone');
  });
});

describe('thumbnailOf', () => {
  const image = { attachmentId: 'a1', contentType: 'image/png', filename: 'mission.png', width: 480, height: 270 };

  it('is the latest picture', () => {
    expect(thumbnailOf(preview({ media: image }))).toEqual({ attachmentId: 'a1', label: 'mission.png' });
  });

  it('is nothing for a video, a file, no media, an encrypted message or no message', () => {
    expect(thumbnailOf(preview({ media: { ...image, contentType: 'video/mp4' } }))).toBeNull();
    expect(thumbnailOf(preview({ media: { ...image, contentType: null } }))).toBeNull();
    expect(thumbnailOf(preview({ media: null }))).toBeNull();
    expect(thumbnailOf(preview({ media: image, encrypted: true }))).toBeNull();
    expect(thumbnailOf(null)).toBeNull();
  });
});

describe('leadFaces', () => {
  const face = (id: string) => ({ userId: id, name: id, avatar: null });

  it('puts the earlier speaker behind and the latest in front', () => {
    // Newest first in, back to front out.
    expect(leadFaces([face('jeremy'), face('nick'), face('luke')]).map((entry) => entry.userId)).toEqual(['nick', 'jeremy']);
  });

  it('skips a repeated speaker and can be one face', () => {
    expect(leadFaces([face('nick'), face('nick'), face('luke')]).map((entry) => entry.userId)).toEqual(['luke', 'nick']);
    expect(leadFaces([face('nick')]).map((entry) => entry.userId)).toEqual(['nick']);
    expect(leadFaces([])).toEqual([]);
  });
});

describe('serverLine', () => {
  it('names the busiest voice channel while somebody is in one', () => {
    expect(serverLine({ rosterKnown: true, memberCount: 8, online: 8, live: [{ name: 'Lounge', occupants: 3 }] })).toBe('8 online, 3 in Lounge');
  });

  it('counts voice channels together when there are several', () => {
    expect(
      serverLine({ rosterKnown: true, memberCount: 8, online: 6, live: [{ name: 'Lounge', occupants: 3 }, { name: 'Pit', occupants: 2 }] }),
    ).toBe('6 online, 5 in voice');
  });

  it('is members and online when nothing is live, singular for one', () => {
    expect(serverLine({ rosterKnown: true, memberCount: 5, online: 2, live: [] })).toBe('5 members, 2 online');
    expect(serverLine({ rosterKnown: true, memberCount: 1, online: 1, live: [] })).toBe('1 member, 1 online');
  });

  it('claims nothing about who is online before the roster is known', () => {
    expect(serverLine({ rosterKnown: false, memberCount: 24, online: 0, live: [] })).toBe('24 members');
  });
});

describe('live rows', () => {
  it('says what is going on, most interesting first', () => {
    expect(liveLine({ streamerName: 'Vincent', talkingNames: ['Brendan'], occupantNames: ['Vincent', 'Brendan'], occupants: 2 })).toBe('Vincent is streaming');
    expect(liveLine({ streamerName: null, talkingNames: ['Brendan'], occupantNames: ['Brendan', 'Nick'], occupants: 2 })).toBe('Brendan is talking');
    expect(liveLine({ streamerName: null, talkingNames: ['Brendan', 'Nick'], occupantNames: [], occupants: 3 })).toBe('2 talking');
    expect(liveLine({ streamerName: null, talkingNames: [], occupantNames: ['Nick'], occupants: 1 })).toBe('Nick is in');
    expect(liveLine({ streamerName: null, talkingNames: [], occupantNames: [], occupants: 3 })).toBe('3 in here');
  });

  it('writes the minutes only when the stream’s start time is known', () => {
    const started = new Date(NOW - 42 * 60_000 - 5_000).toISOString();
    expect(liveKicker(started, NOW)).toBe('LIVE 42 MIN');
    expect(liveKicker(null, NOW)).toBe('LIVE');
    expect(liveKicker(undefined, NOW)).toBe('LIVE');
    expect(liveKicker('garbage', NOW)).toBe('LIVE');
    // A start in the future is a clock disagreement, not a negative age.
    expect(liveKicker(new Date(NOW + 60_000).toISOString(), NOW)).toBe('LIVE');
  });
});

describe('events', () => {
  const event = (over: Partial<Parameters<typeof eventTile>[0] & Parameters<typeof eventLine>[0]> = {}) => ({
    startsAt: new Date(at(9, 1, 21, 30)),
    happeningNow: false,
    channelId: null,
    location: null,
    creatorId: null,
    going: 0,
    ...over,
  });

  it('shows TODAY with the time, a weekday with the day of the month, and NOW while it runs', () => {
    expect(eventTile(event(), NOW)).toEqual({ top: 'Today', bottom: '9:30' });
    expect(eventTile(event({ startsAt: new Date(at(9, 2, 21, 0)) }), NOW)).toEqual({ top: 'Fri', bottom: '2' });
    expect(eventTile(event({ startsAt: new Date(at(9, 3, 7, 0)) }), NOW)).toEqual({ top: 'Sat', bottom: '3' });
    expect(eventTile(event({ happeningNow: true, startsAt: new Date(at(9, 1, 21, 0)) }), NOW)).toEqual({ top: 'Now', bottom: '9:00' });
  });

  it('shows the month once it is a week or more away', () => {
    expect(eventTile(event({ startsAt: new Date(at(9, 14, 20, 0)) }), NOW)).toEqual({ top: 'Oct', bottom: '14' });
  });

  it('leaves the time to the tile today, and writes it in the line otherwise', () => {
    const context = { nowMs: NOW, selfUserId: 'u1', roomName: null };
    expect(eventLine(event({ channelId: 'l' }), { ...context, roomName: 'Lounge' })).toBe('Lounge');
    expect(eventLine(event({ channelId: 'l', going: 3 }), { ...context, roomName: 'Lounge' })).toBe('Lounge, 3 going');
    expect(eventLine(event({ startsAt: new Date(at(9, 2, 21, 0)), creatorId: 'u1', going: 6 }), context)).toBe("9:00 PM, you're hosting, 6 going");
    expect(eventLine(event({ startsAt: new Date(at(9, 3, 7, 0)), location: 'the north lot', going: 4 }), context)).toBe('7:00 AM at the north lot, 4 going');
    expect(eventLine(event({ startsAt: new Date(at(9, 2, 21, 0)), channelId: 'l' }), { ...context, roomName: 'Lounge' })).toBe('9:00 PM in Lounge');
  });

  it('never claims a spot count the server does not have', () => {
    const line = eventLine(event({ going: 3 }), { nowMs: NOW, selfUserId: null, roomName: 'Lounge' });
    expect(line).not.toMatch(/spot/i);
  });

  it('has something to say for an event with nothing else to say', () => {
    expect(eventLine(event(), { nowMs: NOW, selfUserId: null, roomName: null })).toBe('Scheduled');
  });
});
