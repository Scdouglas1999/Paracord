import { afterEach, describe, expect, it } from 'vitest';
import { createManualClock } from './testClock';
import {
  createRoomTokenWriter,
  ROOM_TOKEN_DEADBAND,
  ROOM_TOKEN_MAX_HZ,
  ROOM_TOKEN_PROPERTY,
} from './tokenWriter';

function watchStyle(element: HTMLElement) {
  const writes: string[] = [];
  const original = element.style.setProperty.bind(element.style);
  element.style.setProperty = (property: string, value: string | null, priority?: string) => {
    writes.push(`${property}=${value}`);
    original(property, value, priority);
  };
  return writes;
}

describe('room token writer (the budget)', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('style');
  });

  it(`writes --room-rgb at most ${ROOM_TOKEN_MAX_HZ} times a second however often it is offered a color`, () => {
    const clock = createManualClock();
    const element = document.createElement('div');
    const writes = watchStyle(element);
    const writer = createRoomTokenWriter(element, clock);
    // 60 offers a second for 10 seconds, every one a different, far-apart color.
    for (let frame = 0; frame < 600; frame += 1) {
      const t = frame / 60;
      writer.offer([128 + 120 * Math.sin(t * 7), 128 + 120 * Math.cos(t * 5), (frame * 37) % 256]);
      clock.advance(1000 / 60);
    }
    clock.advance(1000);
    expect(writes.length).toBeLessThanOrEqual(10 * ROOM_TOKEN_MAX_HZ + 1);
    expect(writes.length).toBeGreaterThan(20);
    // Only the one property, only channel numbers.
    for (const write of writes) expect(write).toMatch(/^--room-rgb=\d{1,3}, \d{1,3}, \d{1,3}$/);
    // Any one second holds at most four writes.
    expect(writer.writes).toBe(writes.length);
  });

  it('spaces writes at least 250 ms apart and ends on the latest color', () => {
    const clock = createManualClock();
    const element = document.createElement('div');
    const times: number[] = [];
    const original = element.style.setProperty.bind(element.style);
    element.style.setProperty = (property: string, value: string | null) => {
      times.push(clock.now());
      original(property, value);
    };
    const writer = createRoomTokenWriter(element, clock);
    writer.offer([10, 10, 10]);
    writer.offer([50, 50, 50]);
    writer.offer([90, 90, 90]);
    clock.advance(300);
    expect(element.style.getPropertyValue(ROOM_TOKEN_PROPERTY)).toBe('90, 90, 90');
    for (let i = 1; i < times.length; i += 1) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(250);
  });

  it('skips steps inside the deadband unless the room is settling there', () => {
    const clock = createManualClock();
    const element = document.createElement('div');
    const writer = createRoomTokenWriter(element, clock);
    writer.offer([100, 100, 100]);
    clock.advance(1000);
    writer.offer([100 + ROOM_TOKEN_DEADBAND - 1, 100, 100]);
    clock.advance(1000);
    expect(writer.writes).toBe(1);
    writer.offer([100 + ROOM_TOKEN_DEADBAND - 1, 100, 100], true);
    clock.advance(1000);
    expect(writer.writes).toBe(2);
    expect(element.style.getPropertyValue(ROOM_TOKEN_PROPERTY)).toBe(`${100 + ROOM_TOKEN_DEADBAND - 1}, 100, 100`);
    // The same value again writes nothing.
    writer.offer([100 + ROOM_TOKEN_DEADBAND - 1, 100, 100], true);
    clock.advance(1000);
    expect(writer.writes).toBe(2);
  });

  it('never registers or animates the property and writes nothing after dispose', () => {
    const clock = createManualClock();
    const element = document.createElement('div');
    const writer = createRoomTokenWriter(element, clock);
    writer.offer([1, 2, 3]);
    writer.offer([200, 2, 3]);
    writer.dispose();
    clock.advance(1000);
    expect(writer.writes).toBe(1);
    expect(element.getAttribute('style')).toBe('--room-rgb: 1, 2, 3;');
  });
});
