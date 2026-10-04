import { describe, expect, it } from 'vitest';

import { MessageType, type Message } from '../../types';
import { buildTimelineRows, needsDivider, timeDividerParts, type MessageRow, type TimelineRow } from './timelineRows';
import type { VoiceLine } from './voiceLines';

/** The Index timeline's row model (docs/index-spec.md §4.11), without React. */

const at = (h: number, m: number, day = 1) => new Date(2026, 9, day, h, m).toISOString();

function msg(id: string, author: string, time: string, over: Partial<Message> = {}): Message {
  return {
    id,
    channel_id: 'c1',
    author: { id: author, username: author, discriminator: '0' },
    content: id,
    timestamp: time,
    created_at: time,
    tts: false,
    mention_everyone: false,
    pinned: false,
    type: MessageType.Default,
    attachments: [],
    reactions: [],
    ...over,
  };
}

const build = (drawn: Message[], extra: Partial<Parameters<typeof buildTimelineRows>[0]> = {}) =>
  buildTimelineRows({
    drawn,
    keyOf: (message) => message.id,
    replyParentOf: (message) => message.reference_id ?? null,
    isSystem: (message) => message.type === MessageType.PinnedMessage,
    ...extra,
  });

const kinds = (rows: TimelineRow[]) => rows.map((row) => (row.type === 'message' ? row.message.id : row.type));
const messageRow = (rows: TimelineRow[], id: string) =>
  rows.find((row): row is MessageRow => row.type === 'message' && row.message.id === id)!;

describe('the rows', () => {
  it('opens with a time divider and ends with the sentinel', () => {
    const rows = build([msg('a', 'j', at(21, 41)), msg('b', 'j', at(21, 41))]);
    expect(kinds(rows)).toEqual(['divider', 'a', 'b', 'sentinel']);
  });

  it('groups one author within five minutes: the first, the middle, the last', () => {
    const rows = build([msg('a', 'j', at(21, 41)), msg('b', 'j', at(21, 43)), msg('c', 'j', at(21, 45)), msg('d', 'n', at(21, 46))]);
    expect(messageRow(rows, 'a')).toMatchObject({ isGrouped: false, isLastInGroup: false });
    expect(messageRow(rows, 'b')).toMatchObject({ isGrouped: true, isLastInGroup: false });
    expect(messageRow(rows, 'c')).toMatchObject({ isGrouped: true, isLastInGroup: true });
    expect(messageRow(rows, 'd')).toMatchObject({ isGrouped: false, isLastInGroup: true });
  });

  it('puts a divider after more than 30 minutes and at a new day, and breaks the group there', () => {
    const rows = build([msg('a', 'j', at(21, 0)), msg('b', 'j', at(21, 31)), msg('c', 'j', at(0, 5, 2))]);
    expect(kinds(rows)).toEqual(['divider', 'a', 'divider', 'b', 'divider', 'c', 'sentinel']);
    expect(messageRow(rows, 'b').isGrouped).toBe(false);
  });

  it('breaks the group for a reply, a system line and the New divider', () => {
    const rows = build(
      [
        msg('a', 'j', at(21, 0)),
        msg('b', 'j', at(21, 1), { reference_id: 'x' }),
        msg('pin', 'j', at(21, 2), { type: MessageType.PinnedMessage }),
        msg('c', 'j', at(21, 3)),
        msg('d', 'j', at(21, 3)),
      ],
      { newIndex: 4 },
    );
    expect(messageRow(rows, 'b')).toMatchObject({ isGrouped: false, replyParentId: 'x' });
    expect(messageRow(rows, 'pin')).toMatchObject({ isSystem: true });
    expect(messageRow(rows, 'c')).toMatchObject({ isGrouped: false, isLastInGroup: true });
    expect(kinds(rows)).toEqual(['divider', 'a', 'b', 'pin', 'c', 'new', 'd', 'sentinel']);
    expect(messageRow(rows, 'd').isGrouped).toBe(false);
  });

  it('puts your voice join among the messages at its moment, and it ends the group above it', () => {
    const line: VoiceLine = { id: 'voice:1', kind: 'joined', guildId: 'g', channelId: 'v', at: at(21, 44) };
    const rows = build([msg('a', 'j', at(21, 41)), msg('b', 'j', at(21, 43)), msg('c', 'j', at(21, 46))], { voiceLines: [line] });
    expect(kinds(rows)).toEqual(['divider', 'a', 'b', 'voice', 'c', 'sentinel']);
    expect(messageRow(rows, 'b').isLastInGroup).toBe(true);
    expect(messageRow(rows, 'c').isGrouped).toBe(false);
  });

  it('draws the skeleton at the top while older history exists, and the typing row at the end', () => {
    const rows = build([msg('a', 'j', at(21, 41))], { hasMore: true, typing: true });
    expect(kinds(rows)).toEqual(['history', 'divider', 'a', 'typing', 'sentinel']);
  });

  it('keys every row by identity, and never twice', () => {
    const rows = build([msg('a', 'j', at(21, 41)), msg('b', 'j', at(21, 42))], {
      // A pairing gone wrong upstream: two messages claiming one key.
      keyOf: () => 'sending:n1',
    });
    const keys = rows.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('sending:n1');
    expect(keys).toContain('sending:n1#b');
  });
});

describe('divider rules and words', () => {
  it('knows when a divider is due', () => {
    expect(needsDivider(null, at(21, 0))).toBe(true);
    expect(needsDivider(at(21, 0), at(21, 30))).toBe(false);
    expect(needsDivider(at(21, 0), at(21, 31))).toBe(true);
    expect(needsDivider(at(23, 59), at(0, 1, 2))).toBe(true);
  });

  it('says Today, Yesterday, a weekday within six days, then the date (with the year when it is another)', () => {
    const now = new Date(2026, 9, 1, 22, 0).getTime();
    expect(timeDividerParts(at(21, 41), now).day).toBe('Today');
    expect(timeDividerParts(new Date(2026, 8, 30, 18, 20).toISOString(), now).day).toBe('Yesterday');
    expect(timeDividerParts(new Date(2026, 8, 29, 18, 20).toISOString(), now).day).toBe('Tuesday');
    expect(timeDividerParts(new Date(2026, 8, 28, 18, 20).toISOString(), now).day).toBe('Monday');
    expect(timeDividerParts(new Date(2026, 8, 20, 18, 20).toISOString(), now).day).toBe('Sep 20');
    expect(timeDividerParts(new Date(2025, 8, 28, 18, 20).toISOString(), now).day).toBe('Sep 28, 2025');
    expect(timeDividerParts(new Date(2026, 8, 28, 18, 20).toISOString(), now).time).toMatch(/^6:20\s?PM$/);
  });
});
