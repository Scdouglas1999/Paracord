import { describe, expect, it } from 'vitest';

import type { ChannelPreviewEntry } from '../../../hooks/useChannelPreviews';
import { ChannelType } from '../../../types';
import {
  clockShort,
  comingUpLine,
  dateTile,
  formatRowTime,
  fullWhen,
  headerLine,
  isPlaceChannel,
  orderChannels,
  previewLine,
  previewText,
  shortWhen,
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

  it('names an event that is the whole message (when no calendar time is known), and every event in a message that shares two', () => {
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

  it('reads media with no text as what was posted, without a colon (the reference: "Nick posted 4 photos")', () => {
    const image = { attachmentId: 'a', contentType: 'image/png', filename: 'x.png', width: 1, height: 1 };
    expect(previewLine(preview({ content: null, media: image, attachmentCount: 1 }), CONTEXT)).toBe('Jeremy posted a photo');
    expect(previewLine(preview({ content: null, media: image, attachmentCount: 4 }), CONTEXT)).toBe('Jeremy posted 4 photos');
    expect(previewLine(preview({ content: null, media: { ...image, contentType: 'video/mp4' }, attachmentCount: 1 }), CONTEXT)).toBe('Jeremy posted a video');
    expect(previewLine(preview({ content: null, media: { ...image, contentType: 'audio/ogg' }, attachmentCount: 1 }), CONTEXT)).toBe('Jeremy posted a recording');
    expect(previewLine(preview({ content: null, media: { ...image, contentType: 'application/pdf' }, attachmentCount: 1 }), CONTEXT)).toBe('Jeremy posted a file');
    // More than one of something that is not a picture is files; a count of pictures is photos only when the first is one.
    expect(previewLine(preview({ content: null, media: { ...image, contentType: 'application/pdf' }, attachmentCount: 3 }), CONTEXT)).toBe('Jeremy posted 3 files');
  });

  it('calls a video a clip only when its name says it is one of the app’s clips', () => {
    const video = { attachmentId: 'a', contentType: 'video/webm', filename: 'Clip 0m30s from Vincent’s screen.webm', width: 1, height: 1 };
    expect(previewLine(preview({ content: null, media: video, attachmentCount: 1 }), CONTEXT)).toBe('Jeremy posted a clip');
    expect(previewLine(preview({ content: null, media: { ...video, filename: 'holiday.webm' }, attachmentCount: 1 }), CONTEXT)).toBe('Jeremy posted a video');
  });

  it('reads a message that is only a scheduled event as the event and its time ("Movie night · Fri 9 PM")', () => {
    const friday = new Date(2026, 9, 2, 21, 0);
    const context = { ...CONTEXT, nowMs: NOW, events: new Map([['7002', { name: 'Movie night', startsAt: friday }]]) };
    expect(previewLine(preview({ content: '<event:7002>' }), context)).toBe('Movie night · Fri 9 PM');
    // With text around it, or an event the client does not know, it is the author's line.
    expect(previewLine(preview({ content: 'come to <event:7002>' }), context)).toBe('Jeremy: come to Movie night');
    expect(previewLine(preview({ content: '<event:9999>' }), context)).toBe('Jeremy: an event');
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


describe('when things are, in a few words', () => {
  const friday9 = new Date(2026, 9, 2, 21, 0).getTime();

  it('writes the clock on the hour as "9 PM", and the minutes when there are some', () => {
    expect(clockShort(friday9)).toBe('9 PM');
    expect(clockShort(new Date(2026, 9, 2, 21, 30).getTime())).toBe('9:30 PM');
  });

  it('says Today, a weekday within a week either way, a date beyond it', () => {
    expect(shortWhen(new Date(2026, 9, 1, 22, 0).getTime(), NOW)).toBe('Today 10 PM');
    expect(shortWhen(friday9, NOW)).toBe('Fri 9 PM');
    expect(shortWhen(new Date(2026, 9, 6, 9, 0).getTime(), NOW)).toBe('Tue 9 AM');
    expect(shortWhen(new Date(2026, 9, 9, 9, 0).getTime(), NOW)).toBe('Oct 9, 9 AM');
    expect(shortWhen(new Date(2027, 0, 5, 9, 0).getTime(), NOW)).toBe('Jan 5, 2027, 9 AM');
    expect(shortWhen(new Date(2026, 8, 29, 18, 0).getTime(), NOW)).toBe('Tue 6 PM');
  });

  it('writes the minutes always in the full form ("Fri 9:00 PM")', () => {
    expect(fullWhen(friday9, NOW)).toBe('Fri 9:00 PM');
    expect(fullWhen(new Date(2026, 9, 1, 22, 15).getTime(), NOW)).toBe('Today 10:15 PM');
  });
});

describe('the header line', () => {
  it('is "N members · M here now", singular for one', () => {
    expect(headerLine({ memberCount: 1, here: 1, rosterKnown: true })).toBe('1 member · 1 here now');
    expect(headerLine({ memberCount: 12, here: 4, rosterKnown: true })).toBe('12 members · 4 here now');
    expect(headerLine({ memberCount: 6, here: 0, rosterKnown: true })).toBe('6 members · 0 here now');
  });

  it('claims nothing about who is here before the roster is known', () => {
    expect(headerLine({ memberCount: 12, here: 0, rosterKnown: false })).toBe('12 members');
  });
});

describe('Coming up', () => {
  const event = { startsAt: new Date(2026, 9, 2, 21, 0), location: null as string | null };

  it('writes when, then where: the room, else the location, else only when', () => {
    expect(comingUpLine(event, { nowMs: NOW, roomName: 'Lounge' })).toBe('Fri 9:00 PM · Lounge');
    expect(comingUpLine({ ...event, location: 'Sean’s place' }, { nowMs: NOW, roomName: null })).toBe('Fri 9:00 PM · Sean’s place');
    expect(comingUpLine(event, { nowMs: NOW, roomName: null })).toBe('Fri 9:00 PM');
  });

  it('gives the date tile a weekday and the day of the month', () => {
    expect(dateTile(event.startsAt)).toEqual({ weekday: 'Fri', day: '2' });
  });
});
