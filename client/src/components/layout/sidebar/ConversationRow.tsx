import { memo } from 'react';
import { Hash, Volume2, MessageSquare, MessagesSquare } from 'lucide-react';
import { usePresenceStore } from '../../../stores/presenceStore';
import { safeStoredImageDataUrl } from '../../../lib/security';
import { cn } from '../../../lib/utils';
import type { ConversationEntry } from '../../../lib/attention/conversationModel';

/**
 * Heterogeneous sidebar conversation row (layout-spec §7.7; design-spec §7 Nav item,
 * §1.2/§1.5). The single row primitive consumed by NeedsYou / PinnedRail / RecentList.
 *
 * Nav-item base (34px, --radius-sm). Active = --accent-tint fill + a 3px teal
 * (--accent-secondary) left edge bar + --text-primary. The leading element is
 * chosen by `entry.kind`:
 *   - guild_text / voice / thread → lucide line icon + small --text-muted context label
 *   - dm                          → avatar + presence dot (presence read PER ROW, §3.2)
 *   - group_dm                    → group avatar (no single presence subject)
 *   - guild_home                  → guild (squircle) avatar
 *
 * Presence is looked up here — NOT in the parent memo — so a presence tick re-renders
 * only the affected row, never the whole cross-server list (layout-spec §3.2). Tokens
 * only, lucide line icons (kill-list #2/#3).
 */

const STATUS_COLORS: Record<string, string> = {
  online: 'bg-status-online',
  idle: 'bg-status-idle',
  dnd: 'bg-status-dnd',
  streaming: 'bg-status-streaming',
  offline: 'bg-status-offline',
};

/** Presence dot that runs its OWN store selector so only this row re-renders on a tick. */
function PresenceDot({ userId, scope }: { userId?: string | null; scope?: string }) {
  const status = usePresenceStore((s) =>
    userId ? s.getPresence(userId, scope)?.status ?? 'offline' : 'offline',
  );
  return (
    <span
      data-testid="presence-dot"
      data-status={status}
      aria-hidden
      className={cn(
        'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-bg-secondary',
        STATUS_COLORS[status] ?? STATUS_COLORS.offline,
      )}
    />
  );
}

const AVATAR_KINDS = new Set<ConversationEntry['kind']>(['dm', 'group_dm', 'guild_home']);

function LeadingAvatar({ entry }: { entry: ConversationEntry }) {
  const { kind, title, userId, serverId, avatar } = entry;
  const isGroup = kind === 'group_dm';
  const isGuildHome = kind === 'guild_home';
  // Render the real stored avatar (matching AroundNowStrip / OccupantStack), with
  // an initials / group-icon chip as the fallback (design-spec §7 Avatar recipe).
  const src = safeStoredImageDataUrl(avatar);
  return (
    <span className="relative shrink-0">
      <span
        className={cn(
          'flex h-6 w-6 items-center justify-center overflow-hidden bg-bg-mod-strong text-meta font-semibold text-text-secondary',
          isGuildHome ? 'rounded-md' : 'rounded-full',
        )}
      >
        {src ? (
          <img src={src} alt="" className="h-full w-full object-cover" />
        ) : isGroup ? (
          <MessagesSquare size={13} aria-hidden />
        ) : (
          (title.charAt(0) || '?').toUpperCase()
        )}
      </span>
      {kind === 'dm' && <PresenceDot userId={userId} scope={serverId} />}
    </span>
  );
}

function LeadingIcon({ entry, active }: { entry: ConversationEntry; active: boolean }) {
  const Icon = entry.kind === 'voice' ? Volume2 : entry.kind === 'thread' ? MessageSquare : Hash;
  return (
    <Icon
      size={18}
      aria-hidden
      className={cn('shrink-0', active ? 'text-accent-primary' : 'text-channel-icon')}
    />
  );
}

export interface ConversationRowProps {
  entry: ConversationEntry;
  active?: boolean;
  /** Parent supplies navigation; the actual arrow handler lands in SHELL-5. */
  onClick: (entry: ConversationEntry) => void;
  /** Roving-tabindex ordinal (data-nav-index); the handler is wired by the sidebar. */
  navIndex?: number;
  /** Roving-tabindex value — SHELL-5 sets 0 on the active row, -1 elsewhere. */
  tabIndex?: number;
}

function ConversationRowComponent({
  entry,
  active = false,
  onClick,
  navIndex,
  tabIndex,
}: ConversationRowProps) {
  const { kind, title, contextLabel, unread, mentionCount, hasVoiceActivity } = entry;
  const useAvatar = AVATAR_KINDS.has(kind);
  const showMention = mentionCount > 0;
  const showUnreadDot = unread && !active && !showMention;

  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      aria-current={active ? 'page' : undefined}
      data-nav-index={navIndex}
      tabIndex={tabIndex}
      onClick={() => onClick(entry)}
      className={cn(
        'group relative flex h-[34px] w-full items-center gap-2 rounded-sm px-2 text-left outline-none',
        'transition-colors duration-[140ms] ease-[var(--ease-out)]',
        'focus-visible:shadow-[var(--focus-ring)]',
        active
          ? 'bg-accent-tint text-text-primary'
          : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary',
      )}
    >
      {active && (
        <span
          aria-hidden
          className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-accent-secondary"
        />
      )}

      {useAvatar ? <LeadingAvatar entry={entry} /> : <LeadingIcon entry={entry} active={active} />}

      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className={cn('truncate text-label', unread && !active && 'font-semibold text-text-primary')}>
          {title}
        </span>
        {contextLabel && (
          <span className="truncate text-meta text-text-muted">{contextLabel}</span>
        )}
      </span>

      <span className="flex shrink-0 items-center gap-1.5">
        {hasVoiceActivity && (
          <span
            data-testid="voice-live-indicator"
            aria-label="Active voice"
            className="h-1.5 w-1.5 rounded-full bg-accent-primary shadow-[0_0_6px_rgba(var(--accent-primary-rgb),0.55)]"
          />
        )}
        {showMention && (
          <span
            data-testid="mention-badge"
            className="flex h-4 min-w-4 items-center justify-center rounded-xs bg-accent-primary px-1 text-meta font-semibold tabular-nums text-text-on-accent"
          >
            {mentionCount > 99 ? '99+' : mentionCount}
          </span>
        )}
        {showUnreadDot && (
          <span
            data-testid="unread-dot"
            aria-label="Unread"
            className="h-2 w-2 rounded-full bg-accent-primary"
          />
        )}
      </span>
    </button>
  );
}

/**
 * `useUnifiedConversations` rebuilds fresh entry objects on every MESSAGE_CREATE
 * across every connected server, so the merged Needs-you / Recent arrays get new
 * identities constantly. Without memoization the entire row set reconciles on each
 * message — work that scales with channel count while message rate ALSO scales with
 * channel count (the per-message re-render storm). Compare the entry's meaningful
 * fields instead of identity so a row only re-renders when its own display data
 * changes; the presence dot keeps its own store subscription and updates
 * independently of this comparator.
 */
function propsAreEqual(a: ConversationRowProps, b: ConversationRowProps): boolean {
  if (
    a.active !== b.active
    || a.navIndex !== b.navIndex
    || a.tabIndex !== b.tabIndex
    || a.onClick !== b.onClick
  ) {
    return false;
  }
  const x = a.entry;
  const y = b.entry;
  return (
    x.key === y.key
    && x.kind === y.kind
    && x.title === y.title
    && x.contextLabel === y.contextLabel
    && x.unread === y.unread
    && x.mentionCount === y.mentionCount
    && x.hasVoiceActivity === y.hasVoiceActivity
    && x.userId === y.userId
    && x.serverId === y.serverId
    && x.avatar === y.avatar
  );
}

export const ConversationRow = memo(ConversationRowComponent, propsAreEqual);
