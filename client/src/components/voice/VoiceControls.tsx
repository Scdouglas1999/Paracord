import { useMemo, useState } from 'react';
import { Mic, MicOff, Headphones, HeadphoneOff, Monitor, PhoneOff, Signal, MonitorOff } from 'lucide-react';
import { useVoice } from '../../hooks/useVoice';
import { useChannelStore } from '../../stores/channelStore';

export function VoiceControls() {
  const {
    connected,
    channelId,
    selfMute,
    selfDeaf,
    selfStream,
    leaveChannel,
    toggleMute,
    toggleDeaf,
    startStream,
    stopStream,
  } = useVoice();
  const channels = useChannelStore((s) => s.channels);
  const [startingStream, setStartingStream] = useState(false);
  const channelName = useMemo(
    () => channels.find((c) => c.id === channelId)?.name ?? 'Voice Channel',
    [channels, channelId]
  );

  if (!connected) return null;

  return (
    <div className="px-3 pb-2">
      <div
        className="rounded-xl border border-border-subtle/60 overflow-hidden"
        style={{ background: 'rgba(255,255,255,0.03)' }}
      >
        {/* Connection status header */}
        <div className="flex items-center gap-3 px-3.5 pt-2.5 pb-1.5">
          <Signal size={16} className="voice-connected-pulse shrink-0" style={{ color: 'var(--accent-success)' }} />
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-semibold tracking-wide" style={{ color: 'var(--accent-success)' }}>
              Voice Connected
            </div>
            <div className="truncate text-[14px] font-medium text-text-secondary leading-snug">
              {channelName}
            </div>
          </div>
        </div>

        {/* Divider */}
        <div className="mx-3 h-px bg-border-subtle/40 my-0" />

        {/* Action buttons row */}
        <div className="flex items-center gap-1.5 px-2.5 py-1.5">
          <button
            onClick={toggleMute}
            className="flex h-10 w-10 items-center justify-center rounded-lg transition-colors"
            title={selfMute ? 'Unmute' : 'Mute'}
            style={{
              backgroundColor: selfMute ? 'var(--accent-danger)' : 'transparent',
              color: selfMute ? '#fff' : 'var(--text-muted)',
            }}
          >
            {selfMute ? <MicOff size={18} /> : <Mic size={18} />}
          </button>
          <button
            onClick={toggleDeaf}
            className="flex h-10 w-10 items-center justify-center rounded-lg transition-colors"
            title={selfDeaf ? 'Undeafen' : 'Deafen'}
            style={{
              backgroundColor: selfDeaf ? 'var(--accent-danger)' : 'transparent',
              color: selfDeaf ? '#fff' : 'var(--text-muted)',
            }}
          >
            {selfDeaf ? <HeadphoneOff size={18} /> : <Headphones size={18} />}
          </button>
          <button
            onClick={async () => {
              if (selfStream) {
                stopStream();
              } else {
                setStartingStream(true);
                try {
                  await startStream();
                } catch {
                  // Error is surfaced in the voice panel / stream viewer
                } finally {
                  setStartingStream(false);
                }
              }
            }}
            className="flex h-10 w-10 items-center justify-center rounded-lg transition-colors"
            disabled={startingStream}
            title={selfStream ? 'Stop Sharing' : 'Share Screen'}
            style={{
              backgroundColor: selfStream ? 'var(--accent-primary)' : 'transparent',
              color: selfStream ? '#fff' : 'var(--text-muted)',
              opacity: startingStream ? 0.65 : 1,
            }}
          >
            {selfStream ? <MonitorOff size={18} /> : <Monitor size={18} />}
          </button>

          {/* Spacer pushes disconnect to the right */}
          <div className="flex-1" />

          <button
            className="flex h-10 w-10 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-accent-danger/20 hover:text-accent-danger"
            onClick={() => void leaveChannel()}
            title="Disconnect"
          >
            <PhoneOff size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
