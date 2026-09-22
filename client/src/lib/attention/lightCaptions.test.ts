import { describe, expect, it } from 'vitest';

import {
  buildingCaption,
  callDuration,
  darkRoomCaption,
  hereNowCaption,
  lastLitCaption,
  lightsOnOverflowCaption,
  litMembersCaption,
  nameList,
  quietTextCaption,
  readingCaption,
  talkingCaption,
} from './lightCaptions';

/**
 * The captions ARE the accessibility story (spec §9) and the anti-slop copy
 * rule (§6.9). A change here changes what a screen reader hears, so every
 * string is pinned.
 */
describe('light captions', () => {
  it('counts who is talking and who is here, in plain words', () => {
    expect(talkingCaption(3)).toBe('3 talking');
    expect(talkingCaption(1)).toBe('1 talking');
    expect(readingCaption(5)).toBe('5 here');
  });

  it('spells an empty voice channel the way each surface spells it', () => {
    expect(darkRoomCaption('row')).toBe('Empty');
    expect(darkRoomCaption('card')).toBe('Nobody in voice');
    expect(darkRoomCaption()).toBe('Empty');
    expect(quietTextCaption()).toBe('Nobody here');
  });

  it('never says "No data" or the light metaphor', () => {
    const strings = [
      talkingCaption(0),
      readingCaption(0),
      darkRoomCaption('card'),
      darkRoomCaption('row'),
      quietTextCaption(),
      buildingCaption(0, 0),
      lastLitCaption(null, 0),
      hereNowCaption(1, 2),
      lightsOnOverflowCaption(3),
      litMembersCaption(4),
    ];
    for (const value of strings) {
      expect(value).not.toMatch(/no data|it's quiet|lights? on|reading|\blit\b|dark/i);
    }
  });

  it('ages "last active" through minutes, hours and days', () => {
    const now = 10 * 24 * 60 * 60_000;
    expect(lastLitCaption(now - 5_000, now)).toBe('last active just now');
    expect(lastLitCaption(now - 40 * 60_000, now)).toBe('last active 40 min ago');
    expect(lastLitCaption(now - 2 * 3_600_000, now)).toBe('last active 2 h ago');
    expect(lastLitCaption(now - 3 * 86_400_000, now)).toBe('last active 3 d ago');
  });

  it('says "no calls yet" rather than inventing an hour', () => {
    expect(lastLitCaption(null, 1_000)).toBe('no calls yet');
  });

  it('builds the server caption from who is in voice and who is here', () => {
    expect(buildingCaption(4, 3)).toBe('4 in voice · 3 here');
    expect(buildingCaption(1, 0)).toBe('1 in voice');
    expect(buildingCaption(0, 1)).toBe('1 here');
    expect(buildingCaption(0, 0)).toBe('Nobody in voice');
  });

  it('writes the here-now and online lines', () => {
    expect(hereNowCaption(4, 20)).toBe('4 here · 20 online');
    expect(lightsOnOverflowCaption(17)).toBe('+17 online');
    expect(litMembersCaption(24)).toBe('24 online');
  });

  it('formats a duration with tabular-safe two-digit seconds', () => {
    expect(callDuration(34 * 60_000 + 12_000)).toBe('34:12');
    expect(callDuration(3_600_000 + 2 * 60_000 + 11_000)).toBe('1:02:11');
    expect(callDuration(9_000)).toBe('0:09');
    expect(callDuration(null)).toBe('0:00');
    expect(callDuration(-5)).toBe('0:00');
  });

  it('lists names, then counts the rest', () => {
    expect(nameList(['Mara'])).toBe('Mara');
    expect(nameList(['Mara', 'Priya'])).toBe('Mara and Priya');
    expect(nameList(['Mara', 'Priya', 'Ren'])).toBe('Mara, Priya and Ren');
    expect(nameList(['Mara', 'Priya', 'Ren', 'Tomas', 'Aisha'])).toBe('Mara, Priya and 3 others');
    expect(nameList(['Mara', 'Priya', 'Ren', 'Tomas'], 3)).toBe('Mara, Priya and 2 others');
    expect(nameList([])).toBe('');
  });
});
