import { describe, expect, it } from 'vitest';
import {
  arrangeSwitcher,
  matchRank,
  searchRowLabel,
  SWITCHER_ORDER,
  SWITCHER_ORDER_PEOPLE,
  type SwitcherCandidate,
} from './switcherModel';

/** The quick switcher's order and filtering (docs/index-spec.md §4.2, §6.3). */

const c = (id: string, category: SwitcherCandidate['category'], label: string, extra: Partial<SwitcherCandidate> = {}): SwitcherCandidate => ({
  id,
  category,
  label,
  ...extra,
});

const sample = [
  c('cmd-settings', 'commands', 'User settings', { keywords: 'settings preferences' }),
  c('dm-jeremy', 'dms', 'Jeremy'),
  c('srv-fuel', 'servers', 'Fuel', { sublabel: '5 channels' }),
  c('person-nick', 'people', 'Nick', { sublabel: '@nick' }),
  c('room-lounge', 'rooms', 'Lounge', { sublabel: 'Voice channel' }),
  c('ch-lounge', 'channels', 'lounge'),
  c('ch-lfg', 'channels', 'looking-for-group'),
  c('else-plans', 'elsewhere', 'plans', { sublabel: 'Fuel' }),
];

describe('arrangeSwitcher: the current server first', () => {
  it('orders the groups channels, rooms, people, servers, direct messages, other servers, commands', () => {
    const groups = arrangeSwitcher(sample, 'l');
    const categories = groups.map((group) => group.category);
    expect(categories).toEqual(SWITCHER_ORDER.filter((category) => categories.includes(category)));
    expect(groups.map((group) => group.label)[0]).toBe('Channels');
  });

  it('with nothing typed, shows places only: no people, no commands, no channels from other servers', () => {
    const groups = arrangeSwitcher(sample, '');
    expect(groups.map((group) => group.category)).toEqual(['channels', 'rooms', 'servers', 'dms']);
  });

  it('with words typed, adds people, other servers\' channels and the commands that match, after the places', () => {
    expect(arrangeSwitcher(sample, 'nick').map((group) => group.category)).toEqual(['people']);
    expect(arrangeSwitcher(sample, 'settings').map((group) => group.category)).toEqual(['commands']);
    expect(arrangeSwitcher(sample, 'plans').map((group) => group.category)).toEqual(['elsewhere']);
    // "Fuel" matches the server AND the channel of another server whose sublabel names it.
    expect(arrangeSwitcher(sample, 'fuel').map((group) => group.category)).toEqual(['servers', 'elsewhere']);
  });

  it('ranks a label that starts with the words before one that merely contains them', () => {
    const items = [c('a', 'channels', 'general'), c('b', 'channels', 'lounge'), c('c', 'channels', 'a-long-one')];
    // "lounge" starts with it; "a-long-one" has a word that does; "general" has neither.
    expect(arrangeSwitcher(items, 'lo')[0].items.map((item) => item.id)).toEqual(['b', 'c']);
    const more = [c('x', 'channels', 'xylophone-ng'), c('y', 'channels', 'song'), c('z', 'channels', 'ng-room')];
    expect(arrangeSwitcher(more, 'ng')[0].items.map((item) => item.id)).toEqual(['z', 'x', 'y']);
  });

  it('caps a group, more when nothing is typed for channels', () => {
    const many = Array.from({ length: 20 }, (_, i) => c(`c${i}`, 'channels', `chan-${i}`));
    expect(arrangeSwitcher(many, '')[0].items).toHaveLength(10);
    expect(arrangeSwitcher(many, 'chan')[0].items).toHaveLength(8);
  });
});

describe('arrangeSwitcher: scoped to people (§6.6)', () => {
  it('with nothing typed, lists conversations, then friends, then servers', () => {
    const groups = arrangeSwitcher(sample, '', 'people');
    expect(groups.map((group) => group.category)).toEqual(['dms', 'people', 'servers']);
  });

  it('once something is typed, adds the channels of other servers and the commands after the places', () => {
    const matching = [
      c('dm-neil', 'dms', 'Neil'),
      c('person-nell', 'people', 'Nell'),
      c('srv-nest', 'servers', 'Nest'),
      c('else-news', 'elsewhere', 'news', { sublabel: 'Fuel' }),
      c('cmd-new', 'commands', 'New message'),
    ];
    const categories = arrangeSwitcher(matching, 'ne', 'people').map((group) => group.category);
    expect(categories).toEqual(['dms', 'people', 'servers', 'elsewhere', 'commands']);
    expect(categories).toEqual(SWITCHER_ORDER_PEOPLE.filter((category) => categories.includes(category)));
  });
});

describe('matchRank', () => {
  it('is 0 for a prefix, 1 for a word start, 2 for anywhere in the text, -1 for none', () => {
    const item = c('a', 'channels', 'looking-for-group', { sublabel: 'Game Night' });
    expect(matchRank(item, 'look')).toBe(0);
    expect(matchRank(item, 'group')).toBe(1);
    expect(matchRank(item, 'night')).toBe(2);
    expect(matchRank(item, 'zzz')).toBe(-1);
    expect(matchRank(item, '')).toBe(0);
  });
});

describe('searchRowLabel', () => {
  it('says where, and for what', () => {
    expect(searchRowLabel('Fuel', '')).toBe('Search messages in Fuel');
    expect(searchRowLabel('Fuel', ' run ')).toBe('Search messages in Fuel for “run”');
    expect(searchRowLabel(null, 'run')).toBe('Search messages in this conversation for “run”');
  });
});
