import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = { tauri: true };
const readMock = vi.fn();
vi.mock('./tauriEnv', () => ({ isTauri: () => env.tauri }));
vi.mock('./clipboard', () => ({ readClipboardText: () => readMock() }));

import { peekClipboardInvite, resetClipboardInviteMemory, watchClipboardInvite } from './clipboardInvite';

const LINK = 'https://chat.example.com/invite/hTKzmak';

beforeEach(() => {
  env.tauri = true;
  readMock.mockReset();
  resetClipboardInviteMemory();
});

describe('peekClipboardInvite', () => {
  it('returns the parsed invite and offers each link once', async () => {
    readMock.mockResolvedValue(`  ${LINK}\n`);
    expect(await peekClipboardInvite()).toEqual({ serverUrl: 'https://chat.example.com', code: 'hTKzmak' });
    expect(await peekClipboardInvite()).toBeNull();
  });

  it('ignores text that is not an invite', async () => {
    readMock.mockResolvedValue('my shopping list');
    expect(await peekClipboardInvite()).toBeNull();
  });

  it('treats an empty clipboard as no offer but surfaces other failures', async () => {
    readMock.mockRejectedValueOnce(new Error('The clipboard is empty'));
    expect(await peekClipboardInvite()).toBeNull();
    readMock.mockRejectedValueOnce(new Error('dbus exploded'));
    await expect(peekClipboardInvite()).rejects.toThrow('dbus exploded');
  });

  it('never reads in a browser', async () => {
    env.tauri = false;
    expect(await peekClipboardInvite()).toBeNull();
    expect(readMock).not.toHaveBeenCalled();
  });
});

describe('watchClipboardInvite', () => {
  it('reads on mount and on focus, only while active with an empty field', async () => {
    readMock.mockResolvedValue(LINK);
    let active = true;
    let empty = true;
    const onInvite = vi.fn();
    const stop = watchClipboardInvite({ isActive: () => active, fieldIsEmpty: () => empty, onInvite });
    await vi.waitFor(() => expect(onInvite).toHaveBeenCalledTimes(1));

    resetClipboardInviteMemory();
    empty = false;
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    active = false;
    empty = true;
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    expect(readMock).toHaveBeenCalledTimes(1);

    active = true;
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(onInvite).toHaveBeenCalledTimes(2));

    stop();
    resetClipboardInviteMemory();
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    expect(readMock).toHaveBeenCalledTimes(2);
  });

  it('reports a read failure to onError', async () => {
    readMock.mockRejectedValue(new Error('boom'));
    const onError = vi.fn();
    const stop = watchClipboardInvite({ isActive: () => true, fieldIsEmpty: () => true, onInvite: vi.fn(), onError });
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    stop();
  });

  it('does nothing in a browser', () => {
    env.tauri = false;
    const stop = watchClipboardInvite({ isActive: () => true, fieldIsEmpty: () => true, onInvite: vi.fn() });
    window.dispatchEvent(new Event('focus'));
    expect(readMock).not.toHaveBeenCalled();
    stop();
  });
});
