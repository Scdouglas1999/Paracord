import { useCurrentAccountScope } from '../../hooks/useCurrentUser';
import { entityScopeKey as memberScopeKey } from '../../lib/serverScope';
import { useMemo } from 'react';
import { Users } from 'lucide-react';
import { useMemberStore } from '../../stores/memberStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { useGuild } from '../../hooks/useGuilds';
import { useServerListStore } from '../../stores/serverListStore';
import { useUIStore } from '../../stores/uiStore';
import { Tooltip } from '../ui/Tooltip';
import { safeStoredImageDataUrl } from '../../lib/security';
import { cn } from '../../lib/utils';
import { presenceLight } from '../../lib/presence';
import type { Member } from '../../types';

interface AroundNowStripProps {
  guildId: string;
}

const MAX_VISIBLE = 16;

function memberName(m: Member): string {
  return m.nick || m.user.display_name || m.user.username || 'Member';
}

/**
 * Presence-first "Around now" strip — the guild's online members surfaced as
 * ringed avatars (the full member list stays reachable via the ContextPanel).
 * Presence is looked up under the guild's own server scope so multi-server
 * membership never bleeds across connections.
 */
export function AroundNowStrip({ guildId }: AroundNowStripProps) {
  const memberScope = useCurrentAccountScope();
  const members = useMemberStore((s) => (memberScope ? s.members.get(memberScopeKey(memberScope, guildId)) : undefined));
  const presences = usePresenceStore((s) => s.presences);
  const getPresence = usePresenceStore((s) => s.getPresence);
  const setContextPanelMode = useUIStore((s) => s.setContextPanelMode);

  // Resolve the guild's originating server so presence reads the right scope.
  const guildServerUrl = useGuild(guildId)?.server_url;
  const activeServerId = useServerListStore((s) => s.activeServerId);
  const getServerByUrl = useServerListStore((s) => s.getServerByUrl);
  const scope = useMemo(() => {
    const resolved = guildServerUrl ? getServerByUrl(guildServerUrl)?.id : undefined;
    return resolved ?? activeServerId ?? undefined;
  }, [guildServerUrl, getServerByUrl, activeServerId]);

  const online = useMemo(() => {
    if (!members) return [] as Member[];
    return members.filter(
      (m) => (getPresence(m.user.id, scope)?.status || 'offline') !== 'offline',
    );
    // presences is a dep so the strip re-derives when a presence tick lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, presences, getPresence, scope]);

  if (online.length === 0) return null;

  const visible = online.slice(0, MAX_VISIBLE);
  const overflow = online.length - visible.length;

  return (
    <section aria-label="Around now" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-section text-text-muted">
          <Users size={14} className="text-interactive-normal" />
          <span>Around now</span>
          <span className="tabular-nums text-text-secondary">{online.length}</span>
        </div>
        <button
          type="button"
          onClick={() => setContextPanelMode('members')}
          className="rounded-sm px-2 py-1 text-meta font-semibold text-accent-primary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-tint focus-visible:shadow-[var(--focus-ring)]"
        >
          View all
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {visible.map((m) => {
          const status = getPresence(m.user.id, scope)?.status || 'offline';
          const src = safeStoredImageDataUrl(m.user.avatar_hash);
          const name = memberName(m);
          const light = presenceLight(status);
          return (
            <Tooltip key={m.user.id} content={`${name} — ${light.label}`} side="top">
              <div className="relative">
                <div
                  aria-label={name}
                  className={cn(
                    'flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-accent-primary text-meta font-semibold text-text-on-accent',
                    light.avatarClass,
                    light.dnd && 'pc-dnd',
                  )}
                >
                  {src ? (
                    <img src={src} alt="" className="h-full w-full object-cover" />
                  ) : (
                    name.charAt(0).toUpperCase()
                  )}
                </div>
                <span className="sr-only">{light.label}</span>
              </div>
            </Tooltip>
          );
        })}
        {overflow > 0 && (
          <button
            type="button"
            onClick={() => setContextPanelMode('members')}
            aria-label={`View ${overflow} more members`}
            className="flex h-9 items-center rounded-full bg-bg-mod-strong px-2.5 text-meta font-semibold text-text-secondary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-accent hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
          >
            +{overflow}
          </button>
        )}
      </div>
    </section>
  );
}
