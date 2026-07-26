import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { AlertCircle, Archive, Coins, Loader2, MessageSquare, Users, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { Channel, Message } from '../../types';
import { useUIStore } from '../../stores/uiStore';
import { useChannelStore } from '../../stores/channelStore';
import { channelApi } from '../../api/channels';
import { extractApiError } from '../../api/client';
import { MemberList } from './MemberList';
import { GroupDmMembersPanel } from './GroupDmMembersPanel';
import { ThreadPanel } from '../message/ThreadPanel';
import { PinnedMessagesOverlay } from './overlays/PinnedMessagesOverlay';
import { SearchOverlay } from './overlays/SearchOverlay';
import { GuildEconomyPanel } from '../guild/GuildEconomyPanel';

/**
 * Descriptor for the active thread surface. Supplied by the ChatView or derived
 * from the active channel when the user is inside a thread.
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
  /**
   * When true, move focus into the panel on open and restore it to the trigger
   * on close (desktop inline instance). Left false for the mobile overlay, whose
   * host dialog already runs a focus trap (WCAG 2.4.3).
   */
  manageFocus?: boolean;
}

/** Panel-native surfaces render inside the shared right-panel chrome. */
const PANEL_HEADERS: Record<'members' | 'economy', { title: string; icon: LucideIcon }> = {
  members: { title: 'Members', icon: Users },
  economy: { title: 'Server Economy', icon: Coins },
};

const isThreadChannel = (channel: Channel | undefined): boolean =>
  channel?.type === 6 || channel?.channel_type === 6;

const isThreadableChannel = (channel: Channel | undefined, channelId: string | null | undefined): boolean => {
  if (!channel || !channelId || isThreadChannel(channel)) return false;
  const type = channel?.type ?? channel?.channel_type ?? 0;
  return type === 0 || type === 5 || type === 7;
};

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

function sortThreads(threads: Channel[]): Channel[] {
  return [...threads].sort((a, b) => {
    const aArchived = a.thread_metadata?.archived === true;
    const bArchived = b.thread_metadata?.archived === true;
    if (aArchived !== bArchived) return aArchived ? 1 : -1;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
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
 *   threads  → active ThreadPanel, or a channel-scoped thread list
 *   pins     → components/layout/overlays/PinnedMessagesOverlay.tsx
 *   search   → components/layout/overlays/SearchOverlay.tsx
 *   economy  → components/guild/GuildEconomyPanel.tsx
 *   null     → nothing
 *
 * Visual law: Card/panel recipe (design-spec §7) — `bg-bg-secondary`, a
 * `border-border-subtle` hairline on the left edge, real elevation, and no
 * gradient hero (kill-list #1). `members` and `economy` are wrapped in the
 * shared panel chrome (title + close, focus-visible ring on close). `threads`,
 * `pins`, and `search` are self-chromed panel-native surfaces; the AppShell
 * supplies their modal containment only on narrow screens. ContextPanel wires
 * each surface's close to clear `contextPanelMode`. Esc-to-close is wired only where the panel owns focus and
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
  manageFocus = false,
}: ContextPanelProps) {
  const mode = useUIStore((s) => s.contextPanelMode);
  const setContextPanelMode = useUIStore((s) => s.setContextPanelMode);
  const channelsById = useChannelStore((s) => s.channelsById);
  const navigate = useNavigate();
  const asideRef = useRef<HTMLElement>(null);

  // The pins/search surfaces are rendered by the shell, not the ChatView, so the
  // ChatView can no longer feed them props. Self-provision from the channel store:
  // the search channel name + the cross-channel list for per-result attribution,
  // and (for pins) fetch the channel's pins on open — the overlay only refetches
  // after an unpin, so without this the pins surface is permanently empty.
  const controlledPins = pins !== undefined;
  const [fetchedPins, setFetchedPins] = useState<Message[]>([]);
  const [fetchedPinsError, setFetchedPinsError] = useState<string | null>(null);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [fetchedThreadParentIds, setFetchedThreadParentIds] = useState<Set<string>>(() => new Set());

  const resolvedChannelName =
    channelName ?? (channelId ? channelsById[channelId]?.name ?? null : null);
  const activeChannel = channelId ? channelsById[channelId] : undefined;
  const threadListParentId =
    mode === 'threads' && isThreadableChannel(activeChannel, channelId) ? channelId! : null;
  const channelThreads = useMemo(
    () =>
      sortThreads(
        Object.values(channelsById).filter(
          (channel) => isThreadChannel(channel) && channel.parent_id === threadListParentId,
        ),
      ),
    [channelsById, threadListParentId],
  );

  const resolvedAllChannels = useMemo(
    () =>
      allChannels
      ?? Object.values(channelsById).map((c) => ({
        id: c.id,
        guild_id: c.guild_id,
        name: c.name,
      })),
    [allChannels, channelsById],
  );

  useEffect(() => {
    if (mode !== 'pins' || controlledPins || !channelId) return;
    let cancelled = false;
    setFetchedPinsError(null);
    channelApi
      .getPins(channelId)
      .then(({ data }) => {
        if (!cancelled) setFetchedPins(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setFetchedPins([]);
          setFetchedPinsError(`Failed to load pinned messages: ${extractApiError(err)}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [mode, channelId, controlledPins]);

  useEffect(() => {
    if (!threadListParentId) return;
    let cancelled = false;
    setThreadsLoading(true);
    setThreadsError(null);
    const upsert = useChannelStore.getState();
    Promise.all([
      channelApi.getThreads(threadListParentId),
      channelApi.getArchivedThreads(threadListParentId),
    ])
      .then(([activeRes, archivedRes]) => {
        if (cancelled) return;
        for (const thread of [...activeRes.data, ...archivedRes.data]) {
          upsert.addChannel(thread);
          upsert.updateChannel(thread);
        }
      })
      .catch((err) => {
        if (!cancelled) setThreadsError(`Failed to load threads: ${extractApiError(err)}`);
      })
      .finally(() => {
        if (!cancelled) {
          setFetchedThreadParentIds((prev) => new Set(prev).add(threadListParentId));
          setThreadsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [threadListParentId]);

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

  // Desktop: this complementary region is mounted only while open, so on mount we
  // remember the trigger and move focus into the panel; on unmount (Escape/close)
  // we restore focus to the trigger — mirroring the CommandPalette returnFocusRef
  // pattern so keyboard/AT users are told the panel appeared and keep their place.
  useEffect(() => {
    if (!manageFocus) return;
    const trigger =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const raf = requestAnimationFrame(() => asideRef.current?.focus());
    return () => {
      cancelAnimationFrame(raf);
      if (trigger && document.contains(trigger)) trigger.focus();
    };
  }, [manageFocus]);

  if (mode === null) return null;

  // Panel-native query surfaces bring their own chrome; their close button is
  // wired to clear the shared panel mode.
  if (mode === 'pins') {
    return (
      <PinnedMessagesOverlay
        open
        presentation="panel"
        panelRef={asideRef}
        onClose={close}
        channelId={channelId ?? undefined}
        pins={controlledPins ? pins ?? [] : fetchedPins}
        onPinsChange={onPinsChange ?? setFetchedPins}
        error={controlledPins ? pinsError ?? null : fetchedPinsError}
        onErrorChange={onPinsErrorChange ?? setFetchedPinsError}
      />
    );
  }

  if (mode === 'search') {
    return (
      <SearchOverlay
        open
        presentation="panel"
        panelRef={asideRef}
        onClose={close}
        channelId={channelId ?? undefined}
        channelName={resolvedChannelName ?? undefined}
        allChannels={resolvedAllChannels}
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
    if (!thread && threadListParentId && threadGuildId) {
      const openThread = (threadId: string) => {
        useChannelStore.getState().selectChannel(threadId);
        navigate(`/app/guilds/${threadGuildId}/channels/${threadId}`);
      };
      const hasFetchedThreads = fetchedThreadParentIds.has(threadListParentId);
      return (
        <aside
          ref={asideRef}
          role="complementary"
          aria-label="Threads"
          tabIndex={-1}
          onKeyDown={onAsideKeyDown}
          data-testid="context-panel"
          data-mode="threads"
          className="flex h-full shrink-0 flex-col overflow-hidden border-l border-border-subtle bg-bg-secondary shadow-sm outline-none"
          style={{ width: 'var(--member-list-width)' }}
        >
          <header className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-4 py-3">
            <MessageSquare size={18} className="shrink-0 text-text-secondary" aria-hidden />
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-label font-semibold text-text-primary">Threads</h2>
              <p className="truncate text-meta text-text-muted">#{resolvedChannelName || 'channel'}</p>
            </div>
            <button
              type="button"
              className={CLOSE_BUTTON}
              onClick={close}
              aria-label="Close Threads panel"
              title="Close"
            >
              <X size={18} aria-hidden />
            </button>
          </header>

          {threadsError ? (
            <div className="flex min-h-0 flex-1 flex-col items-start justify-center px-5 text-left">
              <AlertCircle size={22} className="mb-3 text-danger" aria-hidden />
              <h3 className="text-subhead text-text-primary">Threads unavailable</h3>
              <p className="mt-1 text-label text-text-secondary">{threadsError}</p>
            </div>
          ) : (threadsLoading || !hasFetchedThreads) && channelThreads.length === 0 ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-text-secondary">
              <Loader2 size={20} className="animate-spin" aria-hidden />
            </div>
          ) : channelThreads.length === 0 ? (
            <div className="flex min-h-0 flex-1 flex-col items-start justify-center px-5 text-left">
              <MessageSquare size={24} className="mb-3 text-text-muted" aria-hidden />
              <h3 className="text-subhead text-text-primary">No threads yet</h3>
              <p className="mt-1 text-label text-text-secondary">Threaded conversations will appear here.</p>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              <div className="flex flex-col gap-1">
                {channelThreads.map((thread) => {
                  const isArchived = thread.thread_metadata?.archived === true;
                  return (
                    <button
                      key={thread.id}
                      type="button"
                      onClick={() => openThread(thread.id)}
                      className="flex min-h-[44px] w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle focus-visible:shadow-[var(--focus-ring)]"
                    >
                      {isArchived ? (
                        <Archive size={16} className="shrink-0 text-text-muted" aria-hidden />
                      ) : (
                        <MessageSquare size={16} className="shrink-0 text-accent-primary" aria-hidden />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-label font-medium text-text-primary">
                          {thread.name || 'Thread'}
                        </span>
                        {isArchived && (
                          <span className="text-meta uppercase text-text-muted">Archived</span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </aside>
      );
    }
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
      ref={asideRef}
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
        {mode === 'members' ? <MemberList hideStatsHeader /> : <GuildEconomyPanel guildId={guildId as string} />}
      </div>
    </aside>
  );
}
