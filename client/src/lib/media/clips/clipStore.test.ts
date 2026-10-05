import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastStore } from '../../../stores/toastStore';
import type { MediaViewState } from '../../../stores/voice/viewSessions';
import { useVoiceStore } from '../../../stores/voiceStore';
import type { MediaEngine } from '../mediaEngine';
import type { ClipCapture } from './clipRing';
import type { ClipSource } from './clipSource';
import {
  dismissClip,
  postSavedClip,
  POSTED_TOAST_MS,
  resetClipsForTests,
  saveClip,
  savedSubtitle,
  savedTitle,
  startClipLifecycle,
  tooLargeMessage,
  useClipStore,
  type ClipDestination,
} from './clipStore';
import { triggerClip, useClip, type ClipTarget } from './useClip';
import { opusMonoPackets, vp9Frames } from './__fixtures__/loadFixtures';
import { ebmlChild, ebmlFloat, readEbml } from './__fixtures__/readContainers';

const upload = vi.hoisted(() => vi.fn());
vi.mock('../../../api/files', () => ({ fileApi: { upload } }));
vi.mock('../viewFrameSource', () => ({
  createViewFrameSource: () => ({ getLatestFrame: async () => null }),
}));

const sessionEngine = { name: 'session' } as unknown as MediaEngine;
const callEngine = { name: 'call' } as unknown as MediaEngine;
const TARGET: ClipTarget = { serverId: 's1', guildId: 'g1', channelId: 'lounge', streamerId: '7', streamerName: 'Vincent' };

function watch(phase: MediaViewState['phase'], over: Partial<MediaViewState> = {}): MediaViewState {
  return {
    id: 'v1',
    kind: 'watch',
    scope: { serverId: 's1', userId: 'me' },
    guildId: 'g1',
    channelId: 'lounge',
    streamerId: '7',
    route: 'session',
    phase,
    engine: phase === 'live' ? sessionEngine : null,
    sessionId: 'rcpt',
    endReason: null,
    error: null,
    ...over,
  };
}

/** Three seconds of Vincent's (fixture) screen and its audio, as the ring would hand them over. */
function fixtureCapture(): ClipCapture {
  const video = vp9Frames().map((frame, i) => ({ arrivalMs: 1_000 + i * 100 + 20, senderUs: 5_000_000 + i * 100_000, key: frame.key, data: frame.data }));
  const audio = opusMonoPackets().map((data, i) => ({ arrivalMs: 1_000 + i * 20 + 20, seq: 900 + i, data }));
  return { codec: 'vp9', video, audio, nowMs: 4_020 };
}

let source: { [K in keyof ClipSource]: ClipSource[K] extends (...args: infer A) => infer R ? ReturnType<typeof vi.fn<(...args: A) => R>> : ClipSource[K] };
let objectUrls = 0;

beforeEach(() => {
  source = {
    kind: 'browser',
    arm: vi.fn(async () => undefined),
    disarm: vi.fn(async () => undefined),
    cut: vi.fn(async () => fixtureCapture()),
  } as typeof source;
  resetClipsForTests(source as unknown as ClipSource);
  useVoiceStore.setState({ watchView: null });
  upload.mockReset();
  useToastStore.setState({ toasts: [] });
  URL.createObjectURL = vi.fn(() => `blob:clip-${++objectUrls}`);
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  resetClipsForTests();
});

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe('arming follows the watch', () => {
  it('buffers nothing until the watch is live, then arms for that sharer on that engine', async () => {
    const release = startClipLifecycle();
    act(() => useVoiceStore.setState({ watchView: watch('connecting') }));
    await flush();
    expect(source.arm).not.toHaveBeenCalled();
    act(() => useVoiceStore.setState({ watchView: watch('live') }));
    await flush();
    expect(source.arm).toHaveBeenCalledWith(sessionEngine, '7');
    expect(useClipStore.getState().armed?.streamerId).toBe('7');
    release();
  });

  it('keeps the ring when the watch moves into the call, and frees it when watching stops', async () => {
    const release = startClipLifecycle();
    act(() => useVoiceStore.setState({ watchView: watch('live') }));
    await flush();
    act(() => useVoiceStore.setState({ watchView: watch('live', { engine: callEngine, route: 'call' }) }));
    await flush();
    expect(source.arm).toHaveBeenLastCalledWith(callEngine, '7');
    expect(source.disarm).not.toHaveBeenCalled();
    await act(() => saveClip(TARGET));
    act(() => useVoiceStore.setState({ watchView: null }));
    await flush();
    expect(source.disarm).toHaveBeenCalledTimes(1);
    expect(useClipStore.getState()).toMatchObject({ armed: null, saved: null });
    expect(URL.revokeObjectURL).toHaveBeenCalled();
    release();
  });

  it('starts over for another stream', async () => {
    const release = startClipLifecycle();
    act(() => useVoiceStore.setState({ watchView: watch('live') }));
    await flush();
    act(() => useVoiceStore.setState({ watchView: watch('live', { streamerId: '9', id: 'v2' }) }));
    await flush();
    expect(source.disarm).toHaveBeenCalledTimes(1);
    expect(source.arm).toHaveBeenLastCalledWith(sessionEngine, '9');
    release();
  });

  it('never arms for your own share', async () => {
    const release = startClipLifecycle();
    act(() => useVoiceStore.setState({ watchView: watch('live', { streamerId: 'me' }) }));
    await flush();
    expect(source.arm).not.toHaveBeenCalled();
    const { result } = renderHook(() => useClip({ ...TARGET, streamerId: 'me', streamerName: 'Sean' }));
    expect(result.current).toMatchObject({ available: false, unavailableReason: "You can clip other people's streams, not your own." });
    release();
  });

  it('says why when the ring cannot start', async () => {
    source.arm.mockRejectedValueOnce(new Error('native buffer refused'));
    const release = startClipLifecycle();
    act(() => useVoiceStore.setState({ watchView: watch('live') }));
    await flush();
    const { result } = renderHook(() => useClip(TARGET));
    expect(result.current.available).toBe(false);
    expect(result.current.unavailableReason).toBe('Clips cannot start: native buffer refused');
    release();
  });
});

describe('saving', () => {
  it('cuts, muxes and holds a playable clip named for its length and source', async () => {
    const { result } = renderHook(() => useClip(TARGET));
    expect(result.current).toMatchObject({ available: false, unavailableReason: "Waiting for Vincent's screen." });
    act(() => useVoiceStore.setState({ watchView: watch('live') }));
    await flush();
    expect(result.current.available).toBe(true);
    await act(() => result.current.clip());
    const saved = useClipStore.getState().saved!;
    expect(saved.file.name).toBe("Clip 0m03s from Vincent's screen.webm");
    expect(saved.file.type).toBe('video/webm');
    expect(saved.sourceName).toBe("Vincent's screen");
    const bytes = new Uint8Array(await saved.file.arrayBuffer());
    const [, segment] = readEbml(bytes);
    expect(ebmlFloat(ebmlChild(ebmlChild(segment, 0x1549a966)!, 0x4489)!)).toBeGreaterThanOrEqual(3_000);
    expect(savedTitle(saved.durationMs)).toBe('Saved the last 3 seconds');
  });

  it('titles a full clip "Saved the last 30 seconds" and gives source and time', () => {
    expect(savedTitle(31_500)).toBe('Saved the last 30 seconds');
    expect(savedTitle(1_200)).toBe('Saved the last 1 second');
    expect(savedSubtitle({ sourceName: "Vincent's screen", savedAt: new Date(2026, 8, 30, 21, 14).getTime() })).toMatch(/^From Vincent's screen, 9:14\s?PM$/i);
  });

  it('the C key clips the stream on the stage, and says why when it cannot', async () => {
    expect(await triggerClip()).toBe(false); // nothing on the stage
    const { unmount } = renderHook(() => useClip(TARGET));
    await act(async () => { await triggerClip(); });
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe("Waiting for Vincent's screen.");
    act(() => useVoiceStore.setState({ watchView: watch('live') }));
    await flush();
    await act(async () => { await triggerClip(); });
    expect(useClipStore.getState().saved?.file.name).toMatch(/^Clip 0m03s/);
    unmount();
  });

  it('rejects with the reason when nothing has arrived yet', async () => {
    source.cut.mockResolvedValueOnce({ codec: null, video: [], audio: [], nowMs: 0 });
    const { result } = renderHook(() => useClip(TARGET));
    act(() => useVoiceStore.setState({ watchView: watch('live') }));
    await flush();
    await expect(act(() => result.current.clip())).rejects.toThrow('Nothing from this stream has arrived yet.');
    expect(useClipStore.getState().saving).toBe(false);
  });
});

describe('posting', () => {
  async function savedClip() {
    const release = startClipLifecycle();
    act(() => useVoiceStore.setState({ watchView: watch('live') }));
    await flush();
    await act(() => saveClip(TARGET));
    return release;
  }

  const destination = (over: Partial<ClipDestination> = {}): ClipDestination => ({
    channelId: 'general',
    label: 'General',
    encrypted: false,
    maxBytes: 50 * 1024 * 1024,
    allowed: true,
    reason: null,
    sendMessage: vi.fn(async () => undefined),
    ...over,
  });

  it('uploads through the attachment path and sends it as a message', async () => {
    await savedClip();
    upload.mockImplementation(async (_channel: string, _file: File, progress: (p: number) => void) => {
      progress(40);
      return { id: '555' };
    });
    const to = destination();
    await act(() => postSavedClip(to));
    const file = useClipStore.getState().saved!.file;
    expect(upload).toHaveBeenCalledWith('general', file, expect.any(Function));
    expect(to.sendMessage).toHaveBeenCalledWith('general', '', undefined, ['555']);
    expect(useClipStore.getState()).toMatchObject({ postPhase: 'posted', postedTo: 'General', postError: null });
  });

  it('goes by itself a few seconds after posting', async () => {
    await savedClip();
    upload.mockResolvedValue({ id: '1' });
    vi.useFakeTimers();
    await act(() => postSavedClip(destination()));
    act(() => { vi.advanceTimersByTime(POSTED_TOAST_MS); });
    expect(useClipStore.getState().saved).toBeNull();
  });

  it('hands an encrypted conversation’s clip to the encrypted producer, never the plaintext upload', async () => {
    await savedClip();
    const to = destination({ encrypted: true });
    await act(() => postSavedClip(to));
    expect(upload).not.toHaveBeenCalled();
    expect(to.sendMessage).toHaveBeenCalledWith('general', '', undefined, [], undefined, undefined, {
      files: [useClipStore.getState().saved!.file],
      maxCiphertextBytes: 50 * 1024 * 1024,
    });
  });

  it('refuses a clip over the upload limit with its size and the limit, and never shortens it', async () => {
    await savedClip();
    const size = useClipStore.getState().saved!.file.size;
    const to = destination({ maxBytes: size - 1 });
    await act(() => postSavedClip(to));
    expect(upload).not.toHaveBeenCalled();
    expect(to.sendMessage).not.toHaveBeenCalled();
    expect(useClipStore.getState()).toMatchObject({ tooLarge: true, postPhase: 'idle', postError: tooLargeMessage(size, size - 1, 'General') });
    expect(useClipStore.getState().saved!.file.size).toBe(size);
  });

  it('shows the server refusing a too-large file the same way', async () => {
    await savedClip();
    upload.mockRejectedValue(Object.assign(new Error('Payload Too Large'), { response: { status: 413, data: { message: 'File too large' } } }));
    await act(() => postSavedClip(destination({ maxBytes: null })));
    expect(useClipStore.getState().tooLarge).toBe(true);
    expect(useClipStore.getState().postError).toMatch(/so it was not posted/);
  });

  it('says why when this person may not attach files there', async () => {
    await savedClip();
    await act(() => postSavedClip(destination({ allowed: false, reason: 'You do not have permission to attach files here.' })));
    expect(upload).not.toHaveBeenCalled();
    expect(useClipStore.getState().postError).toBe('You do not have permission to attach files here.');
  });

  it('dismissing frees the clip', async () => {
    await savedClip();
    const saved = useClipStore.getState().saved!;
    act(() => dismissClip());
    expect(useClipStore.getState().saved).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(saved.url);
  });
});
