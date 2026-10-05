import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetMotionSwitchForTests } from '../../../../lib/motion/reducedMotion';
import { installWaapiStub, type WaapiStub } from '../../../../lib/motion/waapiStub';
import { usePhoneNavStore } from '../../../glass/shell/phoneNav';
import { useToolbarStore } from '../toolbarStore';
import { PHONE_LANDSCAPE_QUERY, isPhoneNow, useIsPhone } from './phoneLayout';
import { pushSheet, resetPushedSheetsForTests, skipNextSheetPop } from './pushedSheets';
import { EDGE_ZONE, releaseFinishes, useEdgeSwipe } from './useEdgeSwipe';
import { KEYBOARD_MIN, keyboardInset, usePhoneRoot } from './usePhoneRoot';

/**
 * IX-16 (Phone): the phone's own modules. The frame, the strip and the sheet
 * are covered end to end by e2e/index-phone.spec.ts; these hold the rules.
 */

let waapi: WaapiStub;

beforeEach(() => {
  waapi = installWaapiStub();
});

afterEach(() => {
  waapi.restore();
  resetMotionSwitchForTests();
  resetPushedSheetsForTests();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-ix-layout');
  usePhoneNavStore.getState().setScreen(null);
  vi.unstubAllGlobals();
});

const frame = (time = 40) => new Promise((resolve) => setTimeout(resolve, time));

/** The phone frame's two screens, each with its shade, as IxFrame draws them. */
function phoneFrame(screen: 'places' | 'conversation', stage = 'none') {
  const root = document.createElement('div');
  root.className = 'ix-frame';
  root.dataset.layout = 'phone';
  root.dataset.screen = screen;
  root.dataset.stage = stage;
  const side = document.createElement('nav');
  side.className = 'ix-side';
  const main = document.createElement('main');
  main.className = 'ix-main';
  for (const el of [side, main]) {
    const shade = document.createElement('div');
    shade.className = 'ix-phone-shade';
    el.appendChild(shade);
    root.appendChild(el);
  }
  (screen === 'places' ? side : main).dataset.active = 'true';
  document.body.appendChild(root);
  return { root, side, main, sideShade: side.firstElementChild as HTMLElement, mainShade: main.firstElementChild as HTMLElement };
}

describe('what a phone is', () => {
  it('a narrow window, or a short touch screen held sideways; never a short desktop window', () => {
    const matches = new Map<string, boolean>();
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: matches.get(query) ?? false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    matches.set('(width < 768px)', true);
    expect(isPhoneNow()).toBe(true);
    matches.set('(width < 768px)', false);
    expect(isPhoneNow()).toBe(false);
    matches.set(PHONE_LANDSCAPE_QUERY, true);
    expect(isPhoneNow()).toBe(true);
    expect(PHONE_LANDSCAPE_QUERY).toContain('pointer: coarse');
    expect(PHONE_LANDSCAPE_QUERY).toContain('hover: none');
    const { result } = renderHook(() => useIsPhone());
    expect(result.current).toBe(true);
  });
});

describe('the keyboard (usePhoneRoot)', () => {
  it('reads the inset from the visual viewport, and ignores anything smaller than a keyboard', () => {
    expect(keyboardInset(844, null)).toEqual({ top: 0, bottom: 0 });
    expect(keyboardInset(844, { height: 844, offsetTop: 0 })).toEqual({ top: 0, bottom: 0 });
    expect(keyboardInset(844, { height: 844 - KEYBOARD_MIN + 1, offsetTop: 0 })).toEqual({ top: 0, bottom: 0 });
    expect(keyboardInset(844, { height: 508, offsetTop: 0 })).toEqual({ top: 0, bottom: 336 });
    // iOS scrolled the visual viewport to show the field: what is visible starts lower.
    expect(keyboardInset(844, { height: 508, offsetTop: 40 })).toEqual({ top: 40, bottom: 296 });
  });

  it('marks the document a phone, and says where the keyboard is while it is up', async () => {
    const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('innerHeight', 844);
    const root = document.documentElement;
    const { rerender, unmount } = renderHook(({ phone }) => usePhoneRoot(phone), { initialProps: { phone: true } });
    expect(root).toHaveAttribute('data-ix-layout', 'phone');
    expect(root).not.toHaveAttribute('data-ix-keyboard');

    viewport.height = 508;
    viewport.dispatchEvent(new Event('resize'));
    await act(() => frame());
    expect(root).toHaveAttribute('data-ix-keyboard', 'open');
    expect(root.style.getPropertyValue('--ix-keyboard')).toBe('336px');

    viewport.height = 844;
    viewport.dispatchEvent(new Event('resize'));
    await act(() => frame());
    expect(root).not.toHaveAttribute('data-ix-keyboard');
    expect(root.style.getPropertyValue('--ix-keyboard')).toBe('');

    rerender({ phone: false });
    expect(root).not.toHaveAttribute('data-ix-layout');
    unmount();
  });

  it('keeps a conversation read to its end at its end when main shrinks', async () => {
    const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('innerHeight', 844);
    const main = document.createElement('main');
    const feed = document.createElement('div');
    feed.setAttribute('role', 'feed');
    main.appendChild(feed);
    document.body.appendChild(main);
    Object.defineProperties(feed, { scrollHeight: { value: 2000 }, clientHeight: { value: 700 } });
    feed.scrollTop = 1300;
    renderHook(() => usePhoneRoot(true));
    viewport.height = 508;
    viewport.dispatchEvent(new Event('resize'));
    await act(() => frame());
    expect(feed.scrollTop).toBe(2000);
  });
});

describe('sheets are pushed pages (pushedSheets)', () => {
  it('holds the screen beneath back while a sheet is open, and plays it there and back', async () => {
    const { main, mainShade } = phoneFrame('conversation');
    const close = pushSheet();
    expect(document.documentElement).toHaveAttribute('data-ix-pushed', 'sheet');
    const under = waapi.played.find((record) => record.animation.id === 'ix-phone-sheet:under');
    expect(under?.target).toBe(main);
    expect(under?.keyframes).toEqual([{ transform: 'none' }, { transform: 'translateX(-30%)' }]);
    expect(waapi.played.find((record) => record.animation.id === 'ix-phone-sheet:shade')?.target).toBe(mainShade);

    waapi.played.length = 0;
    close();
    await frame();
    expect(document.documentElement).not.toHaveAttribute('data-ix-pushed');
    expect(waapi.played.find((record) => record.animation.id === 'ix-phone-sheet:under')?.keyframes).toEqual([
      { transform: 'translateX(-30%)' },
      { transform: 'none' },
    ]);
  });

  it('a sheet replaced by another is no pop and no push: the screen beneath stays back', async () => {
    phoneFrame('conversation');
    const closePeople = pushSheet();
    waapi.played.length = 0;
    closePeople();
    const closeSearch = pushSheet();
    await frame();
    expect(document.documentElement).toHaveAttribute('data-ix-pushed', 'sheet');
    expect(waapi.played).toHaveLength(0);
    closeSearch();
  });

  it('a close the edge swipe already drew plays nothing', async () => {
    phoneFrame('places');
    const close = pushSheet();
    waapi.played.length = 0;
    skipNextSheetPop();
    close();
    await frame();
    expect(document.documentElement).not.toHaveAttribute('data-ix-pushed');
    expect(waapi.played).toHaveLength(0);
  });
});

/* ---- The edge swipe ------------------------------------------------------------- */

function touch(type: string, x: number, y = 400, target: EventTarget = document.body) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const point = { clientX: x, clientY: y };
  const list = type === 'touchend' || type === 'touchcancel' ? [] : [point];
  Object.defineProperty(event, 'touches', { value: list });
  Object.defineProperty(event, 'changedTouches', { value: [point] });
  target.dispatchEvent(event);
  return event;
}

function swipe(points: number[], y = 400, target: EventTarget = document.body) {
  touch('touchstart', points[0], y, target);
  for (const x of points.slice(1)) touch('touchmove', x, y, target);
}

describe('the back gesture (useEdgeSwipe)', () => {
  beforeEach(() => {
    vi.stubGlobal('innerWidth', 390);
    usePhoneNavStore.getState().setScreen('conversation');
  });

  it('decides on release: past half way or a flick finishes, a flick back cancels', () => {
    expect(releaseFinishes(0.6, 0)).toBe(true);
    expect(releaseFinishes(0.3, 0)).toBe(false);
    expect(releaseFinishes(0.2, 0.8)).toBe(true);
    expect(releaseFinishes(0.8, -0.8)).toBe(false);
  });

  it('drags main off the sidebar with the finger, and lets it go to the root past half way', () => {
    const { main, side, sideShade } = phoneFrame('conversation');
    renderHook(() => useEdgeSwipe(true));
    swipe([4, 30, 120, 195]);
    // 191 of 390 px: about half way.
    expect(main.style.transform).toBe('translateX(48.974%)');
    expect(side.style.transform).toMatch(/^translateX\(-15\.\d+%\)$/);
    expect(Number(sideShade.style.opacity)).toBeCloseTo(0.51, 2);

    touch('touchmove', 260);
    act(() => {
      touch('touchend', 260);
    });
    // The finger's writes are gone; the rest of the move plays from where it let go.
    expect(main.style.transform).toBe('');
    expect(usePhoneNavStore.getState().screen).toBe('places');
    const top = waapi.played.find((record) => record.animation.id === 'ix-phone:top');
    expect(top?.target).toBe(main);
    expect(top?.keyframes.at(-1)).toEqual({ transform: 'translateX(100%)' });
  });

  it('springs back when let go short of half way', () => {
    const { main } = phoneFrame('conversation');
    renderHook(() => useEdgeSwipe(true));
    swipe([4, 40, 90]);
    touch('touchend', 90);
    expect(usePhoneNavStore.getState().screen).toBe('conversation');
    expect(main.style.transform).toBe('');
    const top = waapi.played.find((record) => record.animation.id === 'ix-phone:top');
    expect(top?.keyframes.at(-1)).toEqual({ transform: 'none' });
  });

  it('only from the edge, only sideways, and never from a field or under a menu', () => {
    const { main } = phoneFrame('conversation');
    renderHook(() => useEdgeSwipe(true));
    // Not at the edge.
    swipe([EDGE_ZONE + 10, 200, 300]);
    touch('touchend', 300);
    expect(usePhoneNavStore.getState().screen).toBe('conversation');
    // A drag that turns vertical is a scroll.
    touch('touchstart', 4, 300);
    touch('touchmove', 6, 340);
    touch('touchmove', 200, 350);
    touch('touchend', 200, 350);
    expect(main.style.transform).toBe('');
    expect(usePhoneNavStore.getState().screen).toBe('conversation');
    // A field keeps the edge.
    const field = document.createElement('textarea');
    main.appendChild(field);
    swipe([4, 100, 300], 400, field);
    touch('touchend', 300, 400, field);
    expect(usePhoneNavStore.getState().screen).toBe('conversation');
    // A menu in front keeps it too.
    const menu = document.createElement('div');
    menu.className = 'ix-menu';
    document.body.appendChild(menu);
    swipe([4, 100, 300]);
    touch('touchend', 300);
    expect(usePhoneNavStore.getState().screen).toBe('conversation');
  });

  it('a page the route pushed (a thread) takes a long enough swipe as its back', () => {
    phoneFrame('conversation');
    const onBack = vi.fn();
    useToolbarStore.getState().register(Symbol('thread'), { onBack });
    renderHook(() => useEdgeSwipe(true));
    swipe([4, 30, 50]);
    touch('touchend', 50);
    expect(onBack).not.toHaveBeenCalled();
    swipe([4, 60, 120]);
    touch('touchend', 120);
    expect(onBack).toHaveBeenCalledTimes(1);
    useToolbarStore.setState({ page: null, owner: null });
  });

  it('drags a pushed sheet off the screen beneath it, and closes it by its own back', () => {
    const { main } = phoneFrame('conversation');
    const sheet = document.createElement('div');
    sheet.className = 'ix-sheet';
    sheet.dataset.host = 'window';
    const back = document.createElement('button');
    back.setAttribute('data-ix-sheet-dismiss', '');
    const closed = vi.fn();
    back.addEventListener('click', closed);
    sheet.appendChild(back);
    document.body.appendChild(sheet);
    renderHook(() => useEdgeSwipe(true));
    swipe([4, 120, 250]);
    expect(sheet.style.transform).toBe('translateX(63.077%)');
    expect(main.style.transform).toMatch(/^translateX\(-11\.\d+%\)$/);
    touch('touchend', 250);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(sheet).toHaveAttribute('data-ix-dismissed');
    expect(usePhoneNavStore.getState().screen).toBe('conversation');
  });

  it('does nothing while turned off (not a phone, the call, settings)', () => {
    phoneFrame('conversation');
    renderHook(() => useEdgeSwipe(false));
    swipe([4, 200, 300]);
    touch('touchend', 300);
    expect(usePhoneNavStore.getState().screen).toBe('conversation');
  });
});
