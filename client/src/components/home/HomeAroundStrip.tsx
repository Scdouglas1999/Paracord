import { Users } from 'lucide-react';
import { useNavigate } from 'react-router';
import { usePresenceStore } from '../../stores/presenceStore';
import { Tooltip } from '../ui/Tooltip';
import { HomeSectionHeader } from './HomeSectionHeader';
import { resolveUserAvatarUrl } from '../../lib/userAvatar';
import { displayName } from '../../lib/displayName';
import { cn } from '../../lib/utils';
import type { Activity, User } from '../../types';

const STATUS_RING: Record<string, string> = {
  online: 'bg-status-online',
  idle: 'bg-status-idle',
  dnd: 'bg-status-dnd',
  streaming: 'bg-status-streaming',
};

const MAX_VISIBLE = 16;

export interface AroundFriend {
  user: User;
  status: string;
  /** Cheap activity / custom-status line when present. */
  activity?: string | null;
}

interface HomeAroundStripProps {
  friends: AroundFriend[];
  onMessage: (userId: string) => void;
}

/**
 * Horizontal presence strip for App Home — mirrors guild `AroundNowStrip` density
 * (avatars, not a full friends list). Click opens a DM via the parent handler.
 */
export function HomeAroundStrip({ friends, onMessage }: HomeAroundStripProps) {
  const navigate = useNavigate();

  if (friends.length === 0) return null;

  const visible = friends.slice(0, MAX_VISIBLE);
  const overflow = friends.length - visible.length;

  return (
    <section aria-label="Around now" className="flex flex-col">
      <HomeSectionHeader
        icon={<Users size={14} />}
        label="Around now"
        count={friends.length}
        action={
          <button
            type="button"
            onClick={() => navigate('/app/friends')}
            className="rounded-sm px-2 py-1 text-meta font-semibold text-accent-primary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-tint focus-visible:shadow-[var(--focus-ring)]"
          >
            Friends
          </button>
        }
      />

      <div className="flex flex-wrap items-center gap-2.5">
        {visible.map((f) => {
          const name = displayName(f.user);
          const src = resolveUserAvatarUrl(f.user.avatar_hash ?? f.user.avatar);
          const tip = f.activity ? `${name} — ${f.activity}` : name;
          return (
            <Tooltip key={f.user.id} content={tip} side="top">
              <button
                type="button"
                onClick={() => onMessage(f.user.id)}
                aria-label={`Message ${name}`}
                className="group relative outline-none focus-visible:shadow-[var(--focus-ring)]"
              >
                <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full bg-accent-tint text-label font-semibold text-accent-primary ring-2 ring-bg-primary transition-transform duration-[140ms] ease-[var(--ease-out)] group-hover:scale-[1.04]">
                  {src ? (
                    <img src={src} alt="" className="h-full w-full object-cover" />
                  ) : (
                    name.charAt(0).toUpperCase()
                  )}
                </div>
                <span
                  aria-hidden
                  className={cn(
                    'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-bg-primary',
                    STATUS_RING[f.status] || 'bg-status-offline',
                  )}
                />
              </button>
            </Tooltip>
          );
        })}
        {overflow > 0 && (
          <button
            type="button"
            onClick={() => navigate('/app/friends')}
            aria-label={`View ${overflow} more friends`}
            className="flex h-10 items-center rounded-full bg-bg-mod-strong px-3 text-meta font-semibold text-text-secondary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-accent hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
          >
            +{overflow}
          </button>
        )}
      </div>
    </section>
  );
}

/** Cheap activity / custom-status line from a presence activities array. */
export function activityLineFrom(activities: Activity[] | undefined): string | null {
  if (!activities?.length) return null;
  // Prefer custom status (type 4) when present; otherwise the first activity name.
  const custom = activities.find((a) => a.type === 4 || a.activity_type === 4);
  if (custom?.state) return custom.state;
  if (custom?.name) return custom.name;
  return activities[0]?.name ?? null;
}

/** Snapshot helper for callers that already hold a presence scope. */
export function friendActivityLine(userId: string, scope?: string): string | null {
  return activityLineFrom(usePresenceStore.getState().getPresence(userId, scope)?.activities);
}
