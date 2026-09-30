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
    expect(ipc.invoke).not.toHaveBeenCalledWith('media_list_session_participants', expect.anything());
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

describe('viewers in a native publisher’s roster', () => {
  it('does not tell the store about a viewer joining or leaving', async () => {
    const media = engine();
    const joins: string[] = [];
    const leaves: string[] = [];
    media.setPeerRoleResolver((id) => (id === '300' ? 'member' : 'viewer'));
    media.onParticipantJoin((id) => joins.push(id));
    media.onParticipantLeave((id) => leaves.push(id));
    await flush();
    const join = ipc.handlers.get(`media_participant_join:${media.sessionOwnerId}`)!;
    const leave = ipc.handlers.get(`media_participant_leave:${media.sessionOwnerId}`)!;
    join({ payload: '300' });
    join({ payload: '400' });
    expect(joins).toEqual(['300']);
    leave({ payload: { userId: '400' } });
    leave({ payload: { userId: '300' } });
    expect(leaves).toEqual(['300']);
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
