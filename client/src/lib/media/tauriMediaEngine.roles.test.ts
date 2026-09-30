import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: ipc.invoke, Channel: class {} }));
vi.mock('@tauri-apps/api/event', () => ({ listen: ipc.listen }));
vi.mock('./video/canvasRenderer', () => ({
  CanvasRenderer: class {
    canvasElement: HTMLCanvasElement;
    constructor(canvas: HTMLCanvasElement) { this.canvasElement = canvas; }
    setRenderingEnabled() {}
    renderFrame(frame: { close(): void }) { frame.close(); }
    destroy() {}
  },
}));
import { TauriMediaEngine } from './tauriMediaEngine';

function token(claims: Record<string, unknown> = {}): string {
  const body = btoa(JSON.stringify({ sid: 'receipt-1', sub: '100', room: '9', ...claims }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `header.${body}.signature`;
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
const engines: TauriMediaEngine[] = [];
function engine() { const value = new TauriMediaEngine(); engines.push(value); return value; }

beforeEach(() => {
  ipc.handlers.clear();
  ipc.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === 'start_voice_session') return { connected: true };
    if (command === 'media_get_stream_capabilities') return { video: [], nativeDesktopRenderer: false, browserInteropProtocolV1: true, realMediaE2ee: true, simulcastV1: true };
    return [];
  });
  ipc.listen.mockReset().mockImplementation(async (event: string, handler: (event: { payload: unknown }) => void) => {
    ipc.handlers.set(event, handler);
    return vi.fn();
  });
});
afterEach(async () => { await Promise.allSettled(engines.splice(0).map((value) => value.disconnect())); });

describe('native roles', () => {
  it('asks the native side for a listening session, and starts the microphone in place', async () => {
    const media = engine();
    await media.connect('https://media.example/media', token(), 'pin', {
      id: 'call', role: 'listen', signal: new AbortController().signal,
    });
    expect(ipc.invoke).toHaveBeenCalledWith('start_voice_session', expect.objectContaining({
      role: 'listen', ownerId: media.sessionOwnerId,
    }));
    await media.startMicrophone({ inputDeviceId: 'alsa_input.usb-mic' });
    expect(ipc.invoke).toHaveBeenCalledWith('voice_switch_input_device', {
      deviceId: 'alsa_input.usb-mic', ownerId: media.sessionOwnerId,
    });
    // Only one session was ever started: the upgrade does not reconnect.
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'start_voice_session')).toHaveLength(1);
  });

  it('starts a view session as a view, and announces no keys from it', async () => {
    const media = engine();
    await media.connect('https://media.example/media', token({ view: 'watch' }), 'pin', {
      id: 'view', role: 'view', signal: new AbortController().signal,
    });
    expect(ipc.invoke).toHaveBeenCalledWith('start_voice_session', expect.objectContaining({ role: 'view' }));
    expect(ipc.invoke).not.toHaveBeenCalledWith('media_export_audio_sender_key', expect.anything());
    expect(ipc.invoke).not.toHaveBeenCalledWith('media_send_audio_key_announce', expect.anything());
  });

  it('refuses a view token outside the view role before touching the native side', async () => {
    const media = engine();
    await expect(media.connect('https://media.example/media', token({ view: 'ambient' }), 'pin', {
      id: 'call', signal: new AbortController().signal,
    })).rejects.toThrow(/cannot join a call/);
    expect(ipc.invoke).not.toHaveBeenCalledWith('start_voice_session', expect.anything());
  });

  it('refuses to start the microphone on a joined or view session role mismatch', async () => {
    const media = engine();
    await media.connect('https://media.example/media', token({ view: 'watch' }), 'pin', {
      id: 'view', role: 'view', signal: new AbortController().signal,
    });
    await expect(media.startMicrophone()).rejects.toThrow(/listening in/);
  });
});

describe('viewers in a native publisher’s roster (the relay marks them)', () => {
  it('does not tell the store about a viewer, and a member that turns viewer has left', async () => {
    const media = engine();
    const joins: string[] = [];
    const leaves: string[] = [];
    media.onParticipantJoin((id) => joins.push(id));
    media.onParticipantLeave((id) => leaves.push(id));
    await flush();
    const join = ipc.handlers.get(`media_participant_join:${media.sessionOwnerId}`)!;
    const leave = ipc.handlers.get(`media_participant_leave:${media.sessionOwnerId}`)!;
    join({ payload: { userId: '300', kind: 'member' } });
    join({ payload: { userId: '400', kind: 'viewer' } });
    // A kind this client does not know is never taken for a member.
    join({ payload: { userId: '700', kind: 'lurker' } });
    expect(joins).toEqual(['300']);
    leave({ payload: { userId: '400', kind: 'viewer' } });
    expect(leaves).toEqual([]);
    // Brendan leaves the call and starts watching instead.
    join({ payload: { userId: '300', kind: 'viewer' } });
    expect(leaves).toEqual(['300']);
    leave({ payload: { userId: '300', kind: 'viewer' } });
    expect(leaves).toEqual(['300']);
  });

  it('wraps what the native session asks for: the voice to members only, a stream key to its viewers too', async () => {
    const { MediaKeyring } = await import('./mediaKeyring');
    const brendan = MediaKeyring.create();
    const sean = MediaKeyring.create();
    const roster = [
      { userId: '300', sessionId: 'r-300', videoCapabilities: [], mediaPublicKey: brendan.publicKey, kind: 'member' },
      { userId: '400', sessionId: 'view-400', videoCapabilities: [], mediaPublicKey: sean.publicKey, kind: 'viewer' },
    ];
    const tracks = [
      { streamId: 'stream:100:screen', trackId: 'screen', publisherUserId: '100', kind: 'video', codec: 'vp9', layers: [] },
      { streamId: 'stream:100:screen', trackId: 'screen-audio', publisherUserId: '100', kind: 'audio', layers: [] },
      { streamId: 'stream:100:camera', trackId: 'camera', publisherUserId: '100', kind: 'video', codec: 'vp9', layers: [] },
    ];
    const baseInvoke = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'media_list_session_participant_capabilities') return roster;
      if (command === 'media_list_published_tracks') return tracks;
      if (command === 'media_export_audio_sender_key') return { epoch: 4, rawKey: Array(16).fill(1) };
      if (command === 'media_export_track_sender_key') return { epoch: 2, rawKey: Array(16).fill(2) };
      return baseInvoke(command, args);
    });
    const media = engine();
    await media.connect('https://media.example/media', token(), 'pin', {
      id: 'call', signal: new AbortController().signal, account: { assertCurrent: () => {} },
    } as never);
    const recipientsOf = (command: string, trackId?: string) => ipc.invoke.mock.calls
      .filter(([name, args]) => name === command && (!trackId || (args as { trackId?: string }).trackId === trackId))
      .map(([, args]) => ((args as { encryptedKeys: Array<{ recipientUserId: string }> }).encryptedKeys)
        .map((entry) => entry.recipientUserId));

    // The connect-time announce already followed the rule.
    await vi.waitFor(() => expect(recipientsOf('media_send_audio_key_announce')).toEqual([['300']]), { timeout: 5000 });
    ipc.invoke.mockClear();

    const announce = ipc.handlers.get(`media_announce_sender_keys:${media.sessionOwnerId}`)!;
    // A member left: everything rotated and goes to whoever may hold it.
    announce({ payload: {
      voice: true,
      tracks: tracks.map(({ streamId, trackId }) => ({ streamId, trackId })),
      recipients: null,
    } });
    await vi.waitFor(() => {
      expect(recipientsOf('media_send_audio_key_announce')).toEqual([['300']]);
      expect(recipientsOf('media_send_track_key_announce', 'screen')).toEqual([['300', '400']]);
      expect(recipientsOf('media_send_track_key_announce', 'screen-audio')).toEqual([['300', '400']]);
      expect(recipientsOf('media_send_track_key_announce', 'camera')).toEqual([['300']]);
    }, { timeout: 5000 });

    // A viewer arrived: the viewable stream's keys, to it alone, no voice key.
    ipc.invoke.mockClear();
    announce({ payload: {
      voice: false,
      tracks: [{ streamId: 'stream:100:screen', trackId: 'screen' }],
      recipients: ['400'],
    } });
    await vi.waitFor(() => {
      expect(recipientsOf('media_send_track_key_announce', 'screen')).toEqual([['400']]);
    }, { timeout: 5000 });
    expect(recipientsOf('media_send_audio_key_announce')).toEqual([]);

    // Even asked to, the voice key never goes to a viewer.
    ipc.invoke.mockClear();
    announce({ payload: { voice: true, tracks: [], recipients: ['400'] } });
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(ipc.invoke).not.toHaveBeenCalledWith('media_send_audio_key_announce', expect.anything());
  });
});

describe('native frame taps', () => {
  it('reports no track when the publisher never publishes one', async () => {
    vi.useFakeTimers();
    try {
      const media = engine();
      const tap = media.tapVideoFrames('200', 'screen', () => {});
      await vi.advanceTimersByTimeAsync(10_500);
      await expect(tap.route).resolves.toBe('no-track');
      tap.release();
    } finally {
      vi.useRealTimers();
    }
  });
});
