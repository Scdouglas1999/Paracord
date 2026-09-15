import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: ipc.invoke, Channel: class {} }));
vi.mock('@tauri-apps/api/event', () => ({ listen: ipc.listen }));
import { TauriMediaEngine } from './tauriMediaEngine';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
const engines: TauriMediaEngine[] = [];
function engine() { const value = new TauriMediaEngine(); engines.push(value); return value; }
beforeEach(() => {
  ipc.invoke.mockReset().mockResolvedValue([]);
  ipc.listen.mockReset().mockResolvedValue(vi.fn());
});
afterEach(async () => { await Promise.allSettled(engines.splice(0).map(value => value.disconnect())); });

describe('native adapter deferred ownership', () => {
  it('unregisters an event registration that returns after disconnect and ignores queued events', async () => {
    const registration = deferred<() => void>();
    const unlisten = vi.fn(); const participant = vi.fn();
    let deliver!: (event: { payload: unknown }) => void;
    ipc.listen.mockImplementation((_event, callback) => { deliver = callback; return registration.promise; });
    const old = engine(); old.onParticipantJoin(participant); await flush();
    expect(ipc.listen).toHaveBeenCalledWith(`media_participant_join:${old.sessionOwnerId}`, expect.any(Function));
    await old.disconnect();
    deliver({ payload: 'late-peer' }); registration.resolve(unlisten); await flush();
    expect(participant).not.toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(ipc.invoke).not.toHaveBeenCalledWith('stop_voice_session', expect.anything());
  });

  // The desktop engine owns the capture graph, so nothing in the webview can
  // measure the local microphone. Until it reported one, `micInputLevel` had no
  // writer on this engine at all and the level bar sat at zero for every call.
  it('reports the local microphone level so the meter has a writer', async () => {
    let deliver!: (event: { payload: unknown }) => void;
    ipc.listen.mockImplementation((_event, callback) => { deliver = callback; return Promise.resolve(vi.fn()); });
    const mic = vi.fn();
    const value = engine(); value.onLocalMicLevel(mic); await flush();
    expect(ipc.listen).toHaveBeenCalledWith(`media_local_mic_level:${value.sessionOwnerId}`, expect.any(Function));
    deliver({ payload: { audioLevel: 22, active: true } }); await flush();
    expect(mic).toHaveBeenCalledWith(22, true);
    // A microphone delivering nothing must read as inactive, not merely quiet.
    deliver({ payload: { audioLevel: 127, active: false } }); await flush();
    expect(mic).toHaveBeenLastCalledWith(127, false);
    // Malformed payloads are dropped rather than reported as silence.
    deliver({ payload: null }); await flush();
    expect(mic).toHaveBeenCalledTimes(2);
  });

  it('stops only the dispatched owner when a native connect result is late', async () => {
    const start = deferred<unknown>();
    ipc.invoke.mockImplementation((command) => command === 'start_voice_session' ? start.promise : Promise.resolve([]));
    const old = engine();
    const connect = old.connect('https://media.example/media', 'test-token', 'pin').catch(error => error);
    await flush();
    expect(ipc.invoke).toHaveBeenCalledWith('start_voice_session', expect.objectContaining({ ownerId: old.sessionOwnerId }));
    const next = engine(); next.setMute(true); await old.disconnect(); await flush();
    start.resolve({ connected: true });
    expect((await connect).message).toContain('ended');
    expect(ipc.invoke).toHaveBeenCalledWith('stop_voice_session', { ownerId: old.sessionOwnerId });
    expect(ipc.invoke).toHaveBeenCalledWith('voice_set_mute', { muted: true, ownerId: next.sessionOwnerId });
    expect(ipc.invoke).not.toHaveBeenCalledWith('stop_voice_session', { ownerId: next.sessionOwnerId });
  });

  it('does not dispatch camera enable when disable overtakes event registration', async () => {
    const registration = deferred<() => void>();
    ipc.listen.mockReturnValue(registration.promise);
    const media = engine();
    const enable = media.enableVideo(true).catch(error => error); await flush();
    await media.enableVideo(false);
    registration.resolve(vi.fn());
    expect((await enable).name).toBe('AbortError');
    expect(ipc.invoke).toHaveBeenCalledWith('voice_enable_video', expect.objectContaining({ enabled: false, actionRevision: 2, ownerId: media.sessionOwnerId }));
    expect(ipc.invoke).not.toHaveBeenCalledWith('voice_enable_video', expect.objectContaining({ enabled: true }));
  });
});

describe('native media certificate pin', () => {
  // The desktop engine has no in-engine reconnect: a lost connection surfaces
  // through `media_transport_lost` and the call is closed, so the next attempt
  // is a fresh join with a fresh pin. What must hold is that the engine never
  // substitutes a remembered pin for the one it was handed — after a server
  // rotation, a remembered pin names a certificate the media port no longer
  // presents and the pinned QUIC handshake fails closed.
  it('passes each join its own pin rather than reusing the previous one', async () => {
    ipc.invoke.mockImplementation((command) =>
      command === 'start_voice_session' ? Promise.resolve({ connected: true }) : Promise.resolve([]),
    );

    const first = engine();
    await first.connect('https://media.example/media', 'token-one', 'pin-one');
    expect(ipc.invoke).toHaveBeenCalledWith(
      'start_voice_session',
      expect.objectContaining({ certHash: 'pin-one', ownerId: first.sessionOwnerId }),
    );
    await first.disconnect();

    // The server rotated its media certificate between the two joins.
    const second = engine();
    await second.connect('https://media.example/media', 'token-two', 'pin-two');
    expect(ipc.invoke).toHaveBeenCalledWith(
      'start_voice_session',
      expect.objectContaining({ certHash: 'pin-two', ownerId: second.sessionOwnerId }),
    );
    expect(ipc.invoke).not.toHaveBeenCalledWith(
      'start_voice_session',
      expect.objectContaining({ certHash: 'pin-one', ownerId: second.sessionOwnerId }),
    );
  });

  it('refuses to start a session with no pin at all rather than dialling unpinned', async () => {
    const media = engine();
    await expect(media.connect('https://media.example/media', 'token', undefined)).rejects.toThrow(
      /certificate pin/i,
    );
    expect(ipc.invoke).not.toHaveBeenCalledWith('start_voice_session', expect.anything());
  });
});
