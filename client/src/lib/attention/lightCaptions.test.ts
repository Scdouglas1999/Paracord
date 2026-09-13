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
  readingCaption,
  talkingCaption,
} from './lightCaptions';

/**
 * The captions ARE the accessibility story (spec §9) and the anti-slop copy
 * rule (§6.9). A change here changes what a screen reader hears, so every
 * string is pinned.
 */
describe('light captions', () => {
  it('counts talking and reading in the metaphor', () => {
    expect(talkingCaption(3)).toBe('3 talking');
    expect(talkingCaption(1)).toBe('1 talking');
    expect(readingCaption(5)).toBe('5 reading');
  });

  it('spells a dark room the way each surface spells it', () => {
    expect(darkRoomCaption('row')).toBe('Dark · nobody in');
    expect(darkRoomCaption('card')).toBe("Dark · nobody's in");
    expect(darkRoomCaption()).toBe('Dark · nobody in');
  });

  it('never says "No data" or "Online"', () => {
    const strings = [
      talkingCaption(0),
      readingCaption(0),
      darkRoomCaption('card'),
      buildingCaption(0, 0),
      lastLitCaption(null, 0),
    ];
    for (const value of strings) {
      expect(value).not.toMatch(/no data|it's quiet|^online$/i);
    }
  });

  it('ages "last lit" through minutes, hours and days', () => {
    const now = 10 * 24 * 60 * 60_000;
    expect(lastLitCaption(now - 5_000, now)).toBe('last lit just now');
    expect(lastLitCaption(now - 40 * 60_000, now)).toBe('last lit 40 min ago');
    expect(lastLitCaption(now - 2 * 3_600_000, now)).toBe('last lit 2 h ago');
    expect(lastLitCaption(now - 3 * 86_400_000, now)).toBe('last lit 3 d ago');
  });

  it('says "never lit" rather than inventing an hour', () => {
    expect(lastLitCaption(null, 1_000)).toBe('never lit');
  });

  it('builds the building caption from what is actually lit', () => {
    expect(buildingCaption(2, 3)).toBe('2 rooms lit · 3 reading');
    expect(buildingCaption(1, 0)).toBe('1 room lit');
    expect(buildingCaption(0, 1)).toBe('1 reading');
    expect(buildingCaption(0, 0)).toBe('Dark · nobody in');
  });

  it('writes the here-now and lights-on lines', () => {
    expect(hereNowCaption(4, 20)).toBe('4 here · 20 lights on');
    expect(lightsOnOverflowCaption(17)).toBe('+17 lights on');
    expect(litMembersCaption(24)).toBe('24 in');
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
