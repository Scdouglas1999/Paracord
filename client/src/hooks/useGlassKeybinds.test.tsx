import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useGlassStore, type StageTarget } from '../stores/glassStore';
import { glassKeyAction, useGlassKeybinds } from './useGlassKeybinds';

/**
 * The call view's keys (docs/index-spec.md §7.4): Esc (theater -> main ->
 * closed), T theater, H the chat column, C clip with a stream in focus, each
 * only while the view is open and never while the key is somebody else's.
 * Glass's S (browse) is retired.
 */

const clip = vi.hoisted(() => ({ triggerClip: vi.fn(async () => true) }));
vi.mock('../lib/media/clips/useClip', () => ({ triggerClip: clip.triggerClip }));

const LOUNGE: StageTarget = { serverId: '__local__', guildId: 'g1', channelId: 'lounge', streamerId: 'vincent' };

function Keys({ phone = false, stream = true, onStop }: { phone?: boolean; stream?: boolean; onStop: () => void }) {
  useGlassKeybinds({ enabled: true, phone, stream, onStop });
  return null;
}

const press = (key: string, init: KeyboardEventInit = {}, target: Element = document.body) =>
  fireEvent.keyDown(target, { key, ...init });

beforeEach(() => {
  useGlassStore.getState().reset();
  clip.triggerClip.mockClear();
});

afterEach(() => {
  useGlassStore.getState().reset();
  document.body.innerHTML = '';
});

describe('glassKeyAction', () => {
  it('maps T, H, C and Esc, either case, nothing with a modifier, and no longer S', () => {
    const plain = { ctrlKey: false, altKey: false, metaKey: false };
    expect(glassKeyAction({ key: 's', ...plain })).toBeNull();
    expect(glassKeyAction({ key: 'T', ...plain })).toBe('theater');
    expect(glassKeyAction({ key: 'h', ...plain })).toBe('chat');
    expect(glassKeyAction({ key: 'c', ...plain })).toBe('clip');
    expect(glassKeyAction({ key: 'Escape', ...plain })).toBe('stop');
    expect(glassKeyAction({ key: 'x', ...plain })).toBeNull();
    expect(glassKeyAction({ key: 't', ...plain, ctrlKey: true })).toBeNull();
    expect(glassKeyAction({ key: 'f', ...plain, metaKey: true })).toBeNull();
  });
});

describe('useGlassKeybinds', () => {
  it('T switches main and theater, H shows and hides the chat column in both', () => {
    const onStop = vi.fn();
    render(<Keys onStop={onStop} />);
    useGlassStore.getState().openStage(LOUNGE);
    expect(useGlassStore.getState().stage.chat).toBe(false);
    press('h');
    expect(useGlassStore.getState().stage.chat).toBe(true);
    press('t');
    expect(useGlassStore.getState().stage.mode).toBe('theater');
    // The chat column stays as it was across theater.
    expect(useGlassStore.getState().stage.chat).toBe(true);
    press('H');
    expect(useGlassStore.getState().stage.chat).toBe(false);
    press('T');
    expect(useGlassStore.getState().stage.mode).toBe('side');
    press('s');
    expect(useGlassStore.getState().browseOpen).toBe(false);
    expect(onStop).not.toHaveBeenCalled();
  });

  it('Esc steps theater back to main first, then closes the view', () => {
    const onStop = vi.fn();
    render(<Keys onStop={onStop} />);
    useGlassStore.getState().openStage(LOUNGE, 'theater');
    press('Escape');
    expect(useGlassStore.getState().stage.mode).toBe('side');
    expect(onStop).not.toHaveBeenCalled();
    press('Escape');
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('C clips the stream on the stage, as the Clip button does', () => {
    render(<Keys onStop={vi.fn()} />);
    useGlassStore.getState().openStage(LOUNGE);
    press('c');
    expect(clip.triggerClip).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a stage, while typing, with a menu open, or with a sheet open', () => {
    const onStop = vi.fn();
    render(<Keys onStop={onStop} />);
    press('t');
    press('Escape');
    expect(useGlassStore.getState().stage.mode).toBe('none');
    expect(onStop).not.toHaveBeenCalled();

    useGlassStore.getState().openStage(LOUNGE);
    const box = document.createElement('textarea');
    document.body.appendChild(box);
    box.focus();
    press('h', {}, box);
    press('t', {}, box);
    press('c', {}, box);
    press('Escape', {}, box);
    expect(useGlassStore.getState().stage.chat).toBe(false);
    expect(useGlassStore.getState().stage.mode).toBe('side');
    expect(clip.triggerClip).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
    box.remove();

    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    // jsdom lays nothing out; a menu on screen has a box.
    menu.getClientRects = () => [{ width: 10, height: 10 }] as unknown as DOMRectList;
    document.body.appendChild(menu);
    press('Escape');
    press('t');
    expect(onStop).not.toHaveBeenCalled();
    expect(useGlassStore.getState().stage.mode).toBe('side');
    menu.remove();

    useGlassStore.getState().openSheet('search');
    press('Escape');
    expect(onStop).not.toHaveBeenCalled();
  });

  it('a key somebody claimed first (preventDefault) is theirs', () => {
    const onStop = vi.fn();
    render(<Keys onStop={onStop} />);
    useGlassStore.getState().openStage(LOUNGE);
    const claim = (event: KeyboardEvent) => event.preventDefault();
    document.body.addEventListener('keydown', claim);
    press('Escape');
    press('t');
    document.body.removeEventListener('keydown', claim);
    expect(onStop).not.toHaveBeenCalled();
    expect(useGlassStore.getState().stage.mode).toBe('side');
  });

  it('the phone answers Esc and C, not T or H (no theater, no chat column)', () => {
    const onStop = vi.fn();
    render(<Keys phone onStop={onStop} />);
    useGlassStore.getState().openStage(LOUNGE);
    press('t');
    press('h');
    expect(useGlassStore.getState().stage.mode).toBe('side');
    expect(useGlassStore.getState().stage.chat).toBe(false);
    press('c');
    expect(clip.triggerClip).toHaveBeenCalledTimes(1);
    press('Escape');
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('with no stream in focus C stays free; T, H and Esc still work', () => {
    const onStop = vi.fn();
    render(<Keys stream={false} onStop={onStop} />);
    useGlassStore.getState().openStage({ ...LOUNGE, streamerId: null });
    press('c');
    expect(clip.triggerClip).not.toHaveBeenCalled();
    press('t');
    expect(useGlassStore.getState().stage.mode).toBe('theater');
    press('h');
    expect(useGlassStore.getState().stage.chat).toBe(true);
    press('Escape');
    expect(useGlassStore.getState().stage.mode).toBe('side');
    press('Escape');
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
