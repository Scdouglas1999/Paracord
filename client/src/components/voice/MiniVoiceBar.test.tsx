import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MiniVoiceBar } from './MiniVoiceBar';

const navigateSpy = vi.hoisted(() => vi.fn());
const voiceHook = vi.hoisted(() => ({
  current: {} as {
    toggleMute: ReturnType<typeof vi.fn>;
    toggleDeaf: ReturnType<typeof vi.fn>;
  },
}));
const voiceState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const channelState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const authState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('react-router-dom', () => ({ useNavigate: () => navigateSpy }));
vi.mock('../../hooks/useVoice', () => ({ useVoice: () => voiceHook.current }));
vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(voiceState.current),
    { getState: () => voiceState.current },
  ),
}));
vi.mock('../../stores/channelStore', () => ({
  useChannelStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(channelState.current),
    { getState: () => channelState.current },
  ),
}));
vi.mock('../../stores/authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(authState.current),
    { getState: () => authState.current },
  ),
}));

function setPttMode(enabled: boolean) {
  authState.current = {
    settings: enabled ? { notifications: { voiceInputMode: 'push_to_talk' } } : { notifications: {} },
  };
}

describe('MiniVoiceBar', () => {
  beforeEach(() => {
    navigateSpy.mockClear();
    voiceHook.current = { toggleMute: vi.fn(), toggleDeaf: vi.fn() };
    voiceState.current = {
      channelId: 'chan-1',
      guildId: 'guild-1',
      selfMute: false,
      selfDeaf: false,
      pttEngaged: false,
      leaveChannel: vi.fn().mockResolvedValue(undefined),
    };
    channelState.current = { channels: [{ id: 'chan-1', name: 'General Voice' }] };
    setPttMode(false);
  });

  it('renders the connected state with the resolved channel name', () => {
    render(<MiniVoiceBar />);
    expect(screen.getByText('Voice Connected')).toBeInTheDocument();
    expect(screen.getByText('General Voice')).toBeInTheDocument();
  });

  it('falls back to a generic channel name when the channel is unknown', () => {
    channelState.current = { channels: [] };
    render(<MiniVoiceBar />);
    expect(screen.getByText('Voice Channel')).toBeInTheDocument();
  });

  it('navigates to the voice channel when the connection info is clicked', () => {
    render(<MiniVoiceBar />);
    fireEvent.click(screen.getByText('Voice Connected'));
    expect(navigateSpy).toHaveBeenCalledWith('/app/guilds/guild-1/channels/chan-1');
  });

  it('does not navigate when guild or channel context is missing', () => {
    voiceState.current.guildId = null;
    render(<MiniVoiceBar />);
    fireEvent.click(screen.getByText('Voice Connected'));
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('wires the mute control and reflects the muted label', () => {
    const { rerender } = render(<MiniVoiceBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    expect(voiceHook.current.toggleMute).toHaveBeenCalledTimes(1);

    voiceState.current.selfMute = true;
    rerender(<MiniVoiceBar />);
    expect(screen.getByRole('button', { name: 'Unmute' })).toBeInTheDocument();
  });

  it('disables the mute control in push-to-talk mode', () => {
    setPttMode(true);
    render(<MiniVoiceBar />);
    const btn = screen.getByRole('button', { name: 'Push to Talk (muted)' });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(voiceHook.current.toggleMute).not.toHaveBeenCalled();
  });

  it('wires the deafen control and reflects the deafened label', () => {
    const { rerender } = render(<MiniVoiceBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Deafen' }));
    expect(voiceHook.current.toggleDeaf).toHaveBeenCalledTimes(1);

    voiceState.current.selfDeaf = true;
    rerender(<MiniVoiceBar />);
    expect(screen.getByRole('button', { name: 'Undeafen' })).toBeInTheDocument();
  });

  it('dispatches leaveChannel from the disconnect button', () => {
    render(<MiniVoiceBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(voiceState.current.leaveChannel).toHaveBeenCalledTimes(1);
  });
});
