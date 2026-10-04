import { describe, expect, it } from 'vitest';

import type { ConversationEntry } from '../../../lib/attention/conversationModel';
import {
  cappedCount,
  dockAttention,
  dockLabel,
  liveGuildIds,
  nthServer,
  pingEdges,
  placeKeyAction,
  rovingTarget,
  stepPlace,
  type DockEntry,
  type LiveSnapshot,
} from './dockModel';

const scope = { serverId: '__local__', userId: 'me' };

function entry(overrides: Partial<ConversationEntry>): ConversationEntry {
  return {
    key: `k${Math.random()}`,
    scope,
    serverId: '__local__',
    channelId: 'c',
    guildId: 'g1',
    kind: 'guild_text',
    title: 'general',
    contextLabel: 'Fuel',
    lastActivityId: null,
    unread: false,
    mentionCount: 0,
    isDMUnread: false,
    isThreadReply: false,
    hasVoiceActivity: false,
    pinned: false,
    ...overrides,
  };
}

function dock(overrides: Partial<DockEntry> = {}): DockEntry {
  return {
    key: 'g1',
    kind: 'server',
    name: 'Game Night',
    live: false,
    icon: null,
    hue: null,
    unread: false,
    mentions: 0,
    requests: 0,
    dmMentions: 0,
    ...overrides,
  };
}

describe('liveGuildIds (§4.8: an amber dot when any room has people)', () => {
  it('lights the server a voice state names, whatever channel it is in', () => {
    const states = new Map([
      ['ch-a', [{ guild_id: 'g1' }, { guild_id: 'g1' }]],
      ['ch-b', [{ guild_id: 'g2' }]],
      ['ch-empty', []],
    ]);
    expect([...liveGuildIds(states)].sort()).toEqual(['g1', 'g2']);
  });

  it('does not light a server for a direct message call (no guild_id) or an empty room', () => {
    const states = new Map<string, Array<{ guild_id?: string }>>([
      ['dm-call', [{}]],
      ['ch-empty', []],
    ]);
    expect(liveGuildIds(states).size).toBe(0);
  });
});

describe('dockAttention (§4.8: a white dot for unread, a white count for mentions)', () => {
  it('marks a server unread when any of its channels is, and adds up its mentions', () => {
    const { guilds } = dockAttention(
      [
        entry({ guildId: 'g1', unread: true }),
        entry({ guildId: 'g1', mentionCount: 2 }),
        entry({ guildId: 'g1', mentionCount: 1, unread: true }),
        entry({ guildId: 'g2', unread: false }),
      ],
      0,
    );
    expect(guilds.get('g1')).toEqual({ unread: true, mentions: 3 });
    expect(guilds.has('g2')).toBe(false);
  });

  it('counts a thread reply as unread', () => {
    const { guilds } = dockAttention([entry({ guildId: 'g1', kind: 'thread', isThreadReply: true })], 0);
    expect(guilds.get('g1')).toEqual({ unread: true, mentions: 0 });
  });

  it('shows a muted channel as nothing, because the model hands one no signals', () => {
    // useUnifiedConversations zeroes unread and mentions for a muted server or channel.
    const { guilds } = dockAttention([entry({ guildId: 'g1', unread: false, mentionCount: 0 })], 0);
    expect(guilds.size).toBe(0);
  });

  it('gives People unread direct messages as a dot and requests plus DM mentions as the count', () => {
    const dms = [
      entry({ guildId: null, kind: 'dm', isDMUnread: true }),
      entry({ guildId: null, kind: 'group_dm', mentionCount: 2 }),
    ];
    const { people } = dockAttention(dms, 3);
    expect(people).toEqual({ unread: true, mentions: 5, requests: 3, dmMentions: 2 });
    expect(dockAttention([entry({ guildId: null, kind: 'dm', isDMUnread: true })], 0).people).toEqual({
      unread: true,
      mentions: 0,
      requests: 0,
      dmMentions: 0,
    });
    expect(dockAttention([], 0).people.unread).toBe(false);
  });

  it('keeps servers and People apart', () => {
    const { guilds, people } = dockAttention([entry({ guildId: 'g1', unread: true }), entry({ guildId: null, kind: 'dm' })], 0);
    expect(guilds.get('g1')?.unread).toBe(true);
    expect(people.unread).toBe(false);
  });
});

describe('cappedCount', () => {
  it('stops at 99+', () => {
    expect(cappedCount(7)).toBe('7');
    expect(cappedCount(99)).toBe('99');
    expect(cappedCount(100)).toBe('99+');
  });
});

describe('dockLabel (§10: state lives in names)', () => {
  it('says the name, then live, then what is waiting', () => {
    expect(dockLabel(dock(), false)).toBe('Game Night');
    expect(dockLabel(dock({ live: true }), false)).toBe('Game Night, live');
    expect(dockLabel(dock({ live: true, unread: true }), false)).toBe('Game Night, live, unread');
    expect(dockLabel(dock({ unread: true, mentions: 2 }), false)).toBe('Game Night, 2 mentions');
    expect(dockLabel(dock({ mentions: 1 }), false)).toBe('Game Night, 1 mention');
  });

  it('keeps the current place to its name and live: its own rows carry the rest', () => {
    expect(dockLabel(dock({ live: true, unread: true, mentions: 4 }), true)).toBe('Game Night, live');
  });

  it('names what is waiting in People', () => {
    const people = dock({ key: 'people', kind: 'people', name: 'People' });
    expect(dockLabel({ ...people, requests: 1, mentions: 1 }, false)).toBe('People, 1 friend request');
    expect(dockLabel({ ...people, requests: 2, dmMentions: 3, mentions: 5 }, false)).toBe('People, 2 friend requests, 3 mentions');
    expect(dockLabel({ ...people, unread: true }, false)).toBe('People, unread');
  });
});

describe('pingEdges (§5.5: once per not-live to live edge, never for the place you are in)', () => {
  const snap = (live: string[], known: string[]): LiveSnapshot => ({ live: new Set(live), known: new Set(known) });

  it('pings a server that went from not live to live', () => {
    expect(pingEdges(snap([], ['a', 'b']), snap(['b'], ['a', 'b']), 'a')).toEqual(['b']);
  });

  it('never pings the current place', () => {
    expect(pingEdges(snap([], ['a', 'b']), snap(['a'], ['a', 'b']), 'a')).toEqual([]);
  });

  it('does not ping one that was already live', () => {
    expect(pingEdges(snap(['b'], ['a', 'b']), snap(['b'], ['a', 'b']), 'a')).toEqual([]);
  });

  it('does not ping on first sight: nothing before, or a server that was not in the dock', () => {
    expect(pingEdges(null, snap(['b'], ['a', 'b']), 'a')).toEqual([]);
    expect(pingEdges(snap([], ['a']), snap(['b'], ['a', 'b']), 'a')).toEqual([]);
  });

  it('pings again after it went dark and live again, and each server on its own', () => {
    const dark = snap([], ['a', 'b', 'c']);
    expect(pingEdges(dark, snap(['b', 'c'], ['a', 'b', 'c']), 'a').sort()).toEqual(['b', 'c']);
    expect(pingEdges(snap(['b'], ['a', 'b', 'c']), dark, 'a')).toEqual([]);
    expect(pingEdges(dark, snap(['b'], ['a', 'b', 'c']), 'a')).toEqual(['b']);
  });

  it('leaves the current place alone even when no place is current', () => {
    expect(pingEdges(snap([], ['a']), snap(['a'], ['a']), null)).toEqual(['a']);
  });
});

describe('stepPlace (Ctrl+Alt+Up/Down)', () => {
  const order = ['people', 'fuel', 'game', 'base'];

  it('steps through People and the servers, wrapping at both ends', () => {
    expect(stepPlace(order, 'people', 1)).toBe('fuel');
    expect(stepPlace(order, 'fuel', 1)).toBe('game');
    expect(stepPlace(order, 'base', 1)).toBe('people');
    expect(stepPlace(order, 'people', -1)).toBe('base');
    expect(stepPlace(order, 'game', -1)).toBe('fuel');
  });

  it('starts from an end when the current place is not in the dock', () => {
    expect(stepPlace(order, 'gone', 1)).toBe('people');
    expect(stepPlace(order, 'gone', -1)).toBe('base');
    expect(stepPlace(order, null, 1)).toBe('people');
  });

  it('has nowhere to go with an empty dock', () => {
    expect(stepPlace([], 'x', 1)).toBeNull();
  });
});

describe('nthServer (Ctrl+1…9)', () => {
  const order = ['people', 'fuel', 'game', 'base'];

  it('numbers the servers from 1 and never People', () => {
    expect(nthServer(order, 1)).toBe('fuel');
    expect(nthServer(order, 3)).toBe('base');
    expect(nthServer(order, 4)).toBeNull();
    expect(nthServer(['people'], 1)).toBeNull();
  });
});

describe('placeKeyAction', () => {
  const key = (init: Partial<Parameters<typeof placeKeyAction>[0]>) =>
    ({ key: '', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...init }) as Parameters<typeof placeKeyAction>[0];

  it('Ctrl+Alt+Up/Down step (⌥⌘↑/↓ on macOS)', () => {
    expect(placeKeyAction(key({ key: 'ArrowUp', ctrlKey: true, altKey: true }), false)).toEqual({ kind: 'step', delta: -1 });
    expect(placeKeyAction(key({ key: 'ArrowDown', ctrlKey: true, altKey: true }), false)).toEqual({ kind: 'step', delta: 1 });
    expect(placeKeyAction(key({ key: 'ArrowDown', metaKey: true, altKey: true }), true)).toEqual({ kind: 'step', delta: 1 });
    // Alt+Up is the channels' own shortcut; Ctrl+Up alone is nothing.
    expect(placeKeyAction(key({ key: 'ArrowUp', altKey: true }), false)).toBeNull();
    expect(placeKeyAction(key({ key: 'ArrowUp', ctrlKey: true }), false)).toBeNull();
  });

  it('Ctrl+1…9 (⌘1…9) jump, read from the physical key', () => {
    expect(placeKeyAction(key({ key: '1', code: 'Digit1', ctrlKey: true }), false)).toEqual({ kind: 'nth', n: 1 });
    expect(placeKeyAction(key({ key: '9', ctrlKey: true }), false)).toEqual({ kind: 'nth', n: 9 });
    // A French layout types "&" for the 1 key.
    expect(placeKeyAction(key({ key: '&', code: 'Digit1', ctrlKey: true }), false)).toEqual({ kind: 'nth', n: 1 });
    expect(placeKeyAction(key({ key: '4', code: 'Numpad4', ctrlKey: true }), false)).toEqual({ kind: 'nth', n: 4 });
    expect(placeKeyAction(key({ key: '3', code: 'Digit3', metaKey: true }), true)).toEqual({ kind: 'nth', n: 3 });
  });

  it('is not 0, not with other modifiers, and not the wrong modifier for the platform', () => {
    expect(placeKeyAction(key({ key: '0', code: 'Digit0', ctrlKey: true }), false)).toBeNull();
    expect(placeKeyAction(key({ key: '1', code: 'Digit1', ctrlKey: true, shiftKey: true }), false)).toBeNull();
    expect(placeKeyAction(key({ key: '1', code: 'Digit1', ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(placeKeyAction(key({ key: '1', code: 'Digit1' }), false)).toBeNull();
    expect(placeKeyAction(key({ key: '1', code: 'Digit1', metaKey: true }), false)).toBeNull();
    expect(placeKeyAction(key({ key: '1', code: 'Digit1', ctrlKey: true }), true)).toBeNull();
  });
});

describe('rovingTarget (a toolbar: Left and Right wrap, Home and End)', () => {
  it('moves one step, wrapping, and to the ends', () => {
    expect(rovingTarget(5, 2, 'ArrowRight')).toBe(3);
    expect(rovingTarget(5, 4, 'ArrowRight')).toBe(0);
    expect(rovingTarget(5, 0, 'ArrowLeft')).toBe(4);
    expect(rovingTarget(5, 3, 'ArrowLeft')).toBe(2);
    expect(rovingTarget(5, 2, 'Home')).toBe(0);
    expect(rovingTarget(5, 2, 'End')).toBe(4);
  });

  it('starts from the first when nothing in it has focus, and ignores other keys', () => {
    expect(rovingTarget(3, -1, 'ArrowRight')).toBe(0);
    expect(rovingTarget(3, -1, 'ArrowLeft')).toBe(2);
    expect(rovingTarget(3, 1, 'ArrowUp')).toBeNull();
    expect(rovingTarget(3, 1, 'Enter')).toBeNull();
    expect(rovingTarget(0, 0, 'Home')).toBeNull();
  });
});
