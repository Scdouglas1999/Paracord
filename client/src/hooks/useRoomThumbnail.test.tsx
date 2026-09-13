import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useRoomThumbnail } from './useRoomThumbnail';
import { useVoiceStore } from '../stores/voiceStore';
import { personLight, voiceRoomLight } from '../lib/attention/light';
import type { MediaEngine, MediaStreamCapabilities } from '../lib/media/mediaEngine';

const SCOPE = { serverId: 'a', userId: 'viewer' };

function caps(over: Partial<MediaStreamCapabilities> = {}): MediaStreamCapabilities {
  return {
    video: [],
    nativeDesktopRenderer: false,
    browserInteropProtocolV1: true,
    realMediaE2ee: true,
    simulcastV1: false,
    ...over,
  };
}

function engineFor(capabilities: MediaStreamCapabilities) {
  return {
    getStreamCapabilities: vi.fn(async () => capabilities),
    subscribeVideo: vi.fn(() => () => {}),
  } as unknown as MediaEngine;
}

function room(channelId = 'v1') {
  return voiceRoomLight({
    scope: SCOPE,
    guildId: 'g1',
    channelId,
    name: 'Shop floor',
    occupants: [
      {
        person: personLight({ userId: '1', name: 'Mara', status: 'online' }),
        sharingScreen: true,
      },
    ],
    nowMs: 0,
  });
}

beforeEach(() => {
  useVoiceStore.setState({
    mediaEngine: null,
    channelId: null,
    callScope: null,
    connected: false,
  });
});

describe('useRoomThumbnail', () => {
  it('is a still with no call running, and says so', () => {
    const { result } = renderHook(() => useRoomThumbnail(room()));
    expect(result.current.state).toMatchObject({ live: false, reason: 'no-engine' });
    expect(result.current.frame).toBeNull();
  });

  it('is a still for a room you have not joined', async () => {
    useVoiceStore.setState({
      mediaEngine: engineFor(caps()),
      channelId: 'v2',
      callScope: SCOPE,
      connected: true,
    });
    const { result } = renderHook(() => useRoomThumbnail(room('v1')));
    await waitFor(() => expect(result.current.state.reason).toBe('not-joined'));
  });

  it('is a still when the platform composites the video below the webview', async () => {
    useVoiceStore.setState({
      mediaEngine: engineFor(caps({ nativeRenderUnderlay: true })),
      channelId: 'v1',
      callScope: SCOPE,
      connected: true,
    });
    const { result } = renderHook(() => useRoomThumbnail(room('v1')));
    await waitFor(() => expect(result.current.state.reason).toBe('native-surface'));
    expect(result.current.state.live).toBe(false);
  });

  it('goes live only in the room you are in on an engine that renders to a canvas', async () => {
    const engine = engineFor(caps());
    useVoiceStore.setState({
      mediaEngine: engine,
      channelId: 'v1',
      callScope: SCOPE,
      connected: true,
    });
    const { result } = renderHook(() => useRoomThumbnail(room('v1')));
    await waitFor(() => expect(result.current.state.live).toBe(true));
    await waitFor(() => expect(engine.subscribeVideo).toHaveBeenCalledTimes(1));
    const call = (engine.subscribeVideo as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('1');
    expect(call[3]).toEqual({ preferredTrackId: 'screen' });
  });

  it('releases the engine subscription when the thumbnail unmounts', async () => {
    const release = vi.fn();
    const engine = engineFor(caps());
    (engine.subscribeVideo as unknown as ReturnType<typeof vi.fn>).mockReturnValue(release);
    useVoiceStore.setState({
      mediaEngine: engine,
      channelId: 'v1',
      callScope: SCOPE,
      connected: true,
    });
    const { result, unmount } = renderHook(() => useRoomThumbnail(room('v1')));
    await waitFor(() => expect(result.current.state.live).toBe(true));
    unmount();
    expect(release).toHaveBeenCalled();
  });

  it('never subscribes for a room with nobody publishing', async () => {
    const engine = engineFor(caps());
    useVoiceStore.setState({
      mediaEngine: engine,
      channelId: 'v1',
      callScope: SCOPE,
      connected: true,
    });
    const dark = voiceRoomLight({
      scope: SCOPE,
      guildId: 'g1',
      channelId: 'v1',
      name: 'Shop floor',
      occupants: [{ person: personLight({ userId: '1', name: 'Mara', status: 'online' }) }],
      nowMs: 0,
    });
    const { result } = renderHook(() => useRoomThumbnail(dark));
    await waitFor(() => expect(result.current.state.reason).toBe('no-publisher'));
    expect(engine.subscribeVideo).not.toHaveBeenCalled();
  });
});
