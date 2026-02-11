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
    micInputActive,
    micInputLevel,
    micServerDetected,
    micUplinkState,
    micUplinkBytesSent,
    micUplinkStalledIntervals,
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
  const micTxLabel = useMemo(() => {
    switch (micUplinkState) {
      case 'sending':
        return 'Mic TX: sending';
      case 'stalled':
        return `Mic TX: stalled (${micUplinkStalledIntervals})`;
      case 'recovering':
        return 'Mic TX: recovering';
      case 'muted':
        return 'Mic TX: muted';
      case 'no_track':
        return 'Mic TX: no track';
      default:
        return 'Mic TX: idle';
    }
  }, [micUplinkState, micUplinkStalledIntervals]);
  const micTxColor = useMemo(() => {
    switch (micUplinkState) {
      case 'sending':
        return 'var(--accent-success)';
      case 'stalled':
      case 'no_track':
        return 'var(--accent-danger)';
      case 'recovering':
        return 'var(--accent-primary)';
      case 'muted':
      case 'idle':
      default:
        return 'var(--text-muted)';
    }
  }, [micUplinkState]);
  const micInLabel = useMemo(() => {
    if (selfMute || selfDeaf) return 'Mic In: muted';
    return micInputActive ? 'Mic In: voice detected' : 'Mic In: silent';
  }, [selfMute, selfDeaf, micInputActive]);
  const micInColor = useMemo(() => {
    if (selfMute || selfDeaf) return 'var(--text-muted)';
    return micInputActive ? 'var(--accent-success)' : 'var(--accent-danger)';
  }, [selfMute, selfDeaf, micInputActive]);
  const micInPercent = Math.round(Math.max(0, Math.min(1, micInputLevel)) * 100);
  const micServerLabel = useMemo(() => {
    if (selfMute || selfDeaf) return 'SFU detect: muted';
    return micServerDetected ? 'SFU detect: yes' : 'SFU detect: no';
  }, [selfMute, selfDeaf, micServerDetected]);
  const micServerColor = useMemo(() => {
    if (selfMute || selfDeaf) return 'var(--text-muted)';
    return micServerDetected ? 'var(--accent-success)' : 'var(--accent-danger)';
  }, [selfMute, selfDeaf, micServerDetected]);

  if (!connected) return null;

  return (
    <div className="panel-divider border-t px-3 py-3">
      <div className="mb-3 flex items-center justify-between rounded-xl border border-border-subtle bg-bg-mod-subtle px-3 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Signal size={15} className="voice-connected-pulse" style={{ color: 'var(--accent-success)' }} />
          <div className="min-w-0">
            <div className="text-xs font-semibold tracking-wide" style={{ color: 'var(--accent-success)' }}>
              Voice Connected
            </div>
            <div className="truncate text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
              {channelName}
            </div>
            <div className="truncate text-[11px] font-medium" style={{ color: micTxColor }}>
              {micTxLabel}
              {micUplinkBytesSent != null ? `  ·  ${micUplinkBytesSent} bytes` : ''}
            </div>
            <div className="truncate text-[11px] font-medium" style={{ color: micInColor }}>
              {micInLabel}  ·  {micInPercent}%
            </div>
            <div className="truncate text-[11px] font-medium" style={{ color: micServerColor }}>
              {micServerLabel}
            </div>
          </div>
        </div>
        <button className="command-icon-btn border border-border-subtle bg-bg-primary/40 text-text-secondary hover:!text-accent-danger" onClick={() => void leaveChannel()}>
          <PhoneOff size={18} />
        </button>
      </div>

      <div className="flex items-center justify-center gap-3">
        <button
          onClick={toggleMute}
          className="flex h-11 w-11 items-center justify-center rounded-xl border border-border-subtle p-2 transition-colors"
          style={{
            backgroundColor: selfMute ? 'var(--accent-danger)' : 'var(--bg-mod-subtle)',
            color: selfMute ? '#fff' : 'var(--text-secondary)',
          }}
        >
          {selfMute ? <MicOff size={19} /> : <Mic size={19} />}
        </button>
        <button
          onClick={toggleDeaf}
          className="flex h-11 w-11 items-center justify-center rounded-xl border border-border-subtle p-2 transition-colors"
          style={{
            backgroundColor: selfDeaf ? 'var(--accent-danger)' : 'var(--bg-mod-subtle)',
            color: selfDeaf ? '#fff' : 'var(--text-secondary)',
          }}
        >
          {selfDeaf ? <HeadphoneOff size={19} /> : <Headphones size={19} />}
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
          className="flex h-11 w-11 items-center justify-center rounded-xl border border-border-subtle p-2 transition-colors"
          disabled={startingStream}
          style={{
            backgroundColor: selfStream ? 'var(--accent-primary)' : 'var(--bg-mod-subtle)',
            color: selfStream ? '#fff' : 'var(--text-secondary)',
            opacity: startingStream ? 0.65 : 1,
          }}
        >
          {selfStream ? <MonitorOff size={19} /> : <Monitor size={19} />}
        </button>
      </div>
    </div>
  );
}
