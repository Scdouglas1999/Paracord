import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { configureMotion, resetMotionSwitchForTests } from '../../../lib/motion/reducedMotion';
import { installWaapiStub, type WaapiStub } from '../../../lib/motion/waapiStub';
import {
  PHONE_FADE_MS,
  PHONE_MIN_FINISH_MS,
  PHONE_SLIDE_MS,
  clearPush,
  paintPush,
  playPhoneScreens,
  playPush,
  shadeOpacity,
  topTransform,
  underTransform,
} from './phoneMotion';

const SPRING = 'cubic-bezier(0.32, 0.72, 0, 1)';

let waapi: WaapiStub;
let places: HTMLElement;
let conversation: HTMLElement;
let shade: HTMLElement;

beforeEach(() => {
  waapi = installWaapiStub();
  places = document.createElement('nav');
  shade = document.createElement('div');
  shade.className = 'ix-phone-shade';
  places.appendChild(shade);
  conversation = document.createElement('main');
});

afterEach(() => {
  waapi.restore();
  resetMotionSwitchForTests();
});

const played = (id: string) => waapi.played.find((record) => record.animation.id === id);

describe('the push model (index-spec §9)', () => {
  it('places all three layers from one number: 0 pushed, 1 gone', () => {
    expect(topTransform(0)).toBe('none');
    expect(topTransform(1)).toBe('translateX(100%)');
    expect(topTransform(0.25)).toBe('translateX(25%)');
    expect(underTransform(0)).toBe('translateX(-30%)');
    expect(underTransform(1)).toBe('none');
    expect(underTransform(0.5)).toBe('translateX(-15%)');
    expect(shadeOpacity(0)).toBe(1);
    expect(shadeOpacity(1)).toBe(0);
  });

  it('a finger writes the layers directly, and lets go of them', () => {
    const layers = { top: conversation, under: places, shade };
    paintPush(layers, 0.4);
    expect(conversation.style.transform).toBe('translateX(40%)');
    expect(places.style.transform).toBe('translateX(-18%)');
    expect(shade.style.opacity).toBe('0.6');
    clearPush(layers);
    expect(conversation.style.transform).toBe('');
    expect(places.style.transform).toBe('');
    expect(shade.style.opacity).toBe('');
  });
});

describe('playPhoneScreens', () => {
  it('pushes main in from the right, 360ms on the spring, while the sidebar moves 30% left and dims', () => {
    const animations = playPhoneScreens(places, conversation, 'conversation');
    expect(animations).toHaveLength(3);
    const top = played('ix-phone:top');
    const under = played('ix-phone:under');
    const dim = played('ix-phone:shade');
    expect(top?.target).toBe(conversation);
    expect(top?.keyframes).toEqual([{ transform: 'translateX(100%)' }, { transform: 'none' }]);
    expect(under?.target).toBe(places);
    expect(under?.keyframes).toEqual([{ transform: 'none' }, { transform: 'translateX(-30%)' }]);
    expect(dim?.target).toBe(shade);
    expect(dim?.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    for (const record of [top, under, dim]) {
      expect(record?.options.duration).toBe(PHONE_SLIDE_MS);
      expect(record?.options.easing).toBe(SPRING);
      // Nothing fills forwards: the CSS resting state takes over.
      expect(record?.options.fill).toBeUndefined();
    }
  });

  it('going back is the same move reversed', () => {
    playPhoneScreens(places, conversation, 'places');
    expect(played('ix-phone:top')?.keyframes).toEqual([{ transform: 'none' }, { transform: 'translateX(100%)' }]);
    expect(played('ix-phone:under')?.keyframes).toEqual([{ transform: 'translateX(-30%)' }, { transform: 'none' }]);
    expect(played('ix-phone:shade')?.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
  });

  it('after a swipe, finishes from where the finger let go, in the time the distance left takes', () => {
    playPhoneScreens(places, conversation, 'places', 0.6);
    const top = played('ix-phone:top');
    expect(top?.keyframes).toEqual([{ transform: 'translateX(60%)' }, { transform: 'translateX(100%)' }]);
    expect(top?.options.duration).toBe(Math.round(PHONE_SLIDE_MS * 0.4));
    expect(played('ix-phone:under')?.keyframes[0]).toEqual({ transform: 'translateX(-12%)' });
  });

  it('never finishes a release in less than a beat', () => {
    playPush({ top: conversation, under: places, shade }, 0.95, 1);
    expect(played('ix-phone:top')?.options.duration).toBe(PHONE_MIN_FINISH_MS);
  });

  it('under reduced motion it is a 150ms crossfade in place', () => {
    configureMotion('reduced');
    playPhoneScreens(places, conversation, 'conversation');
    const top = played('ix-phone:top');
    const under = played('ix-phone:under');
    expect(top?.options.duration).toBe(PHONE_FADE_MS);
    expect(under?.options.duration).toBe(PHONE_FADE_MS);
    expect(top?.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(under?.keyframes).toEqual([
      { opacity: 1, transform: 'none' },
      { opacity: 0, transform: 'none' },
    ]);
    expect(played('ix-phone:shade')).toBeUndefined();
  });

  it('moves only transform and opacity (the motion budget)', () => {
    for (const mode of ['system', 'reduced'] as const) {
      configureMotion(mode);
      waapi.played.length = 0;
      playPhoneScreens(places, conversation, 'conversation');
      playPhoneScreens(places, conversation, 'places', 0.3);
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
