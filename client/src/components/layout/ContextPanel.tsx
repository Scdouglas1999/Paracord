import { useCallback } from 'react';
import type { KeyboardEvent } from 'react';
import { Coins, Users, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Channel, Message } from '../../types';
import { useUIStore } from '../../stores/uiStore';
import { useChannelStore } from '../../stores/channelStore';
import { MemberList } from './MemberList';
import { GroupDmMembersPanel } from './GroupDmMembersPanel';
import { ThreadPanel } from '../message/ThreadPanel';
import { PinnedMessagesOverlay } from './overlays/PinnedMessagesOverlay';
import { SearchOverlay } from './overlays/SearchOverlay';
import { GuildEconomyPanel } from '../guild/GuildEconomyPanel';

/**
 * Descriptor for the active thread surface. Supplied by the ChatView; when
 * absent the `threads` mode renders nothing (there is no thread to show).
 */
export interface ContextPanelThread {
  threadChannelId: string;
  threadName: string;
  parentChannelName: string;
}

export interface ContextPanelProps {
  /** Active guild id — required for the `economy` and `threads` surfaces. */
  guildId?: string | null;
  /** Active channel id — scopes the `search` and `pins` surfaces. */
  channelId?: string | null;
  /** Active channel display name — labels the `search` surface. */
  channelName?: string | null;
  /** Channels available to cross-channel search. */
  allChannels?: Array<{ id: string; guild_id?: string | null; name?: string | null }>;
  /** Pinned messages (fetched + owned by the ChatView). */
  pins?: Message[];
  onPinsChange?: (pins: Message[]) => void;
  pinsError?: string | null;
  onPinsErrorChange?: (error: string | null) => void;
  /** Active thread descriptor for the `threads` surface. */
  activeThread?: ContextPanelThread | null;
}

/** Panel-native surfaces render inside the shared right-panel chrome. */
const PANEL_HEADERS: Record<'members' | 'economy', { title: string; icon: LucideIcon }> = {
  members: { title: 'Members', icon: Users },
  economy: { title: 'Server Economy', icon: Coins },
};

const isThreadChannel = (channel: Channel | undefined): boolean =>
  channel?.type === 6 || channel?.channel_type === 6;

const isGroupDmChannel = (channel: Channel | undefined): boolean =>
  channel?.type === 3 || channel?.channel_type === 3;

/**
 * Derive the active-thread descriptor from the current channel when the ChatView
 * has not supplied one explicitly. A thread channel (type 6) surfaces its own
 * conversation in the `threads` mode, with its parent channel name for context.
 */
function deriveActiveThread(
  channelId: string | null | undefined,
  channelsById: Record<string, Channel>,
): ContextPanelThread | null {
  if (!channelId) return null;
  const channel = channelsById[channelId];
  if (!isThreadChannel(channel)) return null;
  const parent = channel?.parent_id ? channelsById[channel.parent_id] : undefined;
  return {
    threadChannelId: channel!.id,
    threadName: channel!.name || 'Thread',
    parentChannelName: parent?.name || 'unknown',
  };
}

const CLOSE_BUTTON =
  'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-sm text-text-muted ' +
  'outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] ' +
  'hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]';

/**
 * The toggleable, non-docked right panel (layout-spec §1 / §2). Reads
 * `contextPanelMode` from `uiStore` — the single source of truth — and switches
 * across the already-built surfaces without rebuilding any of them:
 *
 *   members  → components/layout/MemberList.tsx
 *   threads  → components/message/ThreadPanel.tsx
 *   pins     → components/layout/overlays/PinnedMessagesOverlay.tsx
 *   search   → components/layout/overlays/SearchOverlay.tsx
 *   economy  → components/guild/GuildEconomyPanel.tsx
 *   null     → nothing
 *
 * Visual law: Card/panel recipe (design-spec §7) — `bg-bg-secondary`, a
 * `border-border-subtle` hairline on the left edge, real elevation, and no
 * gradient hero (kill-list #1). `members` and `economy` are wrapped in the
 * shared panel chrome (title + close, focus-visible ring on close). `threads`,
 * `pins`, and `search` are self-chromed surfaces (ThreadPanel's own header;
 * the two overlay modals); ContextPanel wires each surface's close to clear
 * `contextPanelMode`. Esc-to-close is wired only where the panel owns focus and
 * contains no text input (members/economy); global Esc precedence is SHELL-5.
 */
export function ContextPanel({
  guildId,
  channelId,
  channelName,
  allChannels,
  pins,
  onPinsChange,
  pinsError,
  onPinsErrorChange,
  activeThread,
}: ContextPanelProps) {
  const mode = useUIStore((s) => s.contextPanelMode);
  const setContextPanelMode = useUIStore((s) => s.setContextPanelMode);
  const channelsById = useChannelStore((s) => s.channelsById);

  const close = useCallback(() => setContextPanelMode(null), [setContextPanelMode]);

  const onAsideKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    },
    [close],
  );

  if (mode === null) return null;

  // Overlay surfaces bring their own chrome (title + close); their close button
  // is wired to clear the panel mode.
  if (mode === 'pins') {
    return (
      <PinnedMessagesOverlay
        open
        onClose={close}
        channelId={channelId ?? undefined}
        pins={pins ?? []}
        onPinsChange={onPinsChange ?? (() => {})}
        error={pinsError ?? null}
        onErrorChange={onPinsErrorChange}
      />
    );
  }

  if (mode === 'search') {
    return (
      <SearchOverlay
        open
        onClose={close}
        channelId={channelId ?? undefined}
        channelName={channelName ?? undefined}
        allChannels={allChannels ?? []}
      />
    );
  }

  // Group-DM recipients live in the shared `members` surface (layout-spec §2).
  // The panel is self-chromed (own header + Add + close), so short-circuit before
  // the guild MemberList chrome below.
  if (mode === 'members') {
    const activeChannel = channelId ? channelsById[channelId] : undefined;
    if (isGroupDmChannel(activeChannel)) {
      return <GroupDmMembersPanel channelId={channelId as string} onClose={close} />;
    }
  }

  // ThreadPanel is a self-chromed inline panel (its own header + close). Give it
  // the panel width and let its own left hairline serve as the divider. The
  // active thread is supplied by the ChatView or derived from the current
  // (thread) channel.
  if (mode === 'threads') {
    const thread = activeThread ?? deriveActiveThread(channelId, channelsById);
    const threadGuildId = guildId ?? (channelId ? channelsById[channelId]?.guild_id ?? null : null);
    if (!thread || !threadGuildId) return null;
    return (
      <div
        className="flex h-full shrink-0 flex-col"
        style={{ width: 'var(--member-list-width)' }}
        data-testid="context-panel"
        data-mode="threads"
      >
        <ThreadPanel
          guildId={threadGuildId}
          threadChannelId={thread.threadChannelId}
          threadName={thread.threadName}
          parentChannelName={thread.parentChannelName}
          onClose={close}
        />
      </div>
    );
  }

  // Economy needs a guild to resolve a leaderboard.
  if (mode === 'economy' && !guildId) return null;

  const header = PANEL_HEADERS[mode];

  return (
    <aside
      role="complementary"
      aria-label={header.title}
      tabIndex={-1}
      onKeyDown={onAsideKeyDown}
      data-testid="context-panel"
      data-mode={mode}
      className="flex h-full shrink-0 flex-col overflow-hidden border-l border-border-subtle bg-bg-secondary shadow-sm outline-none"
      style={{ width: 'var(--member-list-width)' }}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-4 py-3">
        <header.icon size={18} className="shrink-0 text-text-secondary" aria-hidden />
        <h2 className="min-w-0 flex-1 truncate text-subhead text-text-primary">{header.title}</h2>
        <button
          type="button"
          onClick={close}
          className={CLOSE_BUTTON}
          aria-label={`Close ${header.title} panel`}
        >
          <X size={18} aria-hidden />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {mode === 'members' ? <MemberList /> : <GuildEconomyPanel guildId={guildId as string} />}
      </div>
    </aside>
  );
}
