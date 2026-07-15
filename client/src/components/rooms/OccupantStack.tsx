import { MicOff } from 'lucide-react';
import { cn } from '../../lib/utils';
import { safeStoredImageDataUrl } from '../../lib/security';
import type { VoiceState } from '../../types';
import { displayName as resolveDisplayName } from '../../lib/displayName';

interface OccupantStackProps {
  participants: VoiceState[];
  speakingUsers: Set<string>;
  /** Maximum avatars rendered before collapsing into a +N overflow chip. */
  max?: number;
}

function displayName(vs: VoiceState): string {
  const resolved = resolveDisplayName(vs);
  return resolved === 'Unknown User' ? `User ${vs.user_id.slice(0, 6)}` : resolved;
}

function AvatarChip({
  vs,
  speaking,
  first,
}: {
  vs: VoiceState;
  speaking: boolean;
  first: boolean;
}) {
  const src = safeStoredImageDataUrl(vs.avatar_hash);
  const muted = vs.self_mute || vs.mute;
  const streaming = vs.self_stream;
  const name = displayName(vs);

  return (
    <div className={cn('relative', !first && '-ml-2')}>
      <div
        data-testid={`occupant-${vs.user_id}`}
        aria-label={speaking ? `${name} (speaking)` : name}
        title={name}
        className={cn(
          'flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-accent-primary text-meta font-semibold text-text-on-accent ring-2 transition-shadow duration-[140ms] ease-[var(--ease-out)]',
          speaking
            ? 'ring-accent-primary shadow-[0_0_8px_rgba(var(--accent-primary-rgb),0.55)]'
            : 'ring-bg-secondary',
        )}
      >
        {src ? (
          <img src={src} alt="" className="h-full w-full object-cover" />
        ) : (
          name.charAt(0).toUpperCase()
        )}
      </div>
      {streaming && (
        <span
          aria-label={`${name} is streaming`}
          title={`${name} is streaming`}
          className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full bg-status-streaming ring-2 ring-bg-secondary"
        />
      )}
      {muted && (
        <span
          aria-hidden="true"
          className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-bg-secondary ring-2 ring-bg-secondary"
        >
          <MicOff size={9} className="text-accent-danger" />
        </span>
      )}
    </div>
  );
}

/**
 * Overlapping avatar stack for voice/stage occupants. Each chip is ringed in the
 * surface color behind it (`--bg-secondary`); the speaking ring + glow is applied
 * only to users present in `speakingUsers`. Overflow past `max` collapses into a
 * +N chip. Presence of mute / streaming is surfaced as per-avatar badges.
 */
export function OccupantStack({ participants, speakingUsers, max = 5 }: OccupantStackProps) {
  if (participants.length === 0) return null;

  const visible = participants.slice(0, max);
  const overflow = participants.length - visible.length;

  return (
    <div className="flex items-center" role="group" aria-label="Occupants">
      {visible.map((vs, i) => (
        <AvatarChip
          key={vs.user_id}
          vs={vs}
          speaking={speakingUsers.has(vs.user_id)}
          first={i === 0}
        />
      ))}
      {overflow > 0 && (
        <div
          aria-label={`${overflow} more`}
          title={`${overflow} more`}
          className="relative -ml-2 flex h-8 w-8 items-center justify-center rounded-full bg-bg-mod-strong text-meta font-semibold text-text-secondary ring-2 ring-bg-secondary"
        >
          +{overflow}
        </div>
      )}
    </div>
  );
}
