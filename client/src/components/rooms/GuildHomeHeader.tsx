import { useState } from 'react';
import { Coins, Radio, Settings, UserPlus, Users } from 'lucide-react';
import { useGuildStore } from '../../stores/guildStore';
import { useUIStore } from '../../stores/uiStore';
import { usePermissions } from '../../hooks/usePermissions';
import { canAccessGuildSettings } from '../../lib/guildSettingsAccess';
import { guildInitials, resolveGuildIconUrl } from '../../lib/guildIcon';
import { InviteModal } from '../guild/InviteModal';

interface GuildHomeHeaderProps {
  guildId: string;
  /** Online-member count for the "who's around now" summary. */
  onlineCount: number;
  /** Number of voice/stage rooms with at least one occupant. */
  liveRoomCount: number;
  /** Channel to encode into invite links (first text channel), if any. */
  inviteChannelId: string | null;
}

/**
 * Guild-home header — a solid raised surface (never a gradient hero, kill-list #1).
 * Fraunces space name, a presence-first "who's around now" summary, an invite
 * affordance, economy panel access, and a permission-gated settings entry.
 */
export function GuildHomeHeader({
  guildId,
  onlineCount,
  liveRoomCount,
  inviteChannelId,
}: GuildHomeHeaderProps) {
  const guild = useGuildStore((s) => s.guilds.find((g) => g.id === guildId));
  const setGuildSettingsId = useUIStore((s) => s.setGuildSettingsId);
  const setContextPanelMode = useUIStore((s) => s.setContextPanelMode);
  const { permissions, isAdmin } = usePermissions(guildId);
  const [showInvite, setShowInvite] = useState(false);

  if (!guild) return null;

  const canManage = canAccessGuildSettings(permissions, isAdmin);
  const iconSrc = resolveGuildIconUrl(guild);
  const initials = guildInitials(guild.name, 1);

  const summary =
    onlineCount === 0 && liveRoomCount === 0
      ? 'Quiet right now — start a room or drop the first message.'
      : null;

  return (
    <header className="shrink-0 border-b border-border-subtle bg-bg-secondary shadow-sm">
      <div className="flex items-center gap-4 px-6 py-5 sm:px-8">
        <div
          className="hidden h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-accent-tint text-2xl font-bold text-accent-primary shadow-sm sm:flex"
          aria-hidden="true"
        >
          {iconSrc ? (
            <img src={iconSrc} alt="" className="h-full w-full object-cover" />
          ) : (
            initials
          )}
        </div>

        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-title text-text-primary sm:text-display">
            {guild.name}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-label text-text-secondary">
            {summary ? (
              <span>{summary}</span>
            ) : (
              <>
                <span className="inline-flex items-center gap-1.5">
                  <Users size={15} className="text-accent-primary" />
                  <span className="tabular-nums">{onlineCount}</span>
                  {onlineCount === 1 ? 'person around' : 'people around'}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Radio
                    size={15}
                    className={liveRoomCount > 0 ? 'text-accent-primary' : 'text-text-muted'}
                  />
                  <span className="tabular-nums">{liveRoomCount}</span>
                  {liveRoomCount === 1 ? 'live room' : 'live rooms'}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {inviteChannelId && (
            <button
              type="button"
              onClick={() => setShowInvite(true)}
              aria-label="Invite people"
              title="Invite people"
              className="inline-flex h-9 items-center gap-1.5 rounded-sm bg-accent-primary px-3.5 text-label font-semibold text-text-on-accent shadow-sm outline-none transition-[background-color,transform] duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-primary-hover active:scale-[0.97] focus-visible:shadow-[var(--focus-ring)]"
            >
              <UserPlus size={16} aria-hidden />
              <span className="hidden sm:inline" aria-hidden>
                Invite
              </span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setContextPanelMode('economy')}
            aria-label="Space economy"
            title="Space economy"
            className="inline-flex h-9 w-9 items-center justify-center rounded-sm text-interactive-normal outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-interactive-hover focus-visible:shadow-[var(--focus-ring)]"
          >
            <Coins size={18} />
          </button>
          {canManage && (
            <button
              type="button"
              onClick={() => setGuildSettingsId(guildId)}
              aria-label="Space settings"
              title="Space settings"
              className="inline-flex h-9 w-9 items-center justify-center rounded-sm text-interactive-normal outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-interactive-hover focus-visible:shadow-[var(--focus-ring)]"
            >
              <Settings size={18} />
            </button>
          )}
        </div>
      </div>

      {showInvite && inviteChannelId && (
        <InviteModal
          guildName={guild.name}
          channelId={inviteChannelId}
          onClose={() => setShowInvite(false)}
        />
      )}
    </header>
  );
}
