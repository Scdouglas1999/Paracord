import { useNavigate } from 'react-router';

import { OnAirPill } from '../light';
import { useOnAir } from '../../hooks/useLights';
import { useVoiceStore } from '../../stores/voiceStore';
import { cn } from '../../lib/utils';

export interface OnAirDockProps {
  className?: string;
}

/**
 * OnAirDock — the on-air pill, wired (docs/lantern-stage-spec.md §7.7).
 *
 * You are in a room and looking at something else: a raised pill with the white
 * dot, the room name, the duration and your mic state. Tapping it takes you back
 * to the Stage. It replaces `MiniVoiceBar`, which was a second control bar in
 * the chrome — the controls live on the Stage, and there is exactly one action
 * here.
 *
 * The pill itself is WP1's; this is only the route back.
 */
export function OnAirDock({ className }: OnAirDockProps) {
  const onAir = useOnAir();
  const guildId = useVoiceStore((s) => s.guildId);
  const channelId = useVoiceStore((s) => s.channelId);
  const navigate = useNavigate();

  if (!onAir) return null;

  return (
    <div className={cn('flex min-w-0 items-center', className)} data-testid="on-air-dock">
      <OnAirPill
        className="w-full"
        onAir={onAir}
        onReturn={() => {
          if (!channelId) return;
          if (guildId === 'dm') {
            navigate(`/app/dms/${channelId}`);
          } else if (guildId) {
            navigate(`/app/guilds/${guildId}/channels/${channelId}`);
          }
        }}
      />
    </div>
  );
}
