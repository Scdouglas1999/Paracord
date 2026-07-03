import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Track } from 'livekit-client';
import { VideoGrid } from './VideoGrid';

const voiceState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const authState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(voiceState.current),
    { getState: () => voiceState.current },
  ),
}));
vi.mock('../../stores/authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(authState.current),
    { getState: () => authState.current },
  ),
}));

type PubOpts = { source?: Track.Source; muted?: boolean; subscribed?: boolean; ended?: boolean };

function makePub(opts: PubOpts = {}) {
  const { source = Track.Source.Camera, muted = false, subscribed = true, ended = false } = opts;
  const mediaStreamTrack = {
    readyState: ended ? 'ended' : 'live',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return {
    source,
    isMuted: muted,
    isSubscribed: subscribed,
    setSubscribed: vi.fn(),
    track: { mediaStreamTrack, attach: vi.fn(), detach: vi.fn() },
  };
}

function makeRemote(identity: string, name: string, pubs: ReturnType<typeof makePub>[]) {
  return {
    identity,
    name,
    videoTrackPublications: new Map(pubs.map((p, i) => [`${identity}-${i}`, p])),
    audioTrackPublications: new Map(),
  };
}

function makeRoom(opts: {
  localPubs?: ReturnType<typeof makePub>[];
  remotes?: ReturnType<typeof makeRemote>[];
} = {}) {
  const { localPubs = [], remotes = [] } = opts;
  const localCamera = localPubs.find((p) => p.source === Track.Source.Camera) ?? null;
  return {
    localParticipant: {
      identity: 'me',
      name: 'Me',
      videoTrackPublications: new Map(localPubs.map((p, i) => [`local-${i}`, p])),
      getTrackPublication: (source: Track.Source) =>
        source === Track.Source.Camera ? localCamera : null,
    },
    remoteParticipants: new Map(remotes.map((r) => [r.identity, r])),
    on: vi.fn(),
    off: vi.fn(),
  };
}

describe('VideoGrid', () => {
  beforeEach(() => {
    voiceState.current = { room: null, connected: false, speakingUsers: new Set<string>() };
    authState.current = { user: null };

    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    if (typeof globalThis.MediaStream === 'undefined') {
      // Minimal MediaStream shim: VideoGrid wraps a local track in one.
      (globalThis as unknown as { MediaStream: unknown }).MediaStream = class {
        constructor(public tracks: unknown[] = []) {}
      };
    }
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  });

  it('renders nothing when there is no room', () => {
    const { container } = render(<VideoGrid />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when connected but no camera tracks are live', () => {
    voiceState.current.room = makeRoom();
    voiceState.current.connected = true;
    const { container } = render(<VideoGrid />);
    expect(container).toBeEmptyDOMElement();
  });

  it('ignores screenshare-only participants (camera-only grid)', () => {
    voiceState.current.room = makeRoom({
      remotes: [makeRemote('u2', 'Screenshare Only', [makePub({ source: Track.Source.ScreenShare })])],
    });
    voiceState.current.connected = true;
    const { container } = render(<VideoGrid />);
    expect(container).toBeEmptyDOMElement();
  });

  it('excludes muted and ended camera tracks', () => {
    voiceState.current.room = makeRoom({
      remotes: [
        makeRemote('u2', 'Muted', [makePub({ muted: true })]),
        makeRemote('u3', 'Ended', [makePub({ ended: true })]),
      ],
    });
    voiceState.current.connected = true;
    const { container } = render(<VideoGrid />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders one tile per live remote camera participant', () => {
    voiceState.current.room = makeRoom({
      remotes: [makeRemote('u2', 'Alice', [makePub()])],
    });
    voiceState.current.connected = true;
    render(<VideoGrid />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(document.querySelectorAll('video')).toHaveLength(1);
  });

  it('subscribes to unsubscribed remote camera publications', () => {
    const pub = makePub({ subscribed: false });
    voiceState.current.room = makeRoom({ remotes: [makeRemote('u2', 'Alice', [pub])] });
    voiceState.current.connected = true;
    render(<VideoGrid />);
    expect(pub.setSubscribed).toHaveBeenCalledWith(true);
  });

  it('lays out multiple participants in a two-column grid', () => {
    voiceState.current.room = makeRoom({
      remotes: [
        makeRemote('u2', 'Alice', [makePub()]),
        makeRemote('u3', 'Bob', [makePub()]),
      ],
    });
    voiceState.current.connected = true;
    const { container } = render(<VideoGrid />);
    expect(document.querySelectorAll('video')).toHaveLength(2);
    const grid = container.querySelector('div.grid') as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe('repeat(2, 1fr)');
  });

  it('includes the local camera tile', () => {
    authState.current = { user: { id: 'me' } };
    voiceState.current.room = makeRoom({ localPubs: [makePub()] });
    voiceState.current.connected = true;
    render(<VideoGrid />);
    // currentUserId matches the local identity, so the tile is labelled "You".
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(document.querySelectorAll('video')).toHaveLength(1);
  });

  it('uses the compact layout container when requested', () => {
    voiceState.current.room = makeRoom({ remotes: [makeRemote('u2', 'Alice', [makePub()])] });
    voiceState.current.connected = true;
    const { container } = render(<VideoGrid layout="compact" />);
    expect(container.querySelector('div.overflow-x-auto')).not.toBeNull();
  });
});
