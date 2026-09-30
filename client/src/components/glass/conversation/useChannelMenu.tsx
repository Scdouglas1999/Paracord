import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  HelpCircle,
  Hash,
  Image as ImageIcon,
  Inbox,
  Loader2,
  MessagesSquare,
  Pin,
  Settings,
  Share2,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import { channelApi } from '../../../api/channels';
import { extractApiError } from '../../../api/client';
import { useCurrentChannelStore } from '../../../hooks/useChannels';
import { useCurrentAccountScope } from '../../../hooks/useCurrentUser';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { useMutedGuilds } from '../../../hooks/useMutedGuilds';
import { usePermissions } from '../../../hooks/usePermissions';
import { useCurrentReadStates } from '../../../hooks/useReadStates';
import { isMessageUnread } from '../../../hooks/useUnreadCounts';
import { canAccessGuildSettings } from '../../../lib/guildSettingsAccess';
import { entityScopeKey } from '../../../lib/serverScope';
import { useReadStateStore } from '../../../stores/readStateStore';
import { useUIStore } from '../../../stores/uiStore';
import type { ReadState } from '../../../types';
import type { ConversationSubject } from '../shell/slots';
import type { ContextMenuItem } from '../../ui/ContextMenu';
import { HelpOverlay } from '../../layout/overlays/HelpOverlay';
import { InboxOverlay } from '../../layout/overlays/InboxOverlay';
import { TopBarOverlay } from '../../layout/overlays/TopBarOverlay';
import { toggleContextPanel } from './sheetBridge';

/**
 * The channel menu behind the conversation title (docs/glass-spec.md §3.2,
 * WP-G11), with the dialogs its rows open.
 *
 * INTERIM (WP-G11 → WP-G18): these are the actions the Lantern header's
 * "More" menu carried, moved here unchanged so nothing in the product becomes
 * unreachable when the header is replaced. WP-G18 builds the real channel menu
 * (`glassStore.sheet === 'channel'`) and takes this hook, its dialogs and the
 * shared overlays over. Search and people are not here: they have their own
 * header buttons.
 *
 * Counts on pins and threads (a Lantern header nicety) are not carried; the
 * Glass header has no room for them and the panels list their own contents.
 */

export interface ChannelMenuInput {
  subject: ConversationSubject;
  /** Whether the server allows a catch-up summary here, and why not. */
  summary: { allowed: boolean; reason: string | null };
}

export interface ChannelMenu {
  items: ContextMenuItem[];
  /** The dialogs the rows open. Render once, anywhere in the header. */
  dialogs: ReactNode;
  /** Unread conversations and mentions elsewhere (the inbox row's caption). */
  attention: { unread: number; mentions: number };
}

export function attentionCaption(unread: number, mentions: number): string {
  const conversations = `${unread} unread conversation${unread === 1 ? '' : 's'}`;
  return mentions > 0
    ? `${mentions} mention${mentions === 1 ? '' : 's'} in ${conversations}`
    : unread > 0
      ? conversations
      : 'No unread conversations';
}

export function useChannelMenu({ subject, summary }: ChannelMenuInput): ChannelMenu {
  const isDM = subject.kind === 'dm';
  const channelId = subject.channelId;
  const guildId = subject.kind === 'channel' ? subject.guildId : undefined;

  const channelsById = useCurrentChannelStore((s) => s.channelsById);
  const channelsByGuild = useCurrentChannelStore((s) => s.channelsByGuild);
  const selectedChannel = channelsById[channelId];
  const allChannels = useMemo(() => Object.values(channelsById), [channelsById]);
  const isAnnouncement = selectedChannel?.type === 5 || selectedChannel?.channel_type === 5;

  const { permissions, isAdmin } = usePermissions(isDM ? null : (guildId ?? null));
  const canOpenServerSettings = !isDM && Boolean(guildId) && canAccessGuildSettings(permissions, isAdmin);

  const readScope = useCurrentAccountScope();
  const readStateRecord = useCurrentReadStates();
  const readStates = useMemo(() => Object.values(readStateRecord), [readStateRecord]);
  const { mutedGuildKeys } = useMutedGuilds();

  const [showFollowManager, setShowFollowManager] = useState(false);
  const [followers, setFollowers] = useState<
    Array<{ id: string; target_channel_id: string; target_guild_id: string }>
  >([]);
  const [followersLoading, setFollowersLoading] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);
  const [followBusyTargetId, setFollowBusyTargetId] = useState<string | null>(null);
  const [showInbox, setShowInbox] = useState(false);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryText, setSummaryText] = useState('');
  const [summaryMeta, setSummaryMeta] = useState<{ provider: string; model: string; messageCount: number } | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const followDialogRef = useRef<HTMLDivElement>(null);
  const summaryDialogRef = useRef<HTMLDivElement>(null);

  const closeSurfaces = useCallback(() => {
    setShowFollowManager(false);
    setShowInbox(false);
    setShowHelp(false);
    setShowSummary(false);
  }, []);

  // One secondary surface at a time: a dialog replaces an open side panel, so
  // one Escape closes exactly one visible layer.
  const prepareSurface = useCallback(() => {
    closeSurfaces();
    useUIStore.getState().setContextPanelMode(null);
  }, [closeSurfaces]);

  useFocusTrap(followDialogRef as RefObject<HTMLDivElement | null>, showFollowManager, () => setShowFollowManager(false));
  useFocusTrap(summaryDialogRef as RefObject<HTMLDivElement | null>, showSummary, () => setShowSummary(false));

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!(showFollowManager || showInbox || showHelp || showSummary)) return;
      event.preventDefault();
      closeSurfaces();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeSurfaces, showFollowManager, showHelp, showInbox, showSummary]);

  // Read state lives in the shared store, kept live by dispatch and mark-read
  // call sites; pull an authoritative snapshot once on mount.
  useEffect(() => {
    void useReadStateStore.getState().refreshAll();
  }, []);

  const followTargets = useMemo(() => {
    if (!selectedChannel?.guild_id) return [];
    return (channelsByGuild[selectedChannel.guild_id] || []).filter(
      (channel) =>
        channel.id !== selectedChannel.id && (channel.type === 0 || channel.channel_type === 0),
    );
  }, [channelsByGuild, selectedChannel]);

  const unreadItems = useMemo(() => {
    const result: Array<{ state: ReadState; channelName: string }> = [];
    const stateByChannel = new Map(readStates.map((state) => [state.channel_id, state]));
    for (const channel of allChannels) {
      if (channel.id === channelId) continue;
      if (channel.guild_id && readScope && mutedGuildKeys.includes(entityScopeKey(readScope, channel.guild_id))) {
        continue;
      }
      if (!channel.last_message_id || channel.type === 4 || channel.channel_type === 4) continue;
      const state = stateByChannel.get(channel.id) ?? {
        channel_id: channel.id,
        last_message_id: '',
        mention_count: 0,
      };
      if (isMessageUnread(channel.last_message_id, state.last_message_id)) {
        result.push({ state, channelName: channel.name || state.channel_id });
      }
    }
    result.sort((a, b) => b.state.mention_count - a.state.mention_count);
    return result;
  }, [readStates, allChannels, mutedGuildKeys, channelId, readScope]);
  const mentions = unreadItems.reduce((total, item) => total + item.state.mention_count, 0);

  const openSummary = async () => {
    if (!summary.allowed) return;
    prepareSurface();
    setShowSummary(true);
    setSummaryLoading(true);
    setSummaryText('');
    setSummaryError(null);
    try {
      const { data } = await channelApi.summarizeChannel(channelId, 180);
      setSummaryText(data.summary);
      setSummaryMeta({ provider: data.provider, model: data.model, messageCount: data.message_count });
    } catch (err: unknown) {
      setSummaryError(`Failed to summarize channel: ${extractApiError(err)}`);
      setSummaryMeta(null);
    } finally {
      setSummaryLoading(false);
    }
  };

  const refreshFollowers = useCallback(async () => {
    setFollowersLoading(true);
    setFollowError(null);
    try {
      const { data } = await channelApi.getFollowers(channelId);
      setFollowers(
        data.map((entry) => ({
          id: entry.id,
          target_channel_id: entry.target_channel_id,
          target_guild_id: entry.target_guild_id,
        })),
      );
    } catch (err) {
      setFollowers([]);
      setFollowError(`Failed to load follows: ${extractApiError(err)}`);
    } finally {
      setFollowersLoading(false);
    }
  }, [channelId]);

  const openFollowManager = async () => {
    prepareSurface();
    setShowFollowManager(true);
    await refreshFollowers();
  };

  const changeFollow = async (targetChannelId: string, run: () => Promise<unknown>, failure: string) => {
    setFollowBusyTargetId(targetChannelId);
    setFollowError(null);
    try {
      await run();
      await refreshFollowers();
    } catch (err) {
      setFollowError(`${failure}: ${extractApiError(err)}`);
    } finally {
      setFollowBusyTargetId(null);
    }
  };

  const openInbox = async () => {
    prepareSurface();
    setInboxError(null);
    try {
      if (!readScope) throw new Error('Sign in to this instance before opening the inbox.');
      await useReadStateStore.getState().refresh(readScope);
    } catch (err) {
      setInboxError(`Failed to load inbox: ${extractApiError(err)}`);
    }
    setShowInbox(true);
  };

  const panel = (mode: Parameters<typeof toggleContextPanel>[0]) => () => {
    closeSurfaces();
    toggleContextPanel(mode);
  };

  const items: ContextMenuItem[] = [
    {
      label: 'Catch up summary',
      icon: <Sparkles size={17} />,
      action: () => void openSummary(),
      disabled: !summary.allowed,
      description: summary.reason ?? undefined,
    },
    { label: 'Pinned messages', icon: <Pin size={17} />, action: panel('pins') },
    ...(!isDM ? [{ label: 'Threads', icon: <MessagesSquare size={17} />, action: panel('threads') }] : []),
    ...(isAnnouncement
      ? [{ label: 'Manage follows', icon: <Share2 size={17} />, action: () => void openFollowManager() }]
      : []),
    { label: 'Media', icon: <ImageIcon size={17} />, action: panel('media') },
    ...(!isDM ? [{ label: 'Server leaderboard', icon: <TrendingUp size={17} />, action: panel('economy') }] : []),
    ...(canOpenServerSettings && guildId
      ? [{
          label: 'Server settings',
          icon: <Settings size={17} />,
          action: () => {
            prepareSurface();
            useUIStore.getState().setGuildSettingsId(guildId);
          },
        }]
      : []),
    { label: '', action: () => {}, divider: true },
    {
      label: 'Inbox',
      icon: <Inbox size={17} />,
      action: () => void openInbox(),
      description: attentionCaption(unreadItems.length, mentions),
    },
    { label: 'Keyboard shortcuts', icon: <HelpCircle size={17} />, action: () => { prepareSurface(); setShowHelp(true); } },
  ];

  const dialogs = (
    <>
      <TopBarOverlay
        open={showSummary}
        onClose={() => setShowSummary(false)}
        dialogRef={summaryDialogRef as RefObject<HTMLDivElement | null>}
        titleId="conversation-summary-title"
        title="Catch up summary"
        icon={Sparkles}
        closeLabel="Close summary"
        panelClassName="max-h-[min(82dvh,40rem)] w-full max-w-2xl"
        bodyClassName="p-4 sm:p-5"
      >
        {summaryLoading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-label text-text-muted">
            <Loader2 size={16} className="animate-spin" />
            <span>Reading the last few hours…</span>
          </div>
        ) : summaryError ? (
          <div
            role="alert"
            className="rounded-well border border-accent-danger/30 bg-danger-tint px-4 py-3 text-label text-accent-danger"
          >
            {summaryError}
          </div>
        ) : (
          <>
            {summaryMeta && (
              <div className="mb-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-meta text-text-muted">
                <span>Provider <span className="font-semibold text-text-secondary">{summaryMeta.provider}</span></span>
                <span aria-hidden>·</span>
                <span>Model <span className="font-semibold text-text-secondary">{summaryMeta.model}</span></span>
                <span aria-hidden>·</span>
                <span className="tabular-nums"><span className="font-semibold text-text-secondary">{summaryMeta.messageCount}</span> messages</span>
              </div>
            )}
            <pre className="whitespace-pre-wrap rounded-well border border-border-subtle bg-bg-mod-subtle p-4 text-body leading-relaxed text-text-secondary">
              {summaryText || 'No summary available.'}
            </pre>
          </>
        )}
      </TopBarOverlay>

      <TopBarOverlay
        open={showFollowManager}
        onClose={() => setShowFollowManager(false)}
        dialogRef={followDialogRef as RefObject<HTMLDivElement | null>}
        titleId="conversation-follows-title"
        title="Channel follows"
        icon={Share2}
        closeLabel="Close channel follows"
        panelClassName="max-h-[min(82dvh,40rem)] w-full max-w-xl"
        bodyClassName="p-4 sm:p-5"
      >
        {followError && (
          <div
            role="alert"
            className="mb-3 rounded-well border border-accent-danger/30 bg-danger-tint px-4 py-3 text-label text-accent-danger"
          >
            {followError}
          </div>
        )}
        {followersLoading ? (
          <div className="py-6 text-center text-label text-text-muted">Loading follows…</div>
        ) : followTargets.length > 0 ? (
          <ul className="divide-y divide-border-subtle">
            {followTargets.map((target) => {
              const existing = followers.find((entry) => entry.target_channel_id === target.id);
              const busy = followBusyTargetId === target.id;
              return (
                <li key={target.id} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="flex min-w-0 items-center gap-1.5 text-label font-medium text-text-primary">
                    <Hash size={15} className="shrink-0 text-channel-icon" />
                    <span className="truncate">{target.name}</span>
                  </span>
                  {existing ? (
                    <button
                      type="button"
                      className="inline-flex h-8 shrink-0 items-center rounded-chip bg-bg-mod-subtle px-3 text-meta font-semibold text-accent-danger outline-none transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-danger-tint focus-visible:shadow-[var(--focus-ring)] disabled:opacity-60"
                      onClick={() => void changeFollow(target.id, () => channelApi.removeFollower(channelId, target.id), 'Failed to unfollow channel')}
                      disabled={busy}
                    >
                      {busy ? 'Removing…' : 'Unfollow'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="inline-flex h-8 shrink-0 items-center rounded-chip bg-accent-primary px-3 text-meta font-semibold text-text-on-accent shadow-[var(--shadow-chip)] outline-none transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-accent-primary-hover focus-visible:shadow-[var(--focus-ring)] disabled:opacity-60"
                      onClick={() => void changeFollow(target.id, () => channelApi.addFollower(channelId, target.id, target.guild_id || ''), 'Failed to follow channel')}
                      disabled={busy || !target.guild_id}
                    >
                      {busy ? 'Adding…' : 'Follow'}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="flex items-start gap-3.5 py-6">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-chip bg-accent-tint text-accent-primary">
              <Share2 size={20} />
            </span>
            <div className="min-w-0 pt-0.5">
              <h3 className="text-heading text-text-primary">Nothing to follow into yet</h3>
              <p className="mt-1 text-label text-text-secondary">
                Create another text channel in this server to cross-post announcements from here.
              </p>
            </div>
          </div>
        )}
      </TopBarOverlay>

      <InboxOverlay
        open={showInbox}
        onClose={() => setShowInbox(false)}
        unreadItems={unreadItems}
        allChannels={allChannels}
        error={inboxError}
      />

      <HelpOverlay open={showHelp} onClose={() => setShowHelp(false)} />
    </>
  );

  return { items, dialogs, attention: { unread: unreadItems.length, mentions } };
}
