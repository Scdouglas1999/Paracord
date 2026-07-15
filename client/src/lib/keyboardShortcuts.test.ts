import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatModShortcut,
  formatShortcut,
  formatShortcutKey,
  isMacOS,
} from './keyboardShortcuts';

function mockPlatform(platform: string) {
  vi.stubGlobal('navigator', {
    ...navigator,
    platform,
    userAgent: platform.startsWith('Mac')
      ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
      : 'Mozilla/5.0 (X11; Linux x86_64)',
  });
}

describe('keyboardShortcuts', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as Window & { __TAURI_OS_PLUGIN_INTERNALS__?: unknown })
      .__TAURI_OS_PLUGIN_INTERNALS__;
  });

  it('detects macOS from navigator.platform', () => {
    mockPlatform('MacIntel');
    expect(isMacOS()).toBe(true);
  });

  it('detects non-macOS from navigator.platform', () => {
    mockPlatform('Linux x86_64');
    expect(isMacOS()).toBe(false);
  });

  it('prefers Tauri OS internals when present', () => {
    mockPlatform('Linux x86_64');
    (window as Window & { __TAURI_OS_PLUGIN_INTERNALS__?: { os_type: string } })
      .__TAURI_OS_PLUGIN_INTERNALS__ = { os_type: 'macos' };
    expect(isMacOS()).toBe(true);
  });

  it('formats mod shortcuts per OS', () => {
    mockPlatform('MacIntel');
    expect(formatModShortcut('K')).toBe('⌘K');

    mockPlatform('Linux x86_64');
    expect(formatModShortcut('K')).toBe('Ctrl+K');
  });

  it('formats modifier keys and joins them per OS', () => {
    mockPlatform('MacIntel');
    expect(formatShortcut(['Ctrl', 'Shift', ','])).toBe('⌃⇧,');
    expect(formatShortcutKey('Alt')).toBe('⌥');

    mockPlatform('Win32');
    expect(formatShortcut('Ctrl+Shift+M')).toBe('Ctrl+Shift+M');
    expect(formatShortcutKey('Meta')).toBe('Win');
  });
});
