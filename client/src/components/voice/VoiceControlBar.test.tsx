import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { VoiceControlBar } from './VoiceControlBar';

// Mutable mock containers created before module mocks are hoisted.
const voiceHook = vi.hoisted(() => ({
  current: {} as {
    selfMute: boolean;
    selfDeaf: boolean;
    toggleMute: ReturnType<typeof vi.fn>;
    toggleDeaf: ReturnType<typeof vi.fn>;
    leaveChannel: ReturnType<typeof vi.fn>;
  },
}));
const streamHook = vi.hoisted(() => ({
  current: {} as {
    selfStream: boolean;
    startStream: ReturnType<typeof vi.fn>;
    stopStream: ReturnType<typeof vi.fn>;
  },
}));
const voiceState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const authState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('../../hooks/useVoice', () => ({ useVoice: () => voiceHook.current }));
vi.mock('../../hooks/useStream', () => ({ useStream: () => streamHook.current }));
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
vi.mock('../../lib/desktopDiagnostics', () => ({ logVoiceDiagnostic: vi.fn() }));

function setPttMode(enabled: boolean) {
  authState.current = {
    settings: enabled ? { notifications: { voiceInputMode: 'push_to_talk' } } : { notifications: {} },
  };
}

describe('VoiceControlBar', () => {
  beforeEach(() => {
    voiceHook.current = {
      selfMute: false,
      selfDeaf: false,
      toggleMute: vi.fn(),
      toggleDeaf: vi.fn(),
      leaveChannel: vi.fn().mockResolvedValue(undefined),
    };
    streamHook.current = {
      selfStream: false,
      startStream: vi.fn().mockResolvedValue(undefined),
      stopStream: vi.fn(),
    };
    voiceState.current = {
      streamAudioWarning: null,
      mediaEngine: null,
      pttEngaged: false,
    };
    setPttMode(false);
  });

  it('renders the mute button and dispatches toggleMute on click', () => {
    render(<VoiceControlBar />);
    const btn = screen.getByRole('button', { name: 'Mute microphone' });
    fireEvent.click(btn);
    expect(voiceHook.current.toggleMute).toHaveBeenCalledTimes(1);
  });

  it('reflects the muted state in the button label', () => {
    voiceHook.current.selfMute = true;
    render(<VoiceControlBar />);
    expect(screen.getByRole('button', { name: 'Unmute microphone' })).toBeInTheDocument();
  });

  it('does not dispatch toggleMute in push-to-talk mode', () => {
    setPttMode(true);
    render(<VoiceControlBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Push to talk muted' }));
    expect(voiceHook.current.toggleMute).not.toHaveBeenCalled();
  });

  it('shows the transmitting label when PTT is engaged', () => {
    setPttMode(true);
    voiceState.current.pttEngaged = true;
    render(<VoiceControlBar />);
    expect(
      screen.getByRole('button', { name: 'Transmitting with push to talk' }),
    ).toBeInTheDocument();
  });

  it('dispatches toggleDeaf and reflects the deafened label', () => {
    const { rerender } = render(<VoiceControlBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Deafen audio' }));
    expect(voiceHook.current.toggleDeaf).toHaveBeenCalledTimes(1);

    voiceHook.current.selfDeaf = true;
    rerender(<VoiceControlBar />);
    expect(screen.getByRole('button', { name: 'Undeafen audio' })).toBeInTheDocument();
  });

  it('dispatches leaveChannel from the disconnect button', () => {
    render(<VoiceControlBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect from voice' }));
    expect(voiceHook.current.leaveChannel).toHaveBeenCalledTimes(1);
  });

  it('starts a stream with the default quality when no native picker exists', async () => {
    render(<VoiceControlBar />);
    // handleStartStream is async (toggles the "starting" state around startStream),
    // so await the settle to avoid an act() warning on the trailing state update.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Share screen' }));
    });
    expect(streamHook.current.startStream).toHaveBeenCalledWith('1080p60', undefined);
  });

  it('shows stop-stream affordances and dispatches stopStream while streaming', () => {
    streamHook.current.selfStream = true;
    render(<VoiceControlBar />);
    const btn = screen.getByRole('button', { name: 'Stop streaming' });
    fireEvent.click(btn);
    expect(streamHook.current.stopStream).toHaveBeenCalledTimes(1);
  });

  it('surfaces a stream audio warning affordance', () => {
    voiceState.current.streamAudioWarning = 'System audio was not captured.';
    render(<VoiceControlBar />);
    const warnBtn = document.querySelector('button.text-amber-300') as HTMLButtonElement;
    expect(warnBtn).not.toBeNull();
    fireEvent.click(warnBtn);
    expect(screen.getByText('System audio was not captured.')).toBeInTheDocument();
  });

  it('renders the chat toggle only when a handler is provided and wires it up', () => {
    const onToggleChat = vi.fn();
    const { rerender } = render(<VoiceControlBar />);
    expect(screen.queryByRole('button', { name: /voice chat/i })).toBeNull();

    rerender(<VoiceControlBar onToggleChat={onToggleChat} isChatOpen={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show voice chat' }));
    expect(onToggleChat).toHaveBeenCalledTimes(1);
  });
});
