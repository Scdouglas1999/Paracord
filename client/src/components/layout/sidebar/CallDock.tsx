import { useNavigate } from 'react-router';
import { Radio } from 'lucide-react';
import { useVoiceStore } from '../../../stores/voiceStore';
import { OnAirDock } from '../../voice/OnAirDock';

/**
 * Persistent call dock for the Unified Sidebar footer (layout-spec §1, §2 — the
 * successor to the deleted channel-column voice footer). Renders ONLY when voice is
 * connected (`voiceStore.connected`); the dock body is WP3's
 * `OnAirDock` (the on-air pill, spec §7.7) so the call surface never diverges
 * from the mobile dock.
 *
 * Collapsed (64px icon rail, §6): a compact "in call" affordance — a pulsing accent
 * indicator that routes back to the active voice channel — since the pill is too
 * wide for the rail.
 *
 * The pill's single action is "take me back to the Stage"; every call control
 * lives on the Stage itself.
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
          if (!channelId) return;
          if (guildId === 'dm') {
            navigate(`/app/dms/${channelId}`);
          } else if (guildId) {
            navigate(`/app/guilds/${guildId}/channels/${channelId}`);
          }
        }}
        className="pc-focusable relative flex h-11 w-11 items-center justify-center rounded-[var(--radius-card)] bg-bg-raised text-light-white shadow-[var(--shadow-raised)] transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-bg-mod-strong"
      >
        <Radio size={18} aria-hidden />
        <span
          aria-hidden
          className="voice-connected-pulse absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-light-white shadow-[var(--glow-live-dot)] ring-2 ring-bg-base"
        />
      </button>
    );
  }

  return (
    <div data-testid="call-dock">
      <OnAirDock />
    </div>
  );
}
