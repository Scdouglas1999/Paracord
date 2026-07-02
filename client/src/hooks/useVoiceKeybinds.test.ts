import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { voiceState, gatewayMock, authState } = vi.hoisted(() => {
  const voiceState = {
    connected: true,
    channelId: 'chan1',
    guildId: 'guild1',
    selfMute: false,
    selfDeaf: false,
    selfVideo: false,
    toggleMute: vi.fn(() => Promise.resolve()),
    toggleDeaf: vi.fn(() => Promise.resolve()),
    setPttEngaged: vi.fn(),
  };
  const gatewayMock = { updateVoiceStateAll: vi.fn() };
  const authState: { settings: { keybinds: Record<string, unknown>; notifications: Record<string, unknown> } } = {
    settings: { keybinds: {}, notifications: {} },
  };
  return { voiceState, gatewayMock, authState };
});

vi.mock('../gateway/manager', () => ({ gateway: gatewayMock }));
vi.mock('../stores/voiceStore', () => ({ useVoiceStore: { getState: () => voiceState } }));
vi.mock('../stores/authStore', () => ({
  useAuthStore: (selector: (s: typeof authState) => unknown) => selector(authState),
}));

import { useVoiceKeybinds } from './useVoiceKeybinds';

describe('useVoiceKeybinds PTT teardown', () => {
  beforeEach(() => {
    voiceState.connected = true;
    voiceState.channelId = 'chan1';
    voiceState.selfMute = false;
    voiceState.toggleMute.mockClear();
    voiceState.toggleDeaf.mockClear();
    voiceState.setPttEngaged.mockClear();
    gatewayMock.updateVoiceStateAll.mockClear();
    // Fresh reference each test so the hook's useMemo recomputes on rerender.
    authState.settings = {
      keybinds: { pushToTalk: 'F' },
      notifications: { voiceInputMode: 'push_to_talk' },
    };
  });

  it('force-releases the mic when re-subscribing while PTT is engaged', () => {
    const { rerender } = renderHook(() => useVoiceKeybinds());

    // Engage PTT. With selfMute=false, keydown does not toggle the mic itself.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f' }));
    expect(voiceState.setPttEngaged).toHaveBeenCalledWith(true);

    // Clear the on-mount auto-mute + engage calls so we isolate the teardown.
    voiceState.setPttEngaged.mockClear();
    voiceState.toggleMute.mockClear();

    // Change the PTT binding while the key is still physically held. This tears
    // down the old listeners; the held key's keyup would otherwise be lost.
    authState.settings = {
      keybinds: { pushToTalk: 'G' },
      notifications: { voiceInputMode: 'push_to_talk' },
    };
    rerender();

    // Cleanup must force-release: setPttEngaged(false) + re-mute.
    expect(voiceState.setPttEngaged).toHaveBeenCalledWith(false);
    expect(voiceState.toggleMute).toHaveBeenCalledTimes(1);
  });

  it('does not toggle the mic on teardown when PTT is not engaged', () => {
    const { unmount } = renderHook(() => useVoiceKeybinds());
    voiceState.toggleMute.mockClear();
    voiceState.setPttEngaged.mockClear();

    unmount();

    expect(voiceState.setPttEngaged).not.toHaveBeenCalled();
    expect(voiceState.toggleMute).not.toHaveBeenCalled();
  });
});
