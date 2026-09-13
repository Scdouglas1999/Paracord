import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Track } from 'livekit-client';

import { StageSpeakers } from './StageSpeakers';
import { personLight } from '../../lib/attention/light';
import type { RoomOccupant } from '../../lib/attention/light';

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

function occupant(
  userId: string,
  name: string,
  over: Partial<Omit<RoomOccupant, 'person'>> = {},
): RoomOccupant {
  return {
    person: personLight({ userId, name, status: 'online', inRoom: true, roomName: 'Shop floor' }),
    speaking: false,
    muted: false,
    sharingScreen: false,
    sharingCamera: false,
    ...over,
  };
}

describe('StageSpeakers', () => {
  beforeEach(() => {
    voiceState.current = { room: null, mediaEngine: null, connected: false, speakingUsers: new Set<string>(), participants: new Map(), selfVideo: false };
    authState.current = { user: null };
    if (typeof globalThis.MediaStream === 'undefined') {
      (globalThis as unknown as { MediaStream: unknown }).MediaStream = class {
        constructor(public tracks: unknown[] = []) {}
      };
    }
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  });

  it('renders nothing when nobody is in the room', () => {
    const { container } = render(<StageSpeakers occupants={[]} currentUserId={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('gives everybody in the room a tile, camera or no camera', () => {
    render(
      <StageSpeakers
        occupants={[occupant('u2', 'Alice Brand'), occupant('u3', 'Bob Carr', { muted: true })]}
        currentUserId={null}
      />,
    );
    expect(screen.getByText('Alice Brand')).toBeInTheDocument();
    expect(screen.getByText('Bob Carr')).toBeInTheDocument();
    expect(screen.getByText('· muted')).toBeInTheDocument();
    // Nobody is publishing a camera, so nothing paints frames.
    expect(document.querySelectorAll('video')).toHaveLength(0);
  });

  it('attaches a video surface for a live remote camera', () => {
    voiceState.current.room = makeRoom({ remotes: [makeRemote('u2', 'Alice', [makePub()])] });
    voiceState.current.connected = true;
    render(<StageSpeakers occupants={[occupant('u2', 'Alice Brand')]} currentUserId={null} />);
    expect(document.querySelectorAll('video')).toHaveLength(1);
  });

  it('subscribes to an unsubscribed remote camera publication', () => {
    const pub = makePub({ subscribed: false });
    voiceState.current.room = makeRoom({ remotes: [makeRemote('u2', 'Alice', [pub])] });
    voiceState.current.connected = true;
    render(<StageSpeakers occupants={[occupant('u2', 'Alice Brand')]} currentUserId={null} />);
    expect(pub.setSubscribed).toHaveBeenCalledWith(true);
  });

  it('ignores a screenshare-only publisher — the strip is cameras', () => {
    voiceState.current.room = makeRoom({
      remotes: [makeRemote('u2', 'Screenshare Only', [makePub({ source: Track.Source.ScreenShare })])],
    });
    voiceState.current.connected = true;
    render(<StageSpeakers occupants={[occupant('u2', 'Alice Brand')]} currentUserId={null} />);
    expect(document.querySelectorAll('video')).toHaveLength(0);
    expect(screen.getByText('Alice Brand’s camera is off')).toBeInTheDocument();
  });

  it('excludes muted and ended camera tracks', () => {
    voiceState.current.room = makeRoom({
      remotes: [
        makeRemote('u2', 'Muted', [makePub({ muted: true })]),
        makeRemote('u3', 'Ended', [makePub({ ended: true })]),
      ],
    });
    voiceState.current.connected = true;
    render(
      <StageSpeakers
        occupants={[occupant('u2', 'Alice Brand'), occupant('u3', 'Bob Carr')]}
        currentUserId={null}
      />,
    );
    expect(document.querySelectorAll('video')).toHaveLength(0);
  });

  it('calls you "You" on your own tile', () => {
    render(<StageSpeakers occupants={[occupant('me', 'Sam Douglas')]} currentUserId="me" />);
    expect(screen.getByText('You')).toBeInTheDocument();
  });

  it('offers a Watch action on a sharer who is not already on the dominant tile', async () => {
    const onWatch = vi.fn();
    const { rerender } = render(
      <StageSpeakers
        occupants={[occupant('u2', 'Alice Brand', { sharingScreen: true })]}
        currentUserId={null}
        onWatch={onWatch}
      />,
    );
    screen.getByRole('button', { name: 'Watch' }).click();
    expect(onWatch).toHaveBeenCalledWith('u2');

    rerender(
      <StageSpeakers
        occupants={[occupant('u2', 'Alice Brand', { sharingScreen: true })]}
        currentUserId={null}
        onWatch={onWatch}
        watchingUserId="u2"
      />,
    );
    expect(screen.queryByRole('button', { name: 'Watch' })).toBeNull();
  });

  it('lays the picture-in-picture cluster out as a floating row', () => {
    const { container } = render(
      <StageSpeakers
        occupants={[occupant('u2', 'Alice Brand'), occupant('u3', 'Bob Carr')]}
        currentUserId={null}
        arrangement="pip"
      />,
    );
    expect(container.querySelector('ul.pc-floating')).not.toBeNull();
    expect(screen.getAllByText(/camera is off/)).toHaveLength(2);
  });
});
