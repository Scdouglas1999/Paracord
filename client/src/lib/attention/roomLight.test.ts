import { describe, expect, it } from 'vitest';

import { EPOCH_MS } from './conversationModel';
import { personLight } from './personLight';
import {
  READING_WINDOW_MS,
  liveLabel,
  readersOf,
  textRoomLight,
  voiceRoomCaption,
  voiceRoomLight,
} from './roomLight';

const SCOPE = { serverId: 'a', userId: 'viewer' };
const NOW = EPOCH_MS + 10 * 24 * 3_600_000;

function snowflakeAt(ms: number): string {
  return String((BigInt(ms) - BigInt(EPOCH_MS)) << 22n);
}

function who(userId: string, name: string, status = 'online') {
  return personLight({ userId, name, status });
}

const MARA = who('1', 'Mara');
const PRIYA = who('2', 'Priya');
const REN = who('3', 'Ren');
const AWAY = who('4', 'Devon', 'idle');
const GONE = who('5', 'Sasha', 'offline');
const CANDIDATES = [MARA, PRIYA, REN, AWAY, GONE];

function text(over: Partial<Parameters<typeof textRoomLight>[0]> = {}) {
  return textRoomLight({
    scope: SCOPE,
    guildId: 'g1',
    channelId: 'c1',
    name: 'build-log',
    candidates: CANDIDATES,
    nowMs: NOW,
    ...over,
  });
}

/**
 * The reading definition is the contract (see the docstring at the top of
 * `roomLight.ts`). These tests are what stops a later package from quietly
 * widening it into "everybody who is online".
 */
describe('who is reading a text room', () => {
  it('never counts presence alone — a lit person in no room reads nothing', () => {
    expect(text().readers).toHaveLength(0);
    expect(text().level).toBe('dark');
    expect(text().caption).toBe('Dark · nobody in');
  });

  it('counts somebody typing in the room', () => {
    const room = text({ typingUserIds: ['1'] });
    expect(room.readers.map((r) => r.person.userId)).toEqual(['1']);
    expect(room.readers[0].reason).toBe('typing');
    expect(room.level).toBe('amber');
    expect(room.caption).toBe('1 reading');
  });

  it('counts somebody who posted inside the reading window', () => {
    const room = text({
      recentAuthors: [{ authorId: '2', messageId: snowflakeAt(NOW - 60_000) }],
    });
    expect(room.readers.map((r) => r.person.userId)).toEqual(['2']);
    expect(room.readers[0].reason).toBe('authored');
  });

  it('stops counting an author once the window has passed', () => {
    const room = text({
      recentAuthors: [
        { authorId: '2', messageId: snowflakeAt(NOW - READING_WINDOW_MS - 1_000) },
      ],
    });
    expect(room.readers).toHaveLength(0);
  });

  it('counts the local account only when this client is actually looking', () => {
    expect(text({ selfUserId: '3', selfIsViewing: true }).readers.map((r) => r.reason)).toEqual([
      'viewing',
    ]);
    expect(text({ selfUserId: '3', selfIsViewing: false }).readers).toHaveLength(0);
  });

  it('refuses to light a person whose lights are off, whatever the signal', () => {
    expect(text({ typingUserIds: ['4'] }).readers).toHaveLength(0); // away
    expect(text({ typingUserIds: ['5'] }).readers).toHaveLength(0); // offline
    expect(
      text({ recentAuthors: [{ authorId: '4', messageId: snowflakeAt(NOW - 1_000) }] }).readers,
    ).toHaveLength(0);
  });

  it('ignores an unknown user id and a malformed snowflake', () => {
    expect(text({ typingUserIds: ['999'] }).readers).toHaveLength(0);
    expect(text({ recentAuthors: [{ authorId: '1', messageId: 'not-a-snowflake' }] }).readers)
      .toHaveLength(0);
  });

  it('reports the strongest signal per person and orders by it', () => {
    const readers = readersOf({
      scope: SCOPE,
      guildId: 'g1',
      channelId: 'c1',
      name: 'build-log',
      candidates: CANDIDATES,
      typingUserIds: ['2'],
      recentAuthors: [
        { authorId: '1', messageId: snowflakeAt(NOW - 1_000) },
        { authorId: '2', messageId: snowflakeAt(NOW - 1_000) },
      ],
      nowMs: NOW,
    });
    expect(readers.map((r) => [r.person.userId, r.reason])).toEqual([
      ['2', 'typing'],
      ['1', 'authored'],
    ]);
  });

  it('remembers when it was last lit, and keeps the previous value while dark', () => {
    expect(text({ typingUserIds: ['1'] }).lastLitMs).toBe(NOW);
    expect(text({ lastLitMs: NOW - 7_200_000 }).lastLitMs).toBe(NOW - 7_200_000);
  });
});

describe('voice room light', () => {
  function voice(over: Partial<Parameters<typeof voiceRoomLight>[0]> = {}) {
    return voiceRoomLight({
      scope: SCOPE,
      guildId: 'g1',
      channelId: 'v1',
      name: 'Shop floor',
      occupants: [],
      nowMs: NOW,
      ...over,
    });
  }

  it('is dark with nobody in it, and says so', () => {
    const room = voice();
    expect(room.level).toBe('dark');
    expect(room.caption).toBe('Dark · nobody in');
    expect(room.durationMs).toBeNull();
    expect(room.thumbnail).toMatchObject({ live: false, reason: 'no-publisher' });
  });

  it('is white light the moment somebody is in it', () => {
    const room = voice({ occupants: [{ person: MARA }] });
    expect(room.level).toBe('white');
    expect(room.lit).toBe(true);
    expect(room.caption).toBe('1 in');
  });

  it('orders speakers first, then sharers, then by name', () => {
    const room = voice({
      occupants: [
        { person: REN },
        { person: MARA, sharingScreen: true },
        { person: PRIYA, speaking: true },
      ],
    });
    expect(room.occupants.map((o) => o.person.name)).toEqual(['Priya', 'Mara', 'Ren']);
    expect(room.talkingCount).toBe(1);
    expect(room.screenSharer?.person.name).toBe('Mara');
    expect(room.caption).toBe('1 talking');
  });

  it('says "you\'re here" when the local account is in the room', () => {
    const room = voice({ occupants: [{ person: MARA }], selfUserId: '1' });
    expect(room.youAreHere).toBe(true);
    expect(room.caption).toBe("you're here");
  });

  it('counts a duration only from a start this client actually observed', () => {
    expect(voice({ occupants: [{ person: MARA }] }).durationMs).toBeNull();
    expect(
      voice({ occupants: [{ person: MARA }], startedAtMs: NOW - 34 * 60_000 }).durationMs,
    ).toBe(34 * 60_000);
  });

  it('labels a live room by what it is showing', () => {
    expect(liveLabel(null, null)).toBe('LIVE');
    expect(liveLabel({ person: MARA } as never, null)).toBe('LIVE · Mara is sharing a screen');
    expect(liveLabel(null, { person: PRIYA } as never)).toBe('LIVE · Priya is on camera');
  });

  it('defaults an unjoined lit room to a still plus the LIVE dot', () => {
    const room = voice({ occupants: [{ person: MARA, sharingScreen: true }] });
    expect(room.thumbnail).toMatchObject({ live: false, reason: 'not-joined' });
    expect(room.thumbnail.label).toBe('LIVE · Mara is sharing a screen');
  });

  it('captions occupancy without inventing a talker', () => {
    expect(voiceRoomCaption(0, 0, false)).toBe('Dark · nobody in');
    expect(voiceRoomCaption(2, 0, false)).toBe('2 in');
    expect(voiceRoomCaption(2, 3, true)).toBe("you're here");
  });
});
