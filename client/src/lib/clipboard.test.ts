import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = { tauri: true };
const invokeMock = vi.fn();
vi.mock('./tauriEnv', () => ({ isTauri: () => env.tauri }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import { copySecretToClipboard, readClipboardText, writeClipboardText } from './clipboard';

let clipboard = '';

beforeEach(() => {
  vi.useFakeTimers();
  env.tauri = true;
  clipboard = '';
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, args?: { text?: string }) => {
    if (command === 'plugin:clipboard-manager|write_text') clipboard = args?.text ?? '';
    if (command === 'plugin:clipboard-manager|read_text') return clipboard;
    if (command === 'plugin:clipboard-manager|clear') clipboard = '';
    return undefined;
  });
});
afterEach(() => vi.useRealTimers());

describe('copySecretToClipboard', () => {
  it('clears the clipboard after the delay when it still holds the secret', async () => {
    const copy = await copySecretToClipboard('word word word', 1000);
    expect(copy.autoClears).toBe(true);
    expect(clipboard).toBe('word word word');
    await vi.advanceTimersByTimeAsync(1000);
    expect(clipboard).toBe('');
  });

  it('leaves alone something copied in the meantime', async () => {
    await copySecretToClipboard('secret', 1000);
    clipboard = 'something else';
    await vi.advanceTimersByTimeAsync(1000);
    expect(clipboard).toBe('something else');
  });

  it('a newer copy replaces the older timer, and cancel stops it', async () => {
    await copySecretToClipboard('one', 1000);
    const second = await copySecretToClipboard('two', 5000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(clipboard).toBe('two');
    second.cancel();
    await vi.advanceTimersByTimeAsync(5000);
    expect(clipboard).toBe('two');
  });

  it('in a browser copies, does not promise a clear, and never reads', async () => {
    env.tauri = false;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const copy = await copySecretToClipboard('secret', 1000);
    expect(copy.autoClears).toBe(false);
    expect(writeText).toHaveBeenCalledWith('secret');
    await vi.advanceTimersByTimeAsync(2000);
    expect(invokeMock).not.toHaveBeenCalled();
    await expect(readClipboardText()).rejects.toThrow(/desktop app/);
    await writeClipboardText('x');
    expect(writeText).toHaveBeenLastCalledWith('x');
  });
});
