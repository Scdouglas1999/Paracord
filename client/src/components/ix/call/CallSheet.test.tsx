import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetMotionSwitchForTests } from '../../../lib/motion/reducedMotion';
import { installWaapiStub, type WaapiStub } from '../../../lib/motion/waapiStub';
import { useGlassStore } from '../../../stores/glassStore';
import { CALL_SHEET_OPEN_MS, CallSheet } from './CallSheet';

const landscape = vi.hoisted(() => ({ value: false }));
vi.mock('../shell/phone/phoneLayout', () => ({ usePhoneLandscape: () => landscape.value }));

/**
 * IX-16: the call on a phone is a bottom sheet (index-spec §9). The view inside
 * is the desktop's (CallSlot's suite); this holds the sheet: its rise, the
 * drag that dismisses it, and full screen.
 */

let waapi: WaapiStub;
const LOUNGE = { serverId: 'local', guildId: 'g1', channelId: 'lounge', streamerId: null };

beforeEach(() => {
  waapi = installWaapiStub();
  landscape.value = false;
  useGlassStore.getState().reset();
  useGlassStore.getState().openStage(LOUNGE);
});

afterEach(() => {
  waapi.restore();
  resetMotionSwitchForTests();
  useGlassStore.getState().reset();
  document.body.innerHTML = '';
});

function renderSheet() {
  return render(
    <div className="ix-call-host">
      <CallSheet channelId="lounge" mode={useGlassStore.getState().stage.mode === 'theater' ? 'theater' : 'main'}>
        <section className="ix-inset-surface ix-call" aria-label="Call: lounge">
          <div className="ix-call__layer">
            <header className="ix-call-head">
              <h2>lounge</h2>
              <button type="button">Back to chat</button>
            </header>
          </div>
        </section>
      </CallSheet>
    </div>,
  );
}

describe('the call sheet', () => {
  it('rises in 190ms on the spring (from the bottom when no strip or card is on screen), over a scrim', () => {
    renderSheet();
    const open = waapi.played.find((record) => record.animation.id === 'ix-call-sheet:open');
    expect(open?.target).toBe(screen.getByTestId('ix-call-sheet'));
    expect(open?.options.duration).toBe(CALL_SHEET_OPEN_MS);
    expect(open?.options.easing).toBe('cubic-bezier(0.32, 0.72, 0, 1)');
    expect(open?.keyframes[0]).toEqual({ transform: 'translateY(100%)' });
    expect(waapi.played.find((record) => record.animation.id === 'ix-call-sheet:scrim')).toBeDefined();
    expect(screen.getByTestId('ix-call-sheet').querySelector('.ix-call-sheet__handle')).not.toBeNull();
  });

  it('grows out of the call strip when the strip is on screen', () => {
    const frame = document.createElement('div');
    frame.className = 'ix-frame';
    frame.dataset.layout = 'phone';
    frame.dataset.screen = 'conversation';
    const strip = document.createElement('div');
    strip.setAttribute('data-ix-call-strip', '');
    strip.dataset.state = 'yours';
    strip.getBoundingClientRect = () => ({ left: 0, top: 99, width: 390, height: 40, right: 390, bottom: 139, x: 0, y: 99, toJSON: () => ({}) });
    frame.appendChild(strip);
    document.body.appendChild(frame);
    // The sheet at rest: under the status bar, the whole width (jsdom lays nothing out).
    const original = Element.prototype.getBoundingClientRect;
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.classList.contains('ix-call-sheet')) {
        return { left: 0, top: 55, width: 390, height: 789, right: 390, bottom: 844, x: 0, y: 55, toJSON: () => ({}) } as DOMRect;
      }
      return original.call(this);
    });
    renderSheet();
    spy.mockRestore();
    const open = waapi.played.find((record) => record.animation.id === 'ix-call-sheet:open');
    expect(String(open?.keyframes[0].transform)).toBe('translate(0px, 44px) scale(1, 0.0507)');
    expect(waapi.played.find((record) => record.animation.id === 'ix-call-sheet:open-content')).toBeDefined();
  });

  it('a drag down the header follows the finger; past a third it dismisses (the call goes on)', () => {
    renderSheet();
    const sheet = screen.getByTestId('ix-call-sheet');
    Object.defineProperty(sheet, 'offsetHeight', { value: 780 });
    const head = sheet.querySelector('.ix-call-head') as HTMLElement;
    fireEvent.pointerDown(head, { pointerId: 1, button: 0, clientY: 60 });
    fireEvent.pointerMove(sheet, { pointerId: 1, clientY: 160 });
    expect(sheet.style.transform).toBe('translateY(100px)');
    fireEvent.pointerMove(sheet, { pointerId: 1, clientY: 400 });
    act(() => {
      fireEvent.pointerUp(sheet, { pointerId: 1, clientY: 400 });
    });
    expect(useGlassStore.getState().stage.mode).toBe('none');
  });

  it('a short drag springs back', () => {
    renderSheet();
    const sheet = screen.getByTestId('ix-call-sheet');
    Object.defineProperty(sheet, 'offsetHeight', { value: 780 });
    const head = sheet.querySelector('.ix-call-head') as HTMLElement;
    fireEvent.pointerDown(head, { pointerId: 2, button: 0, clientY: 60 });
    fireEvent.pointerMove(sheet, { pointerId: 2, clientY: 120 });
    fireEvent.pointerUp(sheet, { pointerId: 2, clientY: 120 });
    expect(useGlassStore.getState().stage.mode).toBe('main');
    expect(sheet.style.transform).toBe('');
    expect(waapi.played.find((record) => record.animation.id === 'ix-call-sheet:return')).toBeDefined();
  });

  it('a press on a button in the header is a press, not a drag', () => {
    renderSheet();
    const sheet = screen.getByTestId('ix-call-sheet');
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Back to chat' }), { pointerId: 3, button: 0, clientY: 60 });
    fireEvent.pointerMove(sheet, { pointerId: 3, clientY: 400 });
    expect(sheet.style.transform).toBe('');
  });

  it('full screen: a stream in theater, or any stream sideways; never people alone', () => {
    const view = renderSheet();
    const sheet = () => screen.getByTestId('ix-call-sheet');
    expect(sheet()).not.toHaveAttribute('data-fullscreen');
    act(() => useGlassStore.getState().openStage({ ...LOUNGE, streamerId: 'vincent' }, 'theater'));
    view.rerender(
      <CallSheet channelId="lounge" mode="theater">
        <section className="ix-call" />
      </CallSheet>,
    );
    expect(sheet()).toHaveAttribute('data-fullscreen', 'true');
    // Exit full screen puts the stage back in main.
    fireEvent.click(screen.getByTestId('ix-call-sheet-exit-full'));
    expect(useGlassStore.getState().stage.mode).toBe('main');

    landscape.value = true;
    view.rerender(
      <CallSheet channelId="lounge" mode="main">
        <section className="ix-call" />
      </CallSheet>,
    );
    expect(sheet()).toHaveAttribute('data-fullscreen', 'true');
    // Sideways it is the phone's own full screen: no Exit, Back to chat closes.
    expect(screen.queryByTestId('ix-call-sheet-exit-full')).toBeNull();
    act(() => {
      fireEvent.click(screen.getByTestId('ix-call-sheet-back'));
    });
    expect(useGlassStore.getState().stage.mode).toBe('none');
  });
});
