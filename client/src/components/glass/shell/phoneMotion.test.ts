import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { configureMotion, resetMotionSwitchForTests } from '../../../lib/motion/reducedMotion';
import { installWaapiStub, type WaapiStub } from '../../../lib/motion/waapiStub';
import { PHONE_FADE_MS, PHONE_SLIDE_MS, playPhoneScreens } from './phoneMotion';

let waapi: WaapiStub;
let places: HTMLElement;
let conversation: HTMLElement;

beforeEach(() => {
  waapi = installWaapiStub();
  places = document.createElement('div');
  conversation = document.createElement('div');
});

afterEach(() => {
  waapi.restore();
  resetMotionSwitchForTests();
});

const played = (id: string) => waapi.played.find((record) => record.animation.id === `glass-phone:${id}`);

describe('playPhoneScreens', () => {
  it('slides the conversation in from the right while places steps back and fades', () => {
    const animations = playPhoneScreens(places, conversation, 'conversation');
    expect(animations).toHaveLength(2);
    const incoming = played('in');
    const outgoing = played('out');
    expect(incoming?.target).toBe(conversation);
    expect(incoming?.keyframes).toEqual([{ transform: 'translateX(100%)' }, { transform: 'none' }]);
    expect(outgoing?.target).toBe(places);
    // Places leaves early (it is gone by 70%), so it never shows through the
    // conversation, which has no surface of its own.
    expect(outgoing?.keyframes).toEqual([
      { opacity: 1, transform: 'none', offset: 0 },
      { opacity: 0, offset: 0.7 },
      { opacity: 0, transform: 'translateX(-22%)', offset: 1 },
    ]);
    expect(incoming?.options.duration).toBe(PHONE_SLIDE_MS);
  });

  it('going back is the same move reversed', () => {
    playPhoneScreens(places, conversation, 'places');
    const incoming = played('in');
    const outgoing = played('out');
    expect(incoming?.target).toBe(places);
    // And arrives late, once the conversation has mostly left.
    expect(incoming?.keyframes).toEqual([
      { opacity: 0, transform: 'translateX(-22%)', offset: 0 },
      { opacity: 0, offset: 0.4 },
      { opacity: 1, transform: 'none', offset: 1 },
    ]);
    expect(outgoing?.target).toBe(conversation);
    expect(outgoing?.keyframes).toEqual([{ transform: 'none' }, { transform: 'translateX(100%)' }]);
  });

  it('under reduced motion it is a 150ms crossfade in place', () => {
    configureMotion('reduced');
    playPhoneScreens(places, conversation, 'conversation');
    const incoming = played('in');
    const outgoing = played('out');
    expect(incoming?.options.duration).toBe(PHONE_FADE_MS);
    expect(outgoing?.options.duration).toBe(PHONE_FADE_MS);
    expect(incoming?.keyframes).toEqual([
      { opacity: 0, transform: 'none' },
      { opacity: 1, transform: 'none' },
    ]);
    expect(outgoing?.keyframes).toEqual([
      { opacity: 1, transform: 'none' },
      { opacity: 0, transform: 'none' },
    ]);
  });

  it('moves only transform and opacity (the motion budget)', () => {
    for (const mode of ['system', 'reduced'] as const) {
      configureMotion(mode);
      waapi.played.length = 0;
      playPhoneScreens(places, conversation, 'conversation');
      playPhoneScreens(places, conversation, 'places');
      for (const record of waapi.played) {
        for (const frame of record.keyframes) {
          for (const key of Object.keys(frame)) expect(['transform', 'opacity', 'offset']).toContain(key);
        }
      }
    }
  });

  it('plays what it can: a screen that is not mounted is skipped', () => {
    expect(playPhoneScreens(null, conversation, 'conversation')).toHaveLength(1);
    expect(playPhoneScreens(null, null, 'places')).toHaveLength(0);
  });
});
