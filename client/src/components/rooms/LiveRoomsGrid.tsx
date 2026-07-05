import { useMemo } from 'react';
import { Radio, Volume2 } from 'lucide-react';
import { useVoiceStore } from '../../stores/voiceStore';
import { ChannelType, type Channel, type VoiceState } from '../../types';
import { RoomCard } from './RoomCard';

interface LiveRoomsGridProps {
  guildId: string;
  /** All of the guild's channels; voice + stage are selected internally. */
  channels: Channel[];
}

const EMPTY_PARTICIPANTS: VoiceState[] = [];

function isRoomChannel(channel: Channel): boolean {
  const type = channel.type ?? channel.channel_type;
  return type === ChannelType.Voice || type === ChannelType.Stage;
}

/**
 * The live-rooms grid — every voice/stage channel rendered as a RoomCard, with
 * occupied rooms surfaced first as full cards and quiet ones collapsed into
 * compact single-line rows (never dead tiles, kill-list #4/#5). Participants and
 * speaking state are derived from voiceStore so the grid updates live off
 * VOICE_STATE_UPDATE / speaking ticks without any polling.
 */
export function LiveRoomsGrid({ guildId, channels }: LiveRoomsGridProps) {
  const channelParticipants = useVoiceStore((s) => s.channelParticipants);
  const speakingUsers = useVoiceStore((s) => s.speakingUsers);

  const { live, quiet } = useMemo(() => {
    const rooms = channels.filter(isRoomChannel);
    const liveRooms: Channel[] = [];
    const quietRooms: Channel[] = [];
    for (const room of rooms) {
      if ((channelParticipants.get(room.id) || []).length > 0) {
        liveRooms.push(room);
      } else {
        quietRooms.push(room);
      }
    }
    return { live: liveRooms, quiet: quietRooms };
  }, [channels, channelParticipants]);

  // "Live rooms" is reserved for occupied rooms so the label agrees with the
  // GuildHomeHeader's occupied-only count; a section holding only quiet/empty
  // rooms is just "Rooms" (layout-spec §1.2).
  const heading = live.length > 0 ? 'Live rooms' : 'Rooms';

  if (live.length === 0 && quiet.length === 0) {
    // Left-aligned empty state (kill-list #4) — a real title + specific copy.
    return (
      <section aria-label={heading}>
        <SectionLabel>{heading}</SectionLabel>
        <div className="rounded-md border border-border-subtle bg-bg-secondary p-5 shadow-sm">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-sm bg-accent-tint text-accent-primary">
            <Volume2 size={18} />
          </div>
          <h3 className="text-subhead text-text-primary">No voice rooms yet</h3>
          <p className="mt-1 max-w-prose text-label text-text-secondary">
            Add a voice or stage channel and it will show up here the moment
            someone hops in.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section aria-label={heading} className="flex flex-col gap-4">
      <SectionLabel>{heading}</SectionLabel>

      {live.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {live.map((room) => (
            <RoomCard
              key={room.id}
              channel={room}
              participants={channelParticipants.get(room.id) || EMPTY_PARTICIPANTS}
              speakingUsers={speakingUsers}
              guildId={guildId}
            />
          ))}
        </div>
      )}

      {quiet.length > 0 && (
        <div className="flex flex-col gap-0.5 rounded-md border border-border-subtle bg-bg-secondary p-1.5 shadow-sm">
          {quiet.map((room) => (
            <RoomCard
              key={room.id}
              channel={room}
              participants={EMPTY_PARTICIPANTS}
              speakingUsers={speakingUsers}
              guildId={guildId}
              compact
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-section uppercase text-text-muted">
      <Radio size={14} className="text-interactive-normal" />
      {children}
    </div>
  );
}
