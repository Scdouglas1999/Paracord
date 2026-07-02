import { Volume2, MicOff, HeadphoneOff } from 'lucide-react';

interface VoiceUser {
  id: string;
  username: string;
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

      {users.length > 0 && (
        <div className="ml-7 mt-1 space-y-1">
          {users.map(user => (
            <div
              key={user.id}
              className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5"
            >
              <div
                className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
                style={{ backgroundColor: 'var(--accent-primary)' }}
              >
                {user.username.charAt(0).toUpperCase()}
              </div>
              <span className="truncate text-sm" style={{ color: 'var(--text-secondary)' }}>
                {user.username}
              </span>
              <div className="ml-auto flex items-center gap-1">
                {user.muted && <MicOff size={13} style={{ color: 'var(--text-muted)' }} />}
                {user.deafened && <HeadphoneOff size={13} style={{ color: 'var(--text-muted)' }} />}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
