import { MicOff, HeadphoneOff, Video } from 'lucide-react';
import { useVoiceStore } from '../../stores/voiceStore';
import { cn } from '../../lib/utils';
import type { Channel } from '../../types/index';

interface VoiceState {
  user_id: string;
  username?: string;
  self_mute?: boolean;
  self_deaf?: boolean;
  self_video?: boolean;
  self_stream?: boolean;
}

interface VoiceParticipantsProps {
  channel: Channel;
  participants: VoiceState[];
  speakingUsers: Set<string>;
  guildId: string | undefined;
  selectedGuildId: string | null;
  navigate: (path: string) => void;
}

export function VoiceParticipants({
  channel,
  participants,
  speakingUsers,
  guildId,
  selectedGuildId,
  navigate,
}: VoiceParticipantsProps) {
  if (participants.length === 0) return null;

  return (
    <div
      className="mb-2 mt-0.5 ml-10 space-y-1 border-l pl-2.5"
      style={{ borderColor: 'var(--border-subtle)' }}
    >
      {participants.map((vs) => {
        const isSpeaking = speakingUsers.has(vs.user_id);
        return (
          <div
            key={vs.user_id}
            className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5"
          >
            <div
              className={cn(
                'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white transition-shadow duration-200',
                isSpeaking
                  ? 'ring-2 ring-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]'
                  : ''
              )}
              style={{ backgroundColor: 'var(--accent-primary)' }}
            >
              {(vs.username || vs.user_id).charAt(0).toUpperCase()}
            </div>
            <span className="truncate text-[13px] font-medium text-text-secondary">
              {vs.username || `User ${vs.user_id.slice(0, 6)}`}
            </span>
            <div className="ml-auto flex items-center gap-1">
              {vs.self_video && (
                <Video size={13} className="text-accent-primary" />
              )}
              {vs.self_stream && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    useVoiceStore.getState().setWatchedStreamer(vs.user_id);
                    const gId = guildId || selectedGuildId;
                    if (gId) {
                      navigate(`/app/guilds/${gId}/channels/${channel.id}`);
                    }
                  }}
                  className="inline-flex items-center rounded px-1 py-0.5 text-[9px] font-bold uppercase leading-none tracking-wider text-accent-danger transition-colors hover:bg-accent-danger/20 cursor-pointer"
                  style={{ backgroundColor: 'rgba(255, 93, 114, 0.15)' }}
                  title={`Watch ${vs.username || 'user'}'s stream`}
                  aria-label={`Watch ${vs.username || 'user'}'s stream`}
                >
                  Live
                </button>
              )}
              {vs.self_mute && <MicOff size={13} className="text-text-muted" />}
              {vs.self_deaf && <HeadphoneOff size={13} className="text-text-muted" />}
            </div>
          </div>
        );
      })}
    </div>
  );
}
