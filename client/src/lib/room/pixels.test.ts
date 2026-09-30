import { describe, expect, it } from 'vitest';
import {
  analyzeSample,
  blurGrid,
  boxDownsample,
  gaussianKernel,
  gradeGrid,
  ROOM_BACKDROP_VALUE_MAX,
  ROOM_GRID_HEIGHT,
  ROOM_GRID_WIDTH,
  ROOM_SAMPLE_HEIGHT,
  ROOM_SAMPLE_WIDTH,
  STILL_GRADE,
  STREAM_GRADE,
  vividAverage,
} from './pixels';
import { insideClampBox, rgbToHsv } from './color';

const W = ROOM_GRID_WIDTH;
const H = ROOM_GRID_HEIGHT;

function solidSample(r: number, g: number, b: number, a = 255, w = ROOM_SAMPLE_WIDTH, h = ROOM_SAMPLE_HEIGHT) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  return data;
}

describe('room pixels', () => {
  it('box-averages a sample down to the 32x18 grid', () => {
    const data = solidSample(0, 0, 0);
    // Left half white.
    for (let y = 0; y < ROOM_SAMPLE_HEIGHT; y += 1) {
      for (let x = 0; x < ROOM_SAMPLE_WIDTH / 2; x += 1) {
        const i = (y * ROOM_SAMPLE_WIDTH + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 255;
      }
    }
    const grid = boxDownsample(data, ROOM_SAMPLE_WIDTH, ROOM_SAMPLE_HEIGHT);
    expect(grid.length).toBe(W * H * 3);
    expect(grid[0]).toBe(255);
    expect(grid[(W - 1) * 3]).toBe(0);
  });

  it('ignores transparent pixels (a logo on nothing averages to the logo)', () => {
    const data = solidSample(200, 40, 40, 0);
    data[0] = 10;
    data[1] = 200;
    data[2] = 10;
    data[3] = 255;
    const grid = boxDownsample(data, ROOM_SAMPLE_WIDTH, ROOM_SAMPLE_HEIGHT);
    expect([grid[0], grid[1], grid[2]]).toEqual([10, 200, 10]);
  });

  it('blurs without changing a flat field, and not at all under reduced transparency', () => {
    const flat = new Float32Array(W * H * 3).fill(100);
    const blurred = blurGrid(flat, W, H, 1.4);
    for (const value of blurred) expect(value).toBeCloseTo(100, 4);
    const spike = new Float32Array(W * H * 3);
    spike[(9 * W + 16) * 3] = 255;
    expect(blurGrid(spike, W, H, 1.4)[(9 * W + 16) * 3]).toBeLessThan(40);
    expect(blurGrid(spike, W, H, 0)[(9 * W + 16) * 3]).toBe(255);
    const kernel = gaussianKernel(1.4);
    expect(kernel.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
  });

  it('grades like saturate() brightness() and never passes 60% white', () => {
    const white = new Float32Array([255, 255, 255]);
    const graded = gradeGrid(white, STILL_GRADE);
    expect(Math.max(...graded)).toBeLessThanOrEqual(ROOM_BACKDROP_VALUE_MAX * 255 + 1e-3);
    const gray = gradeGrid(new Float32Array([100, 100, 100]), STREAM_GRADE);
    // Saturation leaves gray gray; brightness .6 scales it.
    expect(gray[0]).toBeCloseTo(60, 3);
    expect(gray[1]).toBeCloseTo(60, 3);
  });

  it('lets the colorful part of a dark frame decide the color', () => {
    const grid = new Float32Array(W * H * 3).fill(12);
    // One amber lamp in ten percent of the frame.
    for (let cell = 0; cell < (W * H) / 10; cell += 1) {
      grid[cell * 3] = 240;
      grid[cell * 3 + 1] = 150;
      grid[cell * 3 + 2] = 60;
    }
    const hsv = rgbToHsv(vividAverage(grid));
    expect(hsv.h).toBeGreaterThan(20);
    expect(hsv.h).toBeLessThan(40);
    expect(hsv.s).toBeGreaterThan(0.4);
  });

  it('analyzes a sample into a graded grid and a clamped room color', () => {
    const analysis = analyzeSample(solidSample(20, 60, 200), ROOM_SAMPLE_WIDTH, ROOM_SAMPLE_HEIGHT, {
      grade: STREAM_GRADE,
      blurSigma: 1.4,
    });
    expect(analysis.grid.length).toBe(W * H * 3);
    expect(Math.max(...analysis.grid)).toBeLessThanOrEqual(153.001);
    expect(insideClampBox(analysis.color)).toBe(true);
    expect(rgbToHsv(analysis.color).h).toBeGreaterThan(200);
  });
});
