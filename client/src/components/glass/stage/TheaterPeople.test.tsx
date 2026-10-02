import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MediaEngine } from '../../../lib/media/mediaEngine';
import type { StagePerson } from './stageModel';
import { TALKER_HOLD_MS, TheaterPeople } from './TheaterPeople';

/**
 * The people in theater (docs/glass-spec.md §6.2): only the talker gets a tile;
 * everyone else a face with a ring and, when muted, a mic-off badge.
 */

vi.mock('../../../api/files', () => ({
  fileApi: { resolveAttachmentObjectUrl: vi.fn(async () => 'blob:face') },
}));

function person(userId: string, over: Partial<StagePerson> = {}): StagePerson {
  return {
    userId,
    name: userId[0].toUpperCase() + userId.slice(1),
    avatar: null,
    self: false,
    listening: false,
    muted: false,
    sharing: false,
    streamStartedAt: null,
    talking: false,
    camera: false,
    ...over,
  };
}

const VINCENT = person('vincent', { sharing: true });
const BRENDAN = person('brendan', { camera: true, talking: true });
const NICK = person('nick', { muted: true });
const LUKE = person('luke', { sharing: true });

function renderPeople(people: StagePerson[], onSwitch = vi.fn()) {
  const view = (list: StagePerson[]) => (
    <TheaterPeople people={list} callEngine={null} joined={false} realVoice={false} watchedId="vincent" onSwitch={onSwitch} />
  );
  const result = render(view(people));
  return { ...result, update: (list: StagePerson[]) => result.rerender(view(list)), onSwitch };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('TheaterPeople', () => {
  it("draws the talker's camera filling its tile once joined", () => {
    const subscribeVideo = vi.fn(() => () => {});
    const engine = { subscribeVideo } as unknown as MediaEngine;
    render(
      <TheaterPeople people={[BRENDAN, VINCENT]} callEngine={engine} joined realVoice={false} watchedId="vincent" onSwitch={vi.fn()} />,
    );
    expect(subscribeVideo).toHaveBeenCalledTimes(1);
    expect(subscribeVideo).toHaveBeenCalledWith('brendan', expect.any(HTMLCanvasElement), expect.any(Function), {
      preferredTrackId: 'camera',
      fit: 'cover',
      anchor: { x: 0.5, y: 0.35 },
    });
  });

  it('gives the talker the tile and everyone else a face, rings and mic-off included', () => {
    renderPeople([BRENDAN, VINCENT, NICK]);
    const tiles = document.querySelectorAll('.glass-stage__tile');
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toHaveTextContent('Brendan');
    expect(tiles[0]).toHaveAttribute('data-talking', 'true');
    const faces = document.querySelectorAll('.glass-theater__face');
    expect(faces).toHaveLength(2);
    expect(faces[0]).toHaveAttribute('data-ring', 'amber');
    expect(faces[1]).toHaveAttribute('data-ring', 'faint');
    expect(faces[1].querySelector('.glass-theater__mic')).not.toBeNull();
    expect(screen.getByText('Nick, Muted')).toBeInTheDocument();
  });

  it('keeps the tile a moment after the talker stops, then everyone is a face', () => {
    vi.useFakeTimers();
    const view = renderPeople([BRENDAN, VINCENT, NICK]);
    view.update([{ ...BRENDAN, talking: false }, VINCENT, NICK]);
    expect(document.querySelectorAll('.glass-stage__tile')).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(TALKER_HOLD_MS + 10);
    });
    expect(document.querySelectorAll('.glass-stage__tile')).toHaveLength(0);
    expect(document.querySelectorAll('.glass-theater__face')).toHaveLength(3);
  });

  it("a new talker takes the tile at once; another sharer's face switches the watch", () => {
    const view = renderPeople([BRENDAN, VINCENT, NICK, LUKE]);
    view.update([{ ...BRENDAN, talking: false }, VINCENT, { ...NICK, talking: true }, LUKE]);
    expect(document.querySelector('.glass-stage__tile')).toHaveTextContent('Nick');
    fireEvent.click(screen.getByRole('button', { name: "Watch Luke's screen" }));
    expect(view.onSwitch).toHaveBeenCalledWith('luke');
    // The one being watched is not a button.
    expect(screen.queryByRole('button', { name: "Watch Vincent's screen" })).not.toBeInTheDocument();
  });
});
