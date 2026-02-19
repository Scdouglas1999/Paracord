import { useMemo } from 'react';
import { Mic, MicOff, Headphones, HeadphoneOff, PhoneOff, Signal } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useVoiceStore } from '../../stores/voiceStore';
import { useChannelStore } from '../../stores/channelStore';
import { gateway } from '../../gateway/manager';

export function MiniVoiceBar() {
  const channelId = useVoiceStore((s) => s.channelId);
  const guildId = useVoiceStore((s) => s.guildId);
  const selfMute = useVoiceStore((s) => s.selfMute);
  const selfDeaf = useVoiceStore((s) => s.selfDeaf);
  const toggleMute = useVoiceStore((s) => s.toggleMute);
  const toggleDeaf = useVoiceStore((s) => s.toggleDeaf);
  const leaveChannel = useVoiceStore((s) => s.leaveChannel);
  const channels = useChannelStore((s) => s.channels);
  const navigate = useNavigate();

  const channelName = useMemo(
    () => channels.find((c) => c.id === channelId)?.name ?? 'Voice Channel',
    [channels, channelId],
  );

  const handleToggleMute = () => {
    void toggleMute().then(() => {
      const s = useVoiceStore.getState();
      gateway.updateVoiceStateAll(s.guildId, s.channelId, s.selfMute, s.selfDeaf);
    });
  };

  const handleToggleDeaf = () => {
    void toggleDeaf().then(() => {
      const s = useVoiceStore.getState();
      gateway.updateVoiceStateAll(s.guildId, s.channelId, s.selfMute, s.selfDeaf);
    });
  };

  return (
    <div
      className="flex items-center gap-2 border-t border-border-subtle/60 px-3 py-2"
      style={{ backgroundColor: 'color-mix(in srgb, var(--bg-secondary) 92%, transparent)' }}
    >
      {/* Connection info — clickable to navigate to voice channel */}
      <button
        onClick={() => {
          if (guildId && channelId) {
            navigate(`/app/guilds/${guildId}/channels/${channelId}`);
          }
        }}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1.5 py-1 transition-colors hover:bg-bg-mod-subtle"
      >
        <Signal size={14} className="voice-connected-pulse shrink-0" style={{ color: 'var(--accent-success)' }} />
        <div className="min-w-0 flex-1 text-left">
          <div className="text-[11px] font-semibold leading-tight" style={{ color: 'var(--accent-success)' }}>
            Voice Connected
          </div>
          <div className="truncate text-[13px] font-medium leading-snug text-text-secondary">
            {channelName}
          </div>
        </div>
      </button>

      {/* Quick controls */}
      <div className="flex items-center gap-1">
        <button
          onClick={handleToggleMute}
          className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors"
          aria-label={selfMute ? 'Unmute' : 'Mute'}
          style={{
            backgroundColor: selfMute ? 'var(--accent-danger)' : 'transparent',
            color: selfMute ? '#fff' : 'var(--text-muted)',
          }}
        >
          {selfMute ? <MicOff size={15} /> : <Mic size={15} />}
        </button>
        <button
          onClick={handleToggleDeaf}
          className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors"
          aria-label={selfDeaf ? 'Undeafen' : 'Deafen'}
          style={{
            backgroundColor: selfDeaf ? 'var(--accent-danger)' : 'transparent',
            color: selfDeaf ? '#fff' : 'var(--text-muted)',
          }}
        >
          {selfDeaf ? <HeadphoneOff size={15} /> : <Headphones size={15} />}
        </button>
        <button
          className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-accent-danger/20 hover:text-accent-danger"
          onClick={() => void leaveChannel()}
          aria-label="Disconnect"
        >
          <PhoneOff size={15} />
        </button>
      </div>
    </div>
  );
}


