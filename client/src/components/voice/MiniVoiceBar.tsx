import { useEffect, useMemo, useState } from 'react';
import { Mic, MicOff, Headphones, HeadphoneOff, PhoneOff, Radio, Video, VideoOff } from 'lucide-react';
import { ConnectionQuality, RoomEvent } from 'livekit-client';
import { useNavigate } from 'react-router';
import { useVoiceStore } from '../../stores/voiceStore';
import { useChannelStore } from '../../stores/channelStore';
import { useAuthStore } from '../../stores/authStore';
import { useVoice } from '../../hooks/useVoice';

// Map the transport's live connection quality onto a semantic presence color +
// human label. Unknown resolves to "online" — being connected at all is a link.
function qualityMeta(quality: ConnectionQuality): { color: string; label: string } {
  switch (quality) {
    case ConnectionQuality.Poor:
      return { color: 'var(--status-idle)', label: 'Connection unstable' };
    case ConnectionQuality.Lost:
      return { color: 'var(--status-dnd)', label: 'Connection lost' };
    default:
      return { color: 'var(--status-online)', label: 'Connection stable' };
  }
}

export function MiniVoiceBar() {
  const channelId = useVoiceStore((s) => s.channelId);
  const guildId = useVoiceStore((s) => s.guildId);
  const selfMute = useVoiceStore((s) => s.selfMute);
  const selfDeaf = useVoiceStore((s) => s.selfDeaf);
  const selfVideo = useVoiceStore((s) => s.selfVideo);
  const pttEngaged = useVoiceStore((s) => s.pttEngaged);
  const leaveChannel = useVoiceStore((s) => s.leaveChannel);
  const room = useVoiceStore((s) => s.room);
  // Route mute/deaf/camera through useVoice so the gateway broadcast lives in one
  // place and can't diverge from VoiceControlBar.
  const { toggleMute, toggleDeaf, toggleVideo } = useVoice();
  const channels = useChannelStore((s) => s.channels);
  const rawNotifications = useAuthStore((s) => s.settings?.notifications as Record<string, unknown> | undefined);
  const isPttMode = (rawNotifications?.['voiceInputMode'] ?? 'voice_activity') === 'push_to_talk';
  const navigate = useNavigate();

  const [quality, setQuality] = useState<ConnectionQuality>(ConnectionQuality.Unknown);

  useEffect(() => {
    if (!room) {
      setQuality(ConnectionQuality.Unknown);
      return;
    }
    const local = room.localParticipant;
    setQuality(local?.connectionQuality ?? ConnectionQuality.Unknown);
    const onChange = () => setQuality(room.localParticipant?.connectionQuality ?? ConnectionQuality.Unknown);
    room.on(RoomEvent.ConnectionQualityChanged, onChange);
    return () => {
      room.off(RoomEvent.ConnectionQualityChanged, onChange);
    };
  }, [room]);

  const channelName = useMemo(
    () => channels.find((c) => c.id === channelId)?.name ?? 'Voice Channel',
    [channels, channelId],
  );

  const { color: qualityColor, label: qualityLabel } = qualityMeta(quality);

  const handleToggleMute = () => {
    void toggleMute();
  };

  const handleToggleDeaf = () => {
    void toggleDeaf();
  };

  const handleToggleVideo = () => {
    void toggleVideo();
  };

  const ctrl =
    'flex h-8 w-8 items-center justify-center rounded-sm outline-none transition-[background-color,box-shadow,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)] active:scale-[.97]';

  return (
    <div className="flex items-center gap-2 border-t border-border-subtle bg-bg-secondary px-3 py-2">
      {/* Connection info — clickable to navigate to voice channel */}
      <button
        onClick={() => {
          if (guildId === 'dm' && channelId) {
            navigate(`/app/dms/${channelId}`);
          } else if (guildId && channelId) {
            navigate(`/app/guilds/${guildId}/channels/${channelId}`);
          }
        }}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-sm px-1.5 py-1 outline-none transition-colors hover:bg-bg-mod-subtle focus-visible:shadow-[var(--focus-ring)]"
      >
        {/* Connection-quality dot — semantic presence color. Labeled so the
            state is announced, not conveyed by color alone (design-spec §8). */}
        <span
          className="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center"
          role="img"
          aria-label={qualityLabel}
          title={qualityLabel}
        >
          <span
            className="voice-connected-pulse absolute inline-flex h-2.5 w-2.5 rounded-full opacity-60"
            style={{ backgroundColor: qualityColor }}
          />
          <span className="relative inline-flex h-2 w-2 rounded-full" style={{ backgroundColor: qualityColor }} />
        </span>
        <div className="min-w-0 flex-1 text-left">
          <div className="text-[11px] font-semibold leading-tight" style={{ color: qualityColor }}>
            Voice Connected
          </div>
          <div className="truncate text-meta font-medium text-text-secondary">{channelName}</div>
        </div>
      </button>

      {/* Quick controls */}
      <div className="flex items-center gap-1">
        <button
          onClick={handleToggleMute}
          // In push-to-talk mode this control is a live transmit/mute status
          // indicator, not a toggle; mark it disabled so keyboard and AT users
          // get an honest non-interactive control instead of a silent no-op.
          disabled={isPttMode}
          className={`${ctrl} ${
            isPttMode
              ? pttEngaged
                ? 'bg-accent-tint text-accent-primary'
                : 'bg-danger-tint text-accent-danger'
              : selfMute
                ? 'bg-danger-tint text-accent-danger'
                : 'text-interactive-normal hover:bg-bg-mod-subtle hover:text-interactive-hover'
          }`}
          aria-label={isPttMode ? (pttEngaged ? 'Transmitting (PTT)' : 'Push to Talk (muted)') : selfMute ? 'Unmute' : 'Mute'}
          title={isPttMode ? (pttEngaged ? 'Transmitting (PTT)' : 'Push to Talk (muted)') : undefined}
          style={{ cursor: isPttMode ? 'default' : undefined }}
        >
          {isPttMode
            ? pttEngaged ? <Radio size={15} className="animate-pulse" /> : <MicOff size={15} />
            : selfMute ? <MicOff size={15} /> : <Mic size={15} />
          }
        </button>
        <button
          onClick={handleToggleDeaf}
          className={`${ctrl} ${selfDeaf ? 'bg-danger-tint text-accent-danger' : 'text-interactive-normal hover:bg-bg-mod-subtle hover:text-interactive-hover'}`}
          aria-label={selfDeaf ? 'Undeafen' : 'Deafen'}
        >
          {selfDeaf ? <HeadphoneOff size={15} /> : <Headphones size={15} />}
        </button>
        <button
          onClick={handleToggleVideo}
          className={`${ctrl} ${selfVideo ? 'bg-accent-tint text-accent-primary' : 'text-interactive-normal hover:bg-bg-mod-subtle hover:text-interactive-hover'}`}
          aria-label={selfVideo ? 'Turn off camera' : 'Turn on camera'}
        >
          {selfVideo ? <Video size={15} /> : <VideoOff size={15} />}
        </button>
        <button
          className={`${ctrl} text-interactive-normal hover:bg-danger-tint hover:text-accent-danger`}
          onClick={() => void leaveChannel()}
          aria-label="Disconnect"
        >
          <PhoneOff size={15} />
        </button>
      </div>
    </div>
  );
}


