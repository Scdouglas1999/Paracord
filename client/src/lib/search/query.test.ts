import { describe, expect, it } from 'vitest';
import {
  applyChip,
  interpretSearchDraft,
  parseSearchDay,
  searchLoadedMessages,
  suggestionsFor,
  toGuildSearchParams,
  type CatalogChannel,
  type CatalogMember,
  type SearchChip,
} from './query';

const NOW = new Date(2026, 8, 22, 15, 0, 0);

const MEMBERS: CatalogMember[] = [
  { id: '1', label: 'Yara', names: ['yara', 'yara chen'] },
  { id: '2', label: 'Yasmin', names: ['yasmin'] },
  { id: '3', label: 'Mira', names: ['mira'] },
];

const CHANNELS: CatalogChannel[] = [
  { id: 'c-design', name: 'design' },
  { id: 'c-design-systems', name: 'design-systems' },
  { id: 'c-general', name: 'general' },
];

function interpret(draft: string) {
  return interpretSearchDraft(draft, MEMBERS, CHANNELS, NOW);
}

describe('parseSearchDay', () => {
  it('accepts a calendar day, today, yesterday, and last week', () => {
    expect(parseSearchDay('2026-09-01', NOW)).toBe('2026-09-01');
    expect(parseSearchDay('today', NOW)).toBe('2026-09-22');
    expect(parseSearchDay('yesterday', NOW)).toBe('2026-09-21');
    expect(parseSearchDay('last week', NOW)).toBe('2026-09-15');
  });

  it('rejects dates that are not on the calendar', () => {
    expect(parseSearchDay('2026-02-31', NOW)).toBeNull();
    expect(parseSearchDay('last', NOW)).toBeNull();
    expect(parseSearchDay('tomorrow', NOW)).toBeNull();
  });
});

describe('interpretSearchDraft', () => {
  it('keeps free text and leaves an unfinished filter active', () => {
    const result = interpret('postgres from:ya');
    expect(result.chips).toEqual([]);
    expect(result.remainder).toBe('postgres from:ya');
    expect(result.active).toEqual({ key: 'from', raw: 'ya' });
    expect(result.error).toBeNull();
    expect(suggestionsFor(result.active!, MEMBERS, CHANNELS, NOW).map((item) => item.label))
      .toEqual(['Yara', 'Yasmin']);
  });

  it('commits a unique member, a channel, and a has filter', () => {
    const result = interpret('postgres from:mira in:#design has:link');
    expect(result.error).toBeNull();
    expect(result.remainder).toBe('postgres');
    expect(result.chips).toEqual<SearchChip[]>([
      { kind: 'from', userId: '3', label: 'Mira' },
      { kind: 'in', channelId: 'c-design', label: 'design' },
      { kind: 'has', value: 'link' },
    ]);
  });

  it('waits to commit a channel whose name is a prefix of another', () => {
    const open = interpret('in:design');
    expect(open.chips).toEqual([]);
    expect(open.active?.key).toBe('in');
    const closed = interpret('in:design ');
    expect(closed.chips).toEqual([{ kind: 'in', channelId: 'c-design', label: 'design' }]);
    expect(closed.remainder).toBe('');
  });

  it('commits dates and pinned, and shows the parsed day', () => {
    const dated = interpret('before:yesterday during:2026-09-01');
    expect(dated.chips).toEqual([
      { kind: 'before', day: '2026-09-21' },
      { kind: 'during', day: '2026-09-01' },
    ]);
    const pinned = interpret('is:pinned');
    expect(pinned.chips).toEqual([{ kind: 'pinned' }]);
    const week = interpret('after:last week');
    expect(week.chips).toEqual([{ kind: 'after', day: '2026-09-15' }]);
  });

  it('keeps "last week" open while it is typed across the space', () => {
    for (const draft of ['before:last', 'before:last ', 'before:last w', 'before:last wee']) {
      const result = interpret(draft);
      expect(result.error).toBeNull();
      expect(result.chips).toEqual([]);
      expect(result.active?.key).toBe('before');
    }
    expect(interpret('before:last week').chips).toEqual([{ kind: 'before', day: '2026-09-15' }]);
  });

  it('commits a filter typed in upper case and keeps text on both sides', () => {
    const result = interpret('deploy HAS:Link notes');
    expect(result.chips).toEqual([{ kind: 'has', value: 'link' }]);
    expect(result.remainder).toBe('deploy notes');
  });

  it('matches a member by nickname or display name, not only username', () => {
    const result = interpret('from:yara chen');
    // `from:yara` is an exact name here, and the rest is free text.
    expect(result.chips).toEqual([{ kind: 'from', userId: '1', label: 'Yara' }]);
    expect(result.remainder).toBe('chen');
  });

  it('does not read a colon inside a word as a filter', () => {
    const result = interpret('ratio 16:9 https://example.com');
    expect(result.chips).toEqual([]);
    expect(result.active).toBeNull();
    expect(result.remainder).toBe('ratio 16:9 https://example.com');
  });

  it('suggests every has value with an empty prefix and narrows as you type', () => {
    expect(suggestionsFor({ key: 'has', raw: '' }, MEMBERS, CHANNELS, NOW).map((item) => item.label))
      .toEqual(['link', 'image', 'video', 'file', 'poll', 'embed']);
    expect(suggestionsFor({ key: 'has', raw: 'i' }, MEMBERS, CHANNELS, NOW).map((item) => item.label))
      .toEqual(['image']);
  });

  it('suggests channels by prefix with or without the #', () => {
    const labels = (raw: string) => suggestionsFor({ key: 'in', raw }, MEMBERS, CHANNELS, NOW)
      .map((item) => item.label);
    expect(labels('#des')).toEqual(['#design', '#design-systems']);
    expect(labels('gen')).toEqual(['#general']);
  });

  it('offers today, yesterday and last week with the parsed day for a date filter', () => {
    const items = suggestionsFor({ key: 'during', raw: '' }, MEMBERS, CHANNELS, NOW);
    expect(items.map((item) => [item.label, item.hint])).toEqual([
      ['today', '2026-09-22'],
      ['yesterday', '2026-09-21'],
      ['last week', '2026-09-15'],
    ]);
  });

  it('reports an unknown closed filter instead of treating it as text', () => {
    const result = interpret('has:sticker ');
    expect(result.chips).toEqual([]);
    expect(result.error).toMatch(/has:/);
  });

  it('reports a member that does not exist once the token is finished', () => {
    const result = interpret('from:nobody ');
    expect(result.error).toMatch(/No member matches/);
  });
});

describe('applyChip', () => {
  it('replaces a single-value filter and lets has repeat', () => {
    const first = applyChip([], { kind: 'from', userId: '1', label: 'Yara' });
    const replaced = applyChip(first, { kind: 'from', userId: '3', label: 'Mira' });
    expect(replaced).toEqual([{ kind: 'from', userId: '3', label: 'Mira' }]);
    const has = applyChip(
      applyChip([], { kind: 'has', value: 'link' }),
      { kind: 'has', value: 'image' },
    );
    expect(has).toEqual([
      { kind: 'has', value: 'link' },
      { kind: 'has', value: 'image' },
    ]);
    const again = applyChip(has, { kind: 'has', value: 'link' });
    expect(again).toHaveLength(2);
  });

  it('treats during as the whole day, replacing before and after', () => {
    const ranged = applyChip(
      applyChip([], { kind: 'after', day: '2026-09-01' }),
      { kind: 'before', day: '2026-09-03' },
    );
    const during = applyChip(ranged, { kind: 'during', day: '2026-09-02' });
    expect(during).toEqual([{ kind: 'during', day: '2026-09-02' }]);
  });
});

describe('toGuildSearchParams', () => {
  it('maps every chip kind to its query parameter', () => {
    const params = toGuildSearchParams([
      { kind: 'from', userId: '1', label: 'Yara' },
      { kind: 'in', channelId: 'c-design', label: 'design' },
      { kind: 'has', value: 'link' },
      { kind: 'has', value: 'image' },
      { kind: 'mentions', userId: '3', label: 'Mira' },
      { kind: 'pinned' },
    ], '  postgres  ');
    expect(params).toEqual({
      q: 'postgres',
      author_id: '1',
      channel_id: 'c-design',
      has: ['link', 'image'],
      mentions: '3',
      pinned: true,
    });
  });

  it('sends days as local-day instants: before and after leave the day out', () => {
    const startOf = (day: number) => new Date(2026, 8, day, 0, 0, 0, 0).getTime();
    const endOf = (day: number) => new Date(2026, 8, day, 23, 59, 59, 999).getTime();

    const during = toGuildSearchParams([{ kind: 'during', day: '2026-09-02' }], '');
    expect(Date.parse(during.after!)).toBe(startOf(2));
    expect(Date.parse(during.before!)).toBe(endOf(2));

    const before = toGuildSearchParams([{ kind: 'before', day: '2026-09-02' }], '');
    expect(Date.parse(before.before!)).toBe(startOf(2) - 1);
    expect(before.after).toBeUndefined();

    const after = toGuildSearchParams([{ kind: 'after', day: '2026-09-02' }], '');
    expect(Date.parse(after.after!)).toBe(endOf(2) + 1);
    expect(after.before).toBeUndefined();
  });

  it('sends nothing for an empty draft', () => {
    expect(toGuildSearchParams([], '   ')).toEqual({});
  });
});

describe('searchLoadedMessages', () => {
  const messages = [
    {
      id: 'a',
      content: 'see https://example.com',
      created_at: '2026-09-21T10:00:00',
      author: { id: '3' },
      pinned: true,
    },
    {
      id: 'b',
      content: 'hello <@1>',
      created_at: '2026-09-22T10:00:00',
      author: { id: '1' },
      attachments: [{ content_type: 'image/png' }],
    },
    {
      id: 'c',
      content: 'notes',
      created_at: '2026-09-01T10:00:00',
      author: { id: '1' },
      embeds: [{}],
    },
  ];

  it('filters loaded messages and returns the newest first', () => {
    const hits = searchLoadedMessages(messages, [{ kind: 'from', userId: '1', label: 'Yara' }], '');
    expect(hits.map((message) => message.id)).toEqual(['b', 'c']);
    const pinned = searchLoadedMessages(messages, [{ kind: 'pinned' }], 'example');
    expect(pinned.map((message) => message.id)).toEqual(['a']);
    const image = searchLoadedMessages(messages, [{ kind: 'has', value: 'image' }], '');
    expect(image.map((message) => message.id)).toEqual(['b']);
    const day = searchLoadedMessages(messages, [{ kind: 'during', day: '2026-09-01' }], '');
    expect(day.map((message) => message.id)).toEqual(['c']);
    const mention = searchLoadedMessages(messages, [{ kind: 'mentions', userId: '1', label: 'Yara' }], '');
    expect(mention.map((message) => message.id)).toEqual(['b']);
  });
});
