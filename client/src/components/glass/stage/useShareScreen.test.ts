import { describe, expect, it } from 'vitest';

import { SHARE_QUALITIES, shareQualitySameAs } from './useShareScreen';

/**
 * The share menu's "Same as …" note mirrors `resolve_screen_preset` in
 * paracord-codec: a preset that sends the same picture (size and frame rate)
 * as a smaller one on a screen is that one there.
 */
describe('shareQualitySameAs', () => {
  it('a 1440-line 32:9 screen: 4K is 1440p', () => {
    expect(shareQualitySameAs('4k60', 5120, 1440)).toBe('1440p');
    expect(shareQualitySameAs('1440p60', 5120, 1440)).toBeNull();
    expect(shareQualitySameAs('1080p60', 5120, 1440)).toBeNull();
    expect(shareQualitySameAs('720p30', 5120, 1440)).toBeNull();
  });

  it('a 1080p screen: 1440p and 4K are 1080p; 720p30 stays its own (30 fps)', () => {
    expect(shareQualitySameAs('1440p60', 1920, 1080)).toBe('1080p');
    expect(shareQualitySameAs('4k60', 1920, 1080)).toBe('1080p');
    expect(shareQualitySameAs('720p30', 1920, 1080)).toBeNull();
  });

  it('a 4K screen: every preset is its own', () => {
    for (const option of SHARE_QUALITIES) expect(shareQualitySameAs(option.value, 3840, 2160)).toBeNull();
  });

  it('Movie never stands in for another and keeps its stated bitrate', () => {
    expect(shareQualitySameAs('movie-50', 1920, 1080)).toBeNull();
    expect(shareQualitySameAs('movie-100', 5120, 1440)).toBeNull();
    expect(SHARE_QUALITIES.find((option) => option.value === 'movie-50')?.label).toBe('Movie (up to 50 Mbps)');
    expect(SHARE_QUALITIES.find((option) => option.value === 'movie-100')?.label).toBe('Movie (up to 100 Mbps)');
  });

  it('an unknown size says nothing', () => {
    expect(shareQualitySameAs('4k60', 0, 0)).toBeNull();
  });
});
