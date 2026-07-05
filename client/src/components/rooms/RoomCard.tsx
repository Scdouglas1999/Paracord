import { useNavigate } from 'react-router-dom';
import { Hash, Play, Radio, Users, Volume2 } from 'lucide-react';
import { useVoice } from '../../hooks/useVoice';
import { useVoiceStore } from '../../stores/voiceStore';
import { ChannelType, type Channel, type VoiceState } from '../../types';
import { OccupantStack } from './OccupantStack';

interface RoomCardProps {
  channel: Channel;
  /** Occupants of this room — caller reads voiceStore.channelParticipants.get(channel.id). */
  participants: VoiceState[];
  speakingUsers: Set<string>;
  guildId: string;
  /** Override the default join behavior (useVoice().joinChannel). */
  onJoin?: () => void;
  /** Override the default watch behavior (setWatchedStreamer + navigate). */
  onWatch?: (streamerId: string) => void;
  /** Force the dense single-line presentation regardless of occupancy. */
  compact?: boolean;
}

function channelName(channel: Channel): string {
  return channel.name || 'Room';
}

/**
 * Presence-first room card. Renders four states derived from the passed
 * participants: LIVE (occupied voice), QUIET/EMPTY (compact single-line row),
 * STAGE (channel.type === Stage, speakers vs audience), and STREAM (an occupant
 * is sharing — surfaces a Watch action). Tokens only, lucide line icons.
 */
export function RoomCard({
  channel,
  participants,
  speakingUsers,
  guildId,
  onJoin,
  onWatch,
  compact,
}: RoomCardProps) {
  const navigate = useNavigate();
  const { joinChannel } = useVoice();

  const name = channelName(channel);
  const occupantCount = participants.length;
  const isStage = channel.type === ChannelType.Stage;
  const streamer = participants.find((p) => p.self_stream);
  const channelRoute = `/app/guilds/${guildId}/channels/${channel.id}`;

  const handleJoin = () => {
    if (onJoin) {
      onJoin();
      return;
    }
    void joinChannel(channel.id, guildId);
  };

  const handleWatch = () => {
    if (!streamer) return;
    if (onWatch) {
      onWatch(streamer.user_id);
      return;
    }
    useVoiceStore.getState().setWatchedStreamer(streamer.user_id);
    navigate(channelRoute);
  };

  const enterStage = () => navigate(channelRoute);

  // ---- (c) STAGE ------------------------------------------------------------
  if (isStage) {
    const speakers = participants.filter((p) => !p.suppress);
    const audience = participants.filter((p) => p.suppress);
    const live = occupantCount > 0;
    return (
      <button
        type="button"
        onClick={enterStage}
        className="flex w-full items-center gap-3 rounded-md border border-border-subtle bg-bg-secondary px-4 py-3 text-left shadow-sm outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-accent focus-visible:shadow-[var(--focus-ring)]"
      >
        <Radio size={18} className="shrink-0 text-accent-primary" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-label font-semibold text-text-primary">{name}</span>
            {live && (
              <span className="inline-flex items-center rounded-xs bg-accent-tint px-1.5 py-0.5 text-[10px] font-bold uppercase leading-none tracking-wide text-accent-primary">
                Live
              </span>
            )}
          </div>
          <span className="text-meta text-text-muted">
            {live
              ? `${speakers.length} on stage · ${audience.length} listening`
              : 'Stage is open — step up to speak'}
          </span>
        </div>
        {live && (
          <OccupantStack participants={speakers} speakingUsers={speakingUsers} max={4} />
        )}
      </button>
    );
  }

  // ---- (b) QUIET / EMPTY ----------------------------------------------------
  if (occupantCount === 0 || compact) {
    if (occupantCount === 0) {
      return (
        <div className="flex items-center gap-3 rounded-md px-3 py-2 transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle">
          <Volume2 size={18} className="shrink-0 text-channel-icon" />
          <span className="truncate text-label text-text-secondary">{name}</span>
          <span className="truncate text-meta text-text-muted">Empty — start the room</span>
          <button
            type="button"
            onClick={handleJoin}
            className="ml-auto shrink-0 rounded-sm border border-border-subtle px-3 py-1 text-meta font-semibold text-text-secondary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
          >
            Join
          </button>
        </div>
      );
    }
    // Occupied but forced-compact: single line with a small occupant stack.
    return (
      <div className="flex items-center gap-3 rounded-md px-3 py-2 transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle">
        <Hash size={18} className="shrink-0 text-channel-icon" />
        <span className="truncate text-label text-text-primary">{name}</span>
        <OccupantStack participants={participants} speakingUsers={speakingUsers} max={3} />
        <button
          type="button"
          onClick={handleJoin}
          className="ml-auto shrink-0 rounded-sm bg-accent-primary px-3 py-1 text-meta font-semibold text-text-on-accent shadow-sm outline-none transition-[background-color,transform] duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-primary-hover active:scale-[0.97] focus-visible:shadow-[var(--focus-ring)]"
        >
          Join
        </button>
      </div>
    );
  }

  // ---- (a) LIVE  /  (d) STREAM ----------------------------------------------
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border-subtle bg-bg-secondary p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <Volume2 size={18} className="shrink-0 text-accent-primary" />
        <span className="truncate text-label font-semibold text-text-primary">{name}</span>
        <span className="ml-auto inline-flex items-center gap-1 rounded-xs bg-success-tint px-1.5 py-0.5 text-meta font-semibold text-accent-success">
          <Users size={12} />
          {occupantCount}
        </span>
      </div>

      <OccupantStack participants={participants} speakingUsers={speakingUsers} />

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleJoin}
          className="inline-flex h-9 items-center rounded-sm bg-accent-primary px-3.5 text-label font-semibold text-text-on-accent shadow-sm outline-none transition-[background-color,transform] duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-primary-hover active:scale-[0.97] focus-visible:shadow-[var(--focus-ring)]"
        >
          Join
        </button>
        {streamer && (
          <button
            type="button"
            onClick={handleWatch}
            aria-label={`Watch ${streamer.username || 'stream'}`}
            className="inline-flex h-9 items-center gap-1.5 rounded-sm border border-border-subtle px-3 text-label font-semibold text-text-secondary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
          >
            <Play size={14} className="text-status-streaming" />
            Watch
          </button>
        )}
      </div>
    </div>
  );
}
