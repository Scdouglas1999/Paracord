import { describe, expect, it } from 'vitest';
import {
  channelDistance,
  clampRoomColor,
  easeFactor,
  formatRoomRgb,
  hsvToRgb,
  insideClampBox,
  ROOM_CLAMP,
  ROOM_NEUTRAL,
  roomColorFromAverage,
  rgbToHsv,
  type Rgb,
} from './color';

describe('room color', () => {
  it('round-trips HSV', () => {
    for (const rgb of [[222, 109, 35], [80, 158, 255], [0, 0, 0], [255, 255, 255], [12, 200, 90]] as Rgb[]) {
      const back = hsvToRgb(rgbToHsv(rgb));
      expect(channelDistance(back, rgb)).toBeLessThan(0.001);
    }
  });

  it('keeps both reference samples and the neutral room inside the clamp box', () => {
    expect(insideClampBox([222, 109, 35])).toBe(true);
    expect(insideClampBox([80, 158, 255])).toBe(true);
    expect(insideClampBox(ROOM_NEUTRAL)).toBe(true);
    expect(rgbToHsv(ROOM_NEUTRAL).s).toBe(0);
  });

  it('never lets any frame average out of the box', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let i = 0; i < 5000; i += 1) {
      const average: Rgb = [random() * 255, random() * 255, random() * 255];
      const room = roomColorFromAverage(average);
      expect(insideClampBox(room), `${average.join(',')} -> ${room.join(',')}`).toBe(true);
    }
    for (const extreme of [[0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 0, 255], [3, 1, 0]] as Rgb[]) {
      expect(insideClampBox(roomColorFromAverage(extreme))).toBe(true);
      expect(insideClampBox(clampRoomColor(extreme))).toBe(true);
    }
  });

  it('keeps the hue and brings a muddy average back to a readable tint', () => {
    // A dark, warm cave: the average is barely colored.
    const room = roomColorFromAverage([48, 36, 28]);
    const hsv = rgbToHsv(room);
    expect(hsv.h).toBeGreaterThan(15);
    expect(hsv.h).toBeLessThan(35);
    expect(hsv.s).toBeGreaterThan(0.6);
    expect(hsv.v).toBeGreaterThanOrEqual(ROOM_CLAMP.valueMin - 0.001);
  });

  it('leaves gray gray', () => {
    const hsv = rgbToHsv(roomColorFromAverage([90, 90, 90]));
    expect(hsv.s).toBeLessThan(0.001);
  });

  it('eases within one to two seconds', () => {
    // 95% of the way after 1.8 s of 250 ms steps.
    let remaining = 1;
    for (let t = 0; t < 1800; t += 250) remaining *= 1 - easeFactor(250, 600);
    expect(remaining).toBeLessThan(0.06);
    expect(easeFactor(250, 0)).toBe(1);
  });

  it('formats channel numbers, never an rgb() string', () => {
    expect(formatRoomRgb([222.4, 108.6, 35])).toBe('222, 109, 35');
  });
});
