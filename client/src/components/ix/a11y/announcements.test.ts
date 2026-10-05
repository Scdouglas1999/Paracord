import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VoiceState } from '../../../types';
import { announcementsBetween, voiceSnapshot, type AnnouncementContext } from './announcements';
import { ANNOUNCE_GAP_MS, announce, resetAnnouncer, useAnnouncerStore } from './announcer';

const FUEL = 'g-fuel';
const GAME = 'g-game';
const GENERAL = 'c-general';
const LOUNGE = 'c-lounge';

const state = (user: string, guild: string, extra: Partial<VoiceState> = {}): VoiceState => ({
  user_id: user,
  guild_id: guild,
  session_id: `s-${user}`,
  deaf: false,
  mute: false,
  self_deaf: false,
  self_mute: false,
  self_stream: false,
  self_video: false,
  suppress: false,
  ...extra,
});

const NAMES: Record<string, string> = { jeremy: 'Jeremy', vincent: 'Vincent', nick: 'Nick', me: 'Sean' };
const CHANNELS: Record<string, string> = { [GENERAL]: 'General', [LOUNGE]: 'Lounge' };
const GUILDS: Record<string, string> = { [FUEL]: 'Fuel', [GAME]: 'Game Night' };

const context = (over: Partial<AnnouncementContext> = {}): AnnouncementContext => ({
  me: 'me',
  currentGuildId: FUEL,
  callChannelId: null,
  personName: (id) => NAMES[id] ?? null,
  channelName: (id) => CHANNELS[id] ?? null,
  guildName: (id) => GUILDS[id] ?? null,
  ...over,
});

const snap = (rooms: Record<string, VoiceState[]>) => voiceSnapshot(new Map(Object.entries(rooms)), [FUEL, GAME]);

describe('what the live region says (index-spec §10)', () => {
  it('says nothing on the first snapshot (READY is not an event)', () => {
    expect(announcementsBetween(null, snap({ [GENERAL]: [state('jeremy', FUEL)] }), context())).toEqual([]);
  });

  it('a join in the server you are looking at', () => {
    const before = snap({});
    const after = snap({ [GENERAL]: [state('jeremy', FUEL)] });
    expect(announcementsBetween(before, after, context())).toEqual(['Jeremy joined General']);
  });

  it('a server going live elsewhere, by the dock ping rule; its join is not said', () => {
    const before = snap({});
    const after = snap({ [LOUNGE]: [state('vincent', GAME)] });
    expect(announcementsBetween(before, after, context())).toEqual(['Game Night is live']);
    // Looking at it: no "is live" (no ping either), the join is said instead.
    expect(announcementsBetween(before, after, context({ currentGuildId: GAME }))).toEqual(['Vincent joined Lounge']);
  });

  it('a share starting, in a watched channel', () => {
    const before = snap({ [LOUNGE]: [state('vincent', GAME)] });
    const after = snap({ [LOUNGE]: [state('vincent', GAME, { self_stream: true })] });
    expect(announcementsBetween(before, after, context({ currentGuildId: GAME }))).toEqual(['Vincent started sharing']);
    expect(announcementsBetween(before, after, context())).toEqual([]);
  });

  it('your own call is watched from anywhere, and its leavers are said', () => {
    const before = snap({ [GENERAL]: [state('me', FUEL), state('jeremy', FUEL)] });
    const joined = snap({ [GENERAL]: [state('me', FUEL), state('jeremy', FUEL), state('nick', FUEL)] });
    const left = snap({ [GENERAL]: [state('me', FUEL), state('nick', FUEL)] });
    const elsewhere = context({ currentGuildId: GAME, callChannelId: GENERAL });
    expect(announcementsBetween(before, joined, elsewhere)).toEqual(['Nick joined General']);
    expect(announcementsBetween(joined, left, elsewhere)).toEqual(['Jeremy left General']);
  });

  it('never you, never a listener, and not everyone "leaving" when your call ends', () => {
    const before = snap({ [GENERAL]: [state('jeremy', FUEL)] });
    expect(announcementsBetween(before, snap({ [GENERAL]: [state('jeremy', FUEL), state('me', FUEL)] }), context())).toEqual([]);
    expect(
      announcementsBetween(before, snap({ [GENERAL]: [state('jeremy', FUEL), state('nick', FUEL, { mode: 'listen' })] }), context()),
    ).toEqual([]);
    const inCall = snap({ [GENERAL]: [state('me', FUEL), state('jeremy', FUEL)] });
    expect(announcementsBetween(inCall, snap({ [GENERAL]: [state('jeremy', FUEL)] }), context({ callChannelId: GENERAL }))).toEqual([]);
  });

  it('a listener who joins for real is a join', () => {
    const before = snap({ [GENERAL]: [state('jeremy', FUEL), state('nick', FUEL, { mode: 'listen' })] });
    const after = snap({ [GENERAL]: [state('jeremy', FUEL), state('nick', FUEL)] });
    expect(announcementsBetween(before, after, context())).toEqual(['Nick joined General']);
  });

  it('no name, no sentence', () => {
    const before = snap({});
    const after = snap({ [GENERAL]: [state('stranger', FUEL)] });
    expect(announcementsBetween(before, after, context())).toEqual([]);
  });
});

describe('the announcer: one polite region, at most every 2s', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAnnouncer();
  });
  afterEach(() => {
    resetAnnouncer();
    vi.useRealTimers();
  });

  const text = () => useAnnouncerStore.getState().text.replace(/\u00a0$/, '');

  it('speaks at once after a quiet spell, then holds a burst and says it together', () => {
    announce('Jeremy joined General', 10_000);
    expect(text()).toBe('Jeremy joined General.');
    announce('Nick joined General', 10_500);
    announce('Game Night is live', 10_600);
    expect(text()).toBe('Jeremy joined General.');
    vi.advanceTimersByTime(ANNOUNCE_GAP_MS - 500);
    expect(text()).toBe('Nick joined General. Game Night is live.');
  });

  it('the same words twice are still a change', () => {
    announce('Game Night is live', 0);
    const first = useAnnouncerStore.getState().text;
    vi.advanceTimersByTime(ANNOUNCE_GAP_MS);
    announce('Game Night is live', ANNOUNCE_GAP_MS * 2);
    expect(useAnnouncerStore.getState().text).not.toBe(first);
    expect(text()).toBe('Game Night is live.');
  });
});
