import { MicOff, HeadphoneOff, Video } from 'lucide-react';
import { useVoiceStore } from '../../stores/voiceStore';
import { cn } from '../../lib/utils';
import type { Channel } from '../../types/index';
import { displayName } from '../../lib/displayName';

interface VoiceState {
  user_id: string;
  username?: string;
  display_name?: string | null;
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
    <div className="mb-2 ml-[1.375rem] mt-0.5 space-y-0.5 border-l border-border-subtle pl-3">
      {participants.map((vs) => {
        const isSpeaking = speakingUsers.has(vs.user_id);
        return (
          <div key={vs.user_id} className="flex items-center gap-2.5 rounded-sm px-2 py-1">
            <div
              className={cn(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-primary text-meta font-semibold text-text-on-accent transition-shadow duration-[140ms] ease-[var(--ease-out)]',
                isSpeaking &&
                  'ring-2 ring-accent-primary shadow-[0_0_8px_rgba(var(--accent-primary-rgb),0.55)]',
              )}
            >
              {displayName(vs).charAt(0).toUpperCase()}
            </div>
            <span className="truncate text-label text-text-secondary">
              {displayName(vs) || `User ${vs.user_id.slice(0, 6)}`}
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              {vs.self_video && <Video size={14} className="text-accent-primary" />}
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
                  className="inline-flex items-center rounded-xs bg-danger-tint px-1.5 py-0.5 text-[10px] font-bold uppercase leading-none tracking-wide text-accent-danger outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-danger/20 focus-visible:shadow-[var(--focus-ring)]"
                  title={`Watch ${displayName(vs)}'s stream`}
                  aria-label={`Watch ${displayName(vs)}'s stream`}
                >
                  Live
                </button>
              )}
              {vs.self_mute && <MicOff size={14} className="text-accent-danger" />}
              {vs.self_deaf && <HeadphoneOff size={14} className="text-accent-danger" />}
            </div>
          </div>
        );
      })}
    </div>
  );
}
