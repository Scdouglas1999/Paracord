import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useGlassStore, type StageTarget } from '../stores/glassStore';
import { glassKeyAction, useGlassKeybinds } from './useGlassKeybinds';

/**
 * The stage's keys (docs/glass-spec.md §9): S sidebar, T theater, H hide chat,
 * C clip, Esc stop watching, each only while a stage is open and never while
 * the key is somebody else's.
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
  it('maps S, T, H, C and Esc, either case, and nothing with a modifier', () => {
    const plain = { ctrlKey: false, altKey: false, metaKey: false };
    expect(glassKeyAction({ key: 's', ...plain })).toBe('browse');
    expect(glassKeyAction({ key: 'T', ...plain })).toBe('theater');
    expect(glassKeyAction({ key: 'h', ...plain })).toBe('chat');
    expect(glassKeyAction({ key: 'c', ...plain })).toBe('clip');
    expect(glassKeyAction({ key: 'Escape', ...plain })).toBe('stop');
    expect(glassKeyAction({ key: 'x', ...plain })).toBeNull();
    expect(glassKeyAction({ key: 's', ...plain, ctrlKey: true })).toBeNull();
    expect(glassKeyAction({ key: 'f', ...plain, metaKey: true })).toBeNull();
  });
});

describe('useGlassKeybinds', () => {
  it('S browses, T switches layouts, H hides the chat in theater only', () => {
    const onStop = vi.fn();
    render(<Keys onStop={onStop} />);
    useGlassStore.getState().openStage(LOUNGE);
    press('h');
    expect(useGlassStore.getState().chatHidden).toBe(false);
    press('s');
    expect(useGlassStore.getState().browseOpen).toBe(true);
    press('s');
    expect(useGlassStore.getState().browseOpen).toBe(false);
    press('t');
    expect(useGlassStore.getState().stage.mode).toBe('theater');
    // Theater opens with the chat hidden (19db3e60); H brings it back and hides it again.
    expect(useGlassStore.getState().chatHidden).toBe(true);
    press('h');
    expect(useGlassStore.getState().chatHidden).toBe(false);
    press('H');
    expect(useGlassStore.getState().chatHidden).toBe(true);
    press('T');
    expect(useGlassStore.getState().stage.mode).toBe('side');
    expect(onStop).not.toHaveBeenCalled();
  });

  it('Esc puts browse away first, then stops watching', () => {
    const onStop = vi.fn();
    render(<Keys onStop={onStop} />);
    useGlassStore.getState().openStage(LOUNGE);
    useGlassStore.getState().setBrowseOpen(true);
    press('Escape');
    expect(useGlassStore.getState().browseOpen).toBe(false);
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
    press('s');
    press('Escape');
    expect(useGlassStore.getState().browseOpen).toBe(false);
    expect(onStop).not.toHaveBeenCalled();

    useGlassStore.getState().openStage(LOUNGE);
    const box = document.createElement('textarea');
    document.body.appendChild(box);
    box.focus();
    press('s', {}, box);
    press('t', {}, box);
    press('c', {}, box);
    press('Escape', {}, box);
    expect(useGlassStore.getState().browseOpen).toBe(false);
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
    press('s');
    document.body.removeEventListener('keydown', claim);
    expect(onStop).not.toHaveBeenCalled();
    expect(useGlassStore.getState().browseOpen).toBe(false);
  });

  it('the phone stage answers Esc and C (its card has a Clip button), not S or T', () => {
    const onStop = vi.fn();
    render(<Keys phone onStop={onStop} />);
    useGlassStore.getState().openStage(LOUNGE);
    press('s');
    press('t');
    expect(useGlassStore.getState().browseOpen).toBe(false);
    expect(useGlassStore.getState().stage.mode).toBe('side');
    press('c');
    expect(clip.triggerClip).toHaveBeenCalledTimes(1);
    press('Escape');
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('the call itself (no stream) leaves T, H and C alone, and keeps S and Esc', () => {
    const onStop = vi.fn();
    render(<Keys stream={false} onStop={onStop} />);
    useGlassStore.getState().openStage({ ...LOUNGE, streamerId: null });
    press('t');
    press('c');
    expect(useGlassStore.getState().stage.mode).toBe('side');
    expect(clip.triggerClip).not.toHaveBeenCalled();
    press('s');
    expect(useGlassStore.getState().browseOpen).toBe(true);
    press('Escape');
    expect(useGlassStore.getState().browseOpen).toBe(false);
    press('Escape');
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
