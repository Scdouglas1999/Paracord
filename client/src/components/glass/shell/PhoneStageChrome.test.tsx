import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useGlassStore, type StageTarget } from '../../../stores/glassStore';
import { useToastStore } from '../../../stores/toastStore';
import type { StageModel } from '../stage/stageModel';
import { PhoneStageChrome } from './PhoneStageChrome';

const clipMock = vi.hoisted(() => ({
  available: true,
  unavailableReason: null as string | null,
  saving: false,
  clip: vi.fn(() => Promise.resolve()),
}));
const dataMock = vi.hoisted(() => ({
  watchers: 2,
  controls: 'not-joined' as 'joined' | 'not-joined',
}));
const stopWatching = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/media/clips/useClip', () => ({ useClip: () => clipMock }));
vi.mock('../stage/useStageWatch', () => ({ stopWatching }));
vi.mock('../stage/useStageData', () => ({
  useStageData: () => ({
    watchers: dataMock.watchers,
    model: {
      label: "Vincent's screen",
      streamerName: 'Vincent',
      channelName: 'Lounge',
      controls: dataMock.controls,
    } as unknown as StageModel,
  }),
}));
vi.mock('../stage/StageControls', () => ({
  StageControls: ({ fit }: { fit: number }) => (
    <div role="group" aria-label="Call controls" data-fit={fit} />
  ),
}));

const TARGET: StageTarget = { serverId: 'local', guildId: 'g1', channelId: 'lounge', streamerId: 'vincent' };

beforeEach(() => {
  clipMock.available = true;
  clipMock.unavailableReason = null;
  clipMock.saving = false;
  clipMock.clip.mockReset();
  clipMock.clip.mockResolvedValue(undefined);
  stopWatching.mockReset();
  dataMock.watchers = 2;
  dataMock.controls = 'not-joined';
  useToastStore.setState({ toasts: [] });
  useGlassStore.getState().reset();
  useGlassStore.getState().openStage(TARGET, 'side');
});

describe('PhoneStageChrome, the stream card', () => {
  it('says whose screen it is and how many are watching (screens/07)', () => {
    render(<PhoneStageChrome target={TARGET} mode="side" />);
    expect(screen.getByText("Vincent's screen")).toBeInTheDocument();
    expect(screen.getByText('2 watching')).toBeInTheDocument();
  });

  it('counts nobody until the server has', () => {
    dataMock.watchers = 0;
    render(<PhoneStageChrome target={TARGET} mode="side" />);
    expect(screen.queryByText(/watching/)).not.toBeInTheDocument();
  });

  it('back is Stop watching: the stage closes and the call is left alone', () => {
    render(<PhoneStageChrome target={TARGET} mode="side" />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop watching' }));
    expect(stopWatching).toHaveBeenCalledTimes(1);
  });

  it('Clip "30s" saves the last 30 seconds', () => {
    render(<PhoneStageChrome target={TARGET} mode="side" />);
    const clip = screen.getByRole('button', { name: 'Clip the last 30 seconds' });
    expect(clip).toHaveTextContent('30s');
    fireEvent.click(clip);
    expect(clipMock.clip).toHaveBeenCalledTimes(1);
  });

  it('says why a clip cannot be cut instead of pretending, and cuts nothing', () => {
    clipMock.available = false;
    clipMock.unavailableReason = 'Waiting for Vincent\'s screen.';
    render(<PhoneStageChrome target={TARGET} mode="side" />);
    const clip = screen.getByRole('button', { name: 'Clip the last 30 seconds' });
    expect(clip).toHaveAttribute('aria-disabled', 'true');
    expect(clip).toHaveAttribute('title', "Waiting for Vincent's screen.");
    fireEvent.click(clip);
    expect(clipMock.clip).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toContain("Waiting for Vincent's screen.");
  });

  it('toasts the reason a clip failed', async () => {
    clipMock.clip.mockRejectedValue(new Error('The clip is over the upload limit.'));
    render(<PhoneStageChrome target={TARGET} mode="side" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clip the last 30 seconds' }));
    });
    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toContain('The clip is over the upload limit.');
  });

  it('full screen is the phone\'s theater', () => {
    render(<PhoneStageChrome target={TARGET} mode="side" />);
    const button = screen.getByRole('button', { name: 'Full screen' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(button);
    expect(useGlassStore.getState().stage.mode).toBe('theater');
  });

  it('draws no controls capsule on the card', () => {
    render(<PhoneStageChrome target={TARGET} mode="side" />);
    expect(screen.queryByRole('group', { name: 'Call controls' })).not.toBeInTheDocument();
  });
});

describe('PhoneStageChrome, full screen', () => {
  beforeEach(() => useGlassStore.getState().setStageMode('theater'));

  it('back leaves full screen and keeps watching', () => {
    render(<PhoneStageChrome target={TARGET} mode="theater" />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Exit full screen' })[0]);
    expect(useGlassStore.getState().stage.mode).toBe('side');
    expect(stopWatching).not.toHaveBeenCalled();
  });

  it('floats the stage\'s own controls as a capsule over the stream', () => {
    render(<PhoneStageChrome target={TARGET} mode="theater" />);
    expect(screen.getByRole('group', { name: 'Call controls' })).toBeInTheDocument();
  });

  it('has no second Clip button above the capsule\'s own', () => {
    render(<PhoneStageChrome target={TARGET} mode="theater" />);
    expect(screen.queryByRole('button', { name: 'Clip the last 30 seconds' })).not.toBeInTheDocument();
  });

  it('Esc goes back to the card first, and is taken before the stage\'s own Esc (stop watching)', () => {
    const stageEsc = vi.fn((event: KeyboardEvent) => {
      if (!event.defaultPrevented) stopWatching();
    });
    window.addEventListener('keydown', stageEsc);
    render(<PhoneStageChrome target={TARGET} mode="theater" />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(useGlassStore.getState().stage.mode).toBe('side');
    expect(stopWatching).not.toHaveBeenCalled();
    window.removeEventListener('keydown', stageEsc);
  });

  it('leaves Esc to a field or a sheet, and to the card (which stops watching)', () => {
    const { unmount } = render(<PhoneStageChrome target={TARGET} mode="theater" />);
    const field = document.createElement('input');
    document.body.append(field);
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(useGlassStore.getState().stage.mode).toBe('theater');
    field.remove();

    act(() => useGlassStore.getState().openSheet('search'));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(useGlassStore.getState().stage.mode).toBe('theater');
    act(() => useGlassStore.getState().closeSheet());
    unmount();

    // On the card the key is not claimed at all.
    useGlassStore.getState().setStageMode('side');
    render(<PhoneStageChrome target={TARGET} mode="side" />);
    const claimed = vi.fn();
    window.addEventListener('keydown', claimed);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(claimed.mock.calls[0]?.[0].defaultPrevented).toBe(false);
    window.removeEventListener('keydown', claimed);
  });

  it('the full screen button is the way out too, and says so', () => {
    render(<PhoneStageChrome target={TARGET} mode="theater" />);
    const exits = screen.getAllByRole('button', { name: 'Exit full screen' });
    expect(exits).toHaveLength(2);
    expect(exits[1]).toHaveAttribute('aria-pressed', 'true');
  });
});
