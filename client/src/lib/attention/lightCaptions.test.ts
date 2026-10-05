import { describe, expect, it } from 'vitest';

import {
  buildingCaption,
  darkRoomCaption,
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
    ];
    for (const value of strings) {
      expect(value).not.toMatch(/no data|it's quiet|lights? on|reading|\blit\b|dark/i);
    }
  });

  it('builds the server caption from who is in voice and who is here', () => {
    expect(buildingCaption(4, 3)).toBe('4 in voice · 3 here');
    expect(buildingCaption(1, 0)).toBe('1 in voice');
    expect(buildingCaption(0, 1)).toBe('1 here');
    expect(buildingCaption(0, 0)).toBe('Nobody in voice');
  });
});
