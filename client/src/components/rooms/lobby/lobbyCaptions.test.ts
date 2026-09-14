import { describe, expect, it } from 'vitest';

import {
  OPEN_A_NEW_ROOM,
  goingCaption,
  headerLine,
  hostingCaption,
  lastAuthorCaption,
  lightsOnOfCaption,
  mentionCaption,
  nextEventCaption,
  photosThisWeekCaption,
  recentlyInCaption,
  roomsLitCaption,
  speakingCaption,
} from './lobbyCaptions';

/**
 * The Lobby's copy is pinned here, exactly as `lightCaptions.test.ts` pins the
 * light vocabulary: the strings are the contract (docs/lantern-stage-spec.md
 * §6.9, §7.3), and a reviewer reads this file to check them.
 */
describe('the header line', () => {
  it('reads the way §7.3 writes it', () => {
    expect(
      headerLine([
        lightsOnOfCaption(24, 61),
        roomsLitCaption(2),
        nextEventCaption('thermal test', '1 pm'),
      ]),
    ).toBe('24 of 61 have their lights on · 2 calls live · thermal test at 1 pm');
  });

  it('drops a clause rather than printing an empty one', () => {
    expect(headerLine([lightsOnOfCaption(3, 12), roomsLitCaption(0), null])).toBe(
      '3 of 12 have their lights on',
    );
  });

  it('says nobody is here rather than "0 of 61"', () => {
    expect(lightsOnOfCaption(0, 61)).toBe("Nobody's lights are on");
  });

  it('drops the denominator it cannot back', () => {
    // The server has not told us the roll, so "of N" would be a claim we cannot
    // make. Count what we can see instead of inventing the rest.
    expect(lightsOnOfCaption(4, 0)).toBe('4 have their lights on');
    expect(lightsOnOfCaption(1, 1)).toBe('1 has their lights on');
  });

  it('counts rooms in the singular and stays silent when none are lit', () => {
    expect(roomsLitCaption(1)).toBe('1 call live');
    expect(roomsLitCaption(0)).toBe('');
  });

  it('needs both halves of the event clause', () => {
    expect(nextEventCaption('', '1 pm')).toBe('');
    expect(nextEventCaption('thermal test', '')).toBe('');
  });
});

describe('the room cards', () => {
  it('names who is speaking', () => {
    expect(speakingCaption(['Mara'])).toBe('Mara speaking');
    expect(speakingCaption(['Mara', 'Priya'])).toBe('Mara and Priya speaking');
  });

  it('says nothing when nobody is talking, rather than "0 speaking"', () => {
    expect(speakingCaption([])).toBe('');
  });

  it('offers a way to open one more, never a void', () => {
    expect(OPEN_A_NEW_ROOM).toBe('Add a voice channel');
  });
});

describe('coming up', () => {
  it('names the host and counts the going, and drops either when unknown', () => {
    expect(hostingCaption('Priya')).toBe('Priya is hosting');
    expect(hostingCaption(null)).toBe('');
    expect(goingCaption(6)).toBe('6 going');
    expect(goingCaption(0)).toBe('');
  });
});

describe('the media strip', () => {
  it('names the server it is recently inside', () => {
    expect(recentlyInCaption('Kestrel Robotics')).toBe('Recently in Kestrel Robotics');
  });

  it('counts photos in the singular and stays silent at zero', () => {
    expect(photosThisWeekCaption(14)).toBe('14 photos this week');
    expect(photosThisWeekCaption(1)).toBe('1 photo this week');
    expect(photosThisWeekCaption(0)).toBe('');
  });
});

describe('a text room row', () => {
  it('joins the author and the stamp, and survives either being missing', () => {
    expect(lastAuthorCaption('Priya', '10:02')).toBe('Priya · 10:02');
    expect(lastAuthorCaption(null, '10:02')).toBe('10:02');
    expect(lastAuthorCaption('Priya', null)).toBe('Priya');
    expect(lastAuthorCaption(null, null)).toBe('');
  });

  it('counts mentions and stays silent at zero', () => {
    expect(mentionCaption(1)).toBe('1 mention');
    expect(mentionCaption(3)).toBe('3 mentions');
    expect(mentionCaption(0)).toBe('');
  });
});

describe('the kill-list', () => {
  it('never says "No data", "It\'s quiet here" or "Online"', () => {
    const every = [
      lightsOnOfCaption(0, 0),
      lightsOnOfCaption(24, 61),
      roomsLitCaption(0),
      roomsLitCaption(3),
      speakingCaption([]),
          OPEN_A_NEW_ROOM,
      recentlyInCaption(''),
      photosThisWeekCaption(0),
      goingCaption(0),
      hostingCaption(''),
      mentionCaption(0),
    ].join(' | ');
    expect(every).not.toMatch(/No data|It's quiet|Online/i);
  });
});
