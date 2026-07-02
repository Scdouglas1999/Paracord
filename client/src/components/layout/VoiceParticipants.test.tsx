import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { VoiceParticipants } from './VoiceParticipants';
import { useVoiceStore } from '../../stores/voiceStore';
import { ChannelType, type Channel } from '../../types/index';

const channel: Channel = {
  id: 'voice-1',
  guild_id: 'guild-1',
  name: 'Voice Lounge',
  type: ChannelType.Voice,
  channel_type: ChannelType.Voice,
  position: 0,
  nsfw: false,
  created_at: new Date('2026-01-01T00:00:00Z').toISOString(),
};

describe('VoiceParticipants stream watching', () => {
  beforeEach(() => {
    useVoiceStore.getState().setWatchedStreamer(null);
  });

  it('marks a live participant as watched and navigates to the voice channel', () => {
    const navigate = vi.fn();

    render(
      <VoiceParticipants
        channel={channel}
        participants={[
          {
            user_id: 'user-2',
            username: 'Streamer',
            self_stream: true,
          },
        ]}
        speakingUsers={new Set()}
        guildId="guild-1"
        selectedGuildId={null}
        navigate={navigate}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: "Watch Streamer's stream" }));

    expect(useVoiceStore.getState().watchedStreamerId).toBe('user-2');
    expect(navigate).toHaveBeenCalledWith('/app/guilds/guild-1/channels/voice-1');
  });
});
