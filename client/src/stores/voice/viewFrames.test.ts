import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaEngine } from '../../lib/media/mediaEngine';
import { useVoiceStore } from '../voiceStore';
import { subscribeViewFrames } from './viewFrames';
import type { MediaViewState } from './viewSessions';

function engine() {
  const releases: Array<ReturnType<typeof vi.fn>> = [];
  const value = {
    tapVideoFrames: vi.fn(() => {
      const release = vi.fn();
      releases.push(release);
      return { route: Promise.resolve('frames'), release };
    }),
  };
  return { engine: value as unknown as MediaEngine, mock: value, releases };
}

function view(patch: Partial<MediaViewState>): MediaViewState {
  return {
    id: 'v', kind: 'watch', scope: { serverId: 'A', userId: '1' }, guildId: 'g', channelId: 'c',
    streamerId: 'vincent', route: 'session', phase: 'live', engine: null, sessionId: 's',
    endReason: null, error: null, ...patch,
  };
}

afterEach(() => useVoiceStore.setState({ watchView: null }));

describe('sampling a view', () => {
  it('follows the watch from its own session onto the call and back, and stops when it is not live', async () => {
    const own = engine();
    const call = engine();
    const routes: string[] = [];
    useVoiceStore.setState({ watchView: view({ engine: own.engine }) });
    const stop = subscribeViewFrames(() => {}, { onRoute: (route) => routes.push(route) });
    expect(own.mock.tapVideoFrames).toHaveBeenCalledWith('vincent', 'screen', expect.any(Function));

    useVoiceStore.setState({ watchView: view({ engine: call.engine, route: 'call' }) });
    expect(own.releases[0]).toHaveBeenCalled();
    expect(call.mock.tapVideoFrames).toHaveBeenCalledTimes(1);

    await Promise.resolve();
    await Promise.resolve();
    expect(routes).toEqual(['frames', 'frames']);
    useVoiceStore.setState({ watchView: view({ engine: null, phase: 'connecting' }) });
    expect(call.releases[0]).toHaveBeenCalled();
    stop();
  });
});
