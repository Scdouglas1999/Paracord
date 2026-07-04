import { useNavigate } from 'react-router-dom';
import { Radio } from 'lucide-react';
import { useVoiceStore } from '../../../stores/voiceStore';
import { MiniVoiceBar } from '../../voice/MiniVoiceBar';

/**
 * Persistent call dock for the Unified Sidebar footer (layout-spec §1, §2 — the
 * successor to the deleted channel-column voice footer). Renders ONLY when voice is
 * connected (`voiceStore.connected`); the dock body reuses the promoted `MiniVoiceBar`
 * primitive so the call surface never diverges from the mobile dock.
 *
 * Collapsed (64px icon rail, §6): a compact "in call" affordance — a pulsing accent
 * indicator that routes back to the active voice channel — since the full MiniVoiceBar
 * is too wide for the rail.
 *
 * MiniVoiceBar's mute/deafen/disconnect + channel nav cover the persistent-dock
 * essentials; richer stream/video affordances live on the channel/room views.
 */

export interface CallDockProps {
  /** Icon-rail variant for the collapsed sidebar. */
  collapsed?: boolean;
}

export function CallDock({ collapsed = false }: CallDockProps) {
  const connected = useVoiceStore((s) => s.connected);
  const guildId = useVoiceStore((s) => s.guildId);
  const channelId = useVoiceStore((s) => s.channelId);
  const navigate = useNavigate();

  if (!connected) return null;

  if (collapsed) {
    return (
      <button
        type="button"
        data-testid="call-dock-collapsed"
        aria-label="In a call — go to voice channel"
        onClick={() => {
          if (guildId && channelId) navigate(`/app/guilds/${guildId}/channels/${channelId}`);
        }}
        className="relative flex h-11 w-11 items-center justify-center rounded-md bg-accent-tint text-accent-primary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-tint-strong focus-visible:shadow-[var(--focus-ring)]"
      >
        <Radio size={18} aria-hidden />
        <span
          aria-hidden
          className="voice-connected-pulse absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-accent-primary ring-2 ring-bg-secondary"
        />
      </button>
    );
  }

  return (
    <div data-testid="call-dock">
      <MiniVoiceBar />
    </div>
  );
}
