import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_DETECTION_KEY,
  isActivityDetectionOn,
  visibleEmbeds,
  withExplicitActivityOff,
} from './privacyDefaults';

describe('activity sharing default', () => {
  it('is off for anyone who never chose', () => {
    expect(isActivityDetectionOn(undefined)).toBe(false);
    expect(isActivityDetectionOn(null)).toBe(false);
    expect(isActivityDetectionOn({})).toBe(false);
    expect(isActivityDetectionOn({ [ACTIVITY_DETECTION_KEY]: 'yes' })).toBe(false);
  });

  it('stays on for anyone who turned it on, and off when stored false', () => {
    expect(isActivityDetectionOn({ [ACTIVITY_DETECTION_KEY]: true })).toBe(true);
    expect(isActivityDetectionOn({ [ACTIVITY_DETECTION_KEY]: false })).toBe(false);
  });

  it('writes an explicit false over existing notification keys', () => {
    expect(withExplicitActivityOff({ lowBandwidthMode: true })).toEqual({
      lowBandwidthMode: true,
      [ACTIVITY_DETECTION_KEY]: false,
    });
  });
});

describe('visibleEmbeds', () => {
  const embeds = [{ type: 'link', url: 'a' }, { type: 'rich', url: 'b' }, { url: 'c' }];
  it('keeps everything when previews are on', () => {
    expect(visibleEmbeds(embeds, true)).toHaveLength(3);
  });
  it('drops link previews, keeps deliberate embeds, when off', () => {
    expect(visibleEmbeds(embeds, false).map((e) => e.url)).toEqual(['b', 'c']);
    expect(visibleEmbeds(undefined, false)).toEqual([]);
  });
});
