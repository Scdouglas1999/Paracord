import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RoomCard } from './RoomCard';
import { useVoiceStore } from '../../stores/voiceStore';
import { ChannelType, type Channel, type VoiceState } from '../../types';

function voiceChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'voice-1',
    guild_id: 'guild-1',
    name: 'Voice Lounge',
    type: ChannelType.Voice,
    position: 0,
    nsfw: false,
    created_at: new Date('2026-01-01T00:00:00Z').toISOString(),
    ...overrides,
  };
}

function vs(partial: Partial<VoiceState> & { user_id: string }): VoiceState {
  return {
    session_id: `session-${partial.user_id}`,
    deaf: false,
    mute: false,
    self_deaf: false,
    self_mute: false,
    self_stream: false,
    self_video: false,
    suppress: false,
    ...partial,
  };
}

function renderCard(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('RoomCard', () => {
  beforeEach(() => {
    useVoiceStore.getState().setWatchedStreamer(null);
  });

  it('renders the quiet/empty branch when no one is present', () => {
    renderCard(
      <RoomCard
        channel={voiceChannel()}
        participants={[]}
        speakingUsers={new Set()}
        guildId="guild-1"
      />,
    );
    expect(screen.getByText('Empty — start the room')).toBeTruthy();
  });

  it('renders the live branch with an occupant stack when occupied', () => {
    renderCard(
      <RoomCard
        channel={voiceChannel()}
        participants={[vs({ user_id: 'u1', username: 'Alice' })]}
        speakingUsers={new Set(['u1'])}
        guildId="guild-1"
      />,
    );
    expect(screen.queryByText('Empty — start the room')).toBeNull();
    expect(screen.getByTestId('occupant-u1')).toBeTruthy();
  });

  it('invokes joinChannel when Join is clicked', () => {
    const joinChannel = vi.fn().mockResolvedValue(undefined);
    useVoiceStore.setState({ joinChannel });

    renderCard(
      <RoomCard
        channel={voiceChannel()}
        participants={[vs({ user_id: 'u1', username: 'Alice' })]}
        speakingUsers={new Set()}
        guildId="guild-1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(joinChannel).toHaveBeenCalledWith('voice-1', 'guild-1');
  });

  it('invokes setWatchedStreamer when Watch is clicked on a streaming occupant', () => {
    renderCard(
      <RoomCard
        channel={voiceChannel()}
        participants={[vs({ user_id: 'u2', username: 'Streamer', self_stream: true })]}
        speakingUsers={new Set()}
        guildId="guild-1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: "Watch Streamer" }));
    expect(useVoiceStore.getState().watchedStreamerId).toBe('u2');
  });

  it('renders the stage branch for stage channels', () => {
    renderCard(
      <RoomCard
        channel={voiceChannel({ type: ChannelType.Stage, name: 'Main Stage' })}
        participants={[vs({ user_id: 'u1', username: 'Host', suppress: false })]}
        speakingUsers={new Set()}
        guildId="guild-1"
      />,
    );
    expect(screen.getByText('Main Stage')).toBeTruthy();
    expect(screen.getByText(/on stage/)).toBeTruthy();
  });
});
