import { Volume2, MicOff, HeadphoneOff } from 'lucide-react';
import { displayName } from '../../lib/displayName';

interface VoiceUser {
  id: string;
  username: string;
  display_name?: string | null;
  avatar_hash: string | null;
  muted: boolean;
  deafened: boolean;
}

interface VoiceChannelProps {
  channelName: string;
  users: VoiceUser[];
  onJoin: () => void;
}

export function VoiceChannel({ channelName, users, onJoin }: VoiceChannelProps) {
  return (
    <div>
      <button onClick={onJoin} className="channel-item" aria-label={`Join voice channel ${channelName}`}>
        <Volume2 size={18} style={{ color: 'var(--channel-icon)', flexShrink: 0 }} />
        <span className="truncate">{channelName}</span>
      </button>

      {users.length > 0 ? (
        <div className="ml-7 mt-1 space-y-0.5">
          {users.map(user => (
            <div
              key={user.id}
              className="flex items-center gap-2.5 rounded-sm px-2 py-1 transition-colors hover:bg-bg-mod-subtle"
            >
              <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-border-subtle bg-bg-accent text-[11px] font-semibold text-text-secondary">
                {displayName(user).charAt(0).toUpperCase()}
              </div>
              <span className="truncate text-label text-text-secondary">{displayName(user)}</span>
              <div className="ml-auto flex items-center gap-1.5">
                {user.muted && <MicOff size={13} style={{ color: 'var(--accent-danger)' }} />}
                {user.deafened && <HeadphoneOff size={13} style={{ color: 'var(--accent-danger)' }} />}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="ml-7 mt-0.5 pr-2 text-meta text-text-muted">
          No one&rsquo;s here yet — hop in and others will follow.
        </p>
      )}
    </div>
  );
}
