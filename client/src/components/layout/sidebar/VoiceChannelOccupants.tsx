import { useNavigate } from 'react-router-dom';
import { useGuildStore } from '../../../stores/guildStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import type { ConversationEntry } from '../../../lib/attention/conversationModel';
import { ChannelType, type Channel } from '../../../types/index';
import { VoiceParticipants } from '../VoiceParticipants';

/**
 * Nested occupant list under a voice ConversationRow. Reuses VoiceParticipants so
 * sidebar LIVE / mute / camera affordances stay in one place.
 */
export function VoiceChannelOccupants({ entry }: { entry: ConversationEntry }) {
  if (entry.kind !== 'voice') return null;
  return <VoiceChannelOccupantsInner entry={entry} />;
}

function VoiceChannelOccupantsInner({ entry }: { entry: ConversationEntry }) {
  const navigate = useNavigate();
  const selectedGuildId = useGuildStore((s) => s.selectedGuildId);
  const participants = useVoiceStore((s) => s.channelParticipants.get(entry.channelId) ?? EMPTY);
  const speakingUsers = useVoiceStore((s) => s.speakingUsers);

  if (participants.length === 0) return null;

  const channel: Channel = {
    id: entry.channelId,
    guild_id: entry.guildId ?? '',
    name: entry.title,
    type: ChannelType.Voice,
    channel_type: ChannelType.Voice,
    position: 0,
    nsfw: false,
    created_at: '',
  };

  return (
    <VoiceParticipants
      channel={channel}
      participants={participants}
      speakingUsers={speakingUsers}
      guildId={entry.guildId ?? undefined}
      selectedGuildId={selectedGuildId}
      navigate={navigate}
    />
  );
}

const EMPTY: never[] = [];
