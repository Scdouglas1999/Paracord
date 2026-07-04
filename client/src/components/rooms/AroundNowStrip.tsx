import { useMemo } from 'react';
import { Users } from 'lucide-react';
import { useMemberStore } from '../../stores/memberStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { useGuildStore } from '../../stores/guildStore';
import { useServerListStore } from '../../stores/serverListStore';
import { useUIStore } from '../../stores/uiStore';
import { Tooltip } from '../ui/Tooltip';
import { safeStoredImageDataUrl } from '../../lib/security';
import { cn } from '../../lib/utils';
import type { Member } from '../../types';

interface AroundNowStripProps {
  guildId: string;
}

const STATUS_RING: Record<string, string> = {
  online: 'bg-status-online',
  idle: 'bg-status-idle',
  dnd: 'bg-status-dnd',
  streaming: 'bg-status-streaming',
};

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
  const members = useMemberStore((s) => s.members.get(guildId));
  const presences = usePresenceStore((s) => s.presences);
  const getPresence = usePresenceStore((s) => s.getPresence);
  const setContextPanelMode = useUIStore((s) => s.setContextPanelMode);

  // Resolve the guild's originating server so presence reads the right scope.
  const guildServerUrl = useGuildStore(
    (s) => s.guilds.find((g) => g.id === guildId)?.server_url,
  );
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
        <div className="flex items-center gap-2 text-section uppercase text-text-muted">
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
          return (
            <Tooltip key={m.user.id} content={name} side="top">
              <div className="relative">
                <div
                  aria-label={name}
                  className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-accent-primary text-meta font-semibold text-text-on-accent ring-2 ring-bg-secondary"
                >
                  {src ? (
                    <img src={src} alt="" className="h-full w-full object-cover" />
                  ) : (
                    name.charAt(0).toUpperCase()
                  )}
                </div>
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-bg-secondary',
                    STATUS_RING[status] || 'bg-status-offline',
                  )}
                />
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
