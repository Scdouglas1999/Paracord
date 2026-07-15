import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { StreamViewer } from './StreamViewer';

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

describe('StreamViewer', () => {
  beforeEach(() => {
    // No LiveKit room and no native media engine: the component renders its
    // control/placeholder branches without any real media attachment.
    voiceState.current = {
      room: null,
      mediaEngine: null,
      selfStream: false,
      systemAudioCaptureActive: false,
      showSystemAudioPrivacyWarning: false,
      acknowledgeSystemAudioPrivacyWarning: vi.fn(),
      previewStreamerId: null,
    };
    authState.current = { user: { id: 'me' } };

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

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
  });

  it('shows the unavailable placeholder when no track is active', () => {
    render(<StreamViewer streamerId="u2" streamerName="Alice" />);
    expect(screen.getByText('Stream is not available')).toBeInTheDocument();
    expect(
      screen.getByText('Alice is not currently publishing a stream track.'),
    ).toBeInTheDocument();
  });

  it('shows the connecting placeholder while expecting a stream', () => {
    render(<StreamViewer streamerId="u2" streamerName="Alice" expectingStream />);
    expect(screen.getByText('Starting stream...')).toBeInTheDocument();
    expect(screen.getByText('Connecting to the media server')).toBeInTheDocument();
  });

  it('reveals the issue message when the warning affordance is toggled', () => {
    render(
      <StreamViewer streamerId="u2" streamerName="Alice" issueMessage="Encoder unavailable." />,
    );
    expect(screen.queryByText('Encoder unavailable.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show stream warning' }));
    expect(screen.getByText('Encoder unavailable.')).toBeInTheDocument();
  });

  it('portals stream warning details to document.body (above native underlay)', () => {
    render(
      <div data-testid="mount">
        <StreamViewer streamerId="u2" streamerName="Alice" issueMessage="Encoder unavailable." />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show stream warning' }));
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('data-stream-overlay-portal');
    expect(status.parentElement).toBe(document.body);
    expect(screen.getByTestId('mount').contains(status)).toBe(false);
  });

  it('dismisses portaled stream warning details on outside pointerdown', () => {
    render(
      <div>
        <StreamViewer streamerId="u2" streamerName="Alice" issueMessage="Encoder unavailable." />
        <button type="button">Outside</button>
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show stream warning' }));
    expect(screen.getByText('Encoder unavailable.')).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.queryByText('Encoder unavailable.')).toBeNull();
  });

  it('wires the stop-watching control', () => {
    const onStopWatching = vi.fn();
    render(
      <StreamViewer streamerId="u2" streamerName="Alice" onStopWatching={onStopWatching} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop watching stream' }));
    expect(onStopWatching).toHaveBeenCalledTimes(1);
  });

  it('shows and wires the stop-stream control while self streaming', () => {
    const onStopStream = vi.fn();
    voiceState.current.selfStream = true;
    render(
      <StreamViewer streamerId="u2" streamerName="Alice" onStopStream={onStopStream} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop streaming' }));
    expect(onStopStream).toHaveBeenCalledTimes(1);
  });

  it('does not render a stop-stream control when not streaming', () => {
    const onStopStream = vi.fn();
    render(
      <StreamViewer streamerId="u2" streamerName="Alice" onStopStream={onStopStream} />,
    );
    expect(screen.queryByRole('button', { name: 'Stop streaming' })).toBeNull();
  });

  it('toggles the maximize control label', () => {
    render(<StreamViewer streamerId="u2" streamerName="Alice" />);
    const btn = screen.getByRole('button', { name: 'Maximize stream viewer' });
    fireEvent.click(btn);
    expect(
      screen.getByRole('button', { name: 'Restore stream viewer' }),
    ).toBeInTheDocument();
  });

  it('dismisses stream warning details on Escape before leaving maximize', () => {
    render(
      <StreamViewer
        streamerId="u1"
        streamerName="You"
        issueMessage="Encoder stalled"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Maximize stream viewer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show stream warning' }));
    expect(screen.getByText('Encoder stalled')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Encoder stalled')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Restore stream viewer' }),
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(
      screen.getByRole('button', { name: 'Maximize stream viewer' }),
    ).toBeInTheDocument();
  });

  it('surfaces the system audio badge when capture is active', () => {
    voiceState.current.systemAudioCaptureActive = true;
    render(<StreamViewer streamerId="u2" streamerName="Alice" />);
    expect(screen.getByText('System Audio')).toBeInTheDocument();
  });

  it('shows the privacy warning and acknowledges it', () => {
    voiceState.current.showSystemAudioPrivacyWarning = true;
    render(<StreamViewer streamerId="u2" streamerName="Alice" />);
    expect(screen.getByText('System Audio Capture Is Active')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'I understand' }));
    expect(voiceState.current.acknowledgeSystemAudioPrivacyWarning).toHaveBeenCalledTimes(1);
  });

  it('mounts the native media viewer without calling hooks from effects', () => {
    const unsubscribeVideo = vi.fn();
    const unsubscribeAudio = vi.fn();
    const mediaEngine = {
      subscribeVideo: vi.fn(() => unsubscribeVideo),
      subscribeScreenShareAudio: vi.fn(() => unsubscribeAudio),
      setSourceVolume: vi.fn(),
      listPublishedTracks: vi.fn().mockResolvedValue([]),
      registerTrackSubscription: vi.fn(),
    };
    voiceState.current.mediaEngine = mediaEngine;

    const { unmount } = render(<StreamViewer streamerId="u2" streamerName="Alice" />);

    expect(mediaEngine.subscribeVideo).toHaveBeenCalledWith(
      'u2',
      expect.any(HTMLCanvasElement),
      expect.any(Function),
    );
    expect(mediaEngine.subscribeScreenShareAudio).toHaveBeenCalledWith(
      'u2',
      expect.any(Function),
    );

    unmount();
    expect(unsubscribeVideo).toHaveBeenCalledTimes(1);
    expect(unsubscribeAudio).toHaveBeenCalledTimes(1);
  });

  it('forwards mute/unmute to mediaEngine.setSourceVolume on both engines', () => {
    const mediaEngine = {
      subscribeVideo: vi.fn(() => vi.fn()),
      subscribeScreenShareAudio: vi.fn(() => vi.fn()),
      setSourceVolume: vi.fn(),
      listPublishedTracks: vi.fn().mockResolvedValue([]),
      registerTrackSubscription: vi.fn(),
    };
    voiceState.current.mediaEngine = mediaEngine;

    render(<StreamViewer streamerId="u2" streamerName="Alice" />);

    fireEvent.click(screen.getByTitle('Mute'));
    expect(mediaEngine.setSourceVolume).toHaveBeenCalledWith('u2', 0);

    fireEvent.click(screen.getByTitle('Unmute'));
    expect(mediaEngine.setSourceVolume).toHaveBeenCalledWith('u2', 1);
  });
});
