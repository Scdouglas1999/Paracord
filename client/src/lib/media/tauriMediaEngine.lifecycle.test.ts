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
