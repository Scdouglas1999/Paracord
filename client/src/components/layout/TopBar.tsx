import { ConversationHeaderActions, attentionDescription, type HeaderAction, type ActiveHeaderSurface } from './ConversationHeaderActions';
import type { ContextMenuItem } from '../ui/ContextMenu';
import { useConversationActions } from '../../hooks/useConversationActions';
import { useCurrentAccountScope } from '../../hooks/useCurrentUser';
import { useCurrentReadStates } from '../../hooks/useReadStates';
import { useCurrentChannelStore } from '../../hooks/useChannels';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Hash,
  Search,
  Sparkles,
  Pin,
  Share2,
  Users,
  Inbox,
  HelpCircle,
  Volume2,
  MessageSquare,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Wifi,
  Phone,
  PhoneOff,
  Loader2,
  TrendingUp,
  Settings,
} from 'lucide-react';
import { useNavigate, useParams } from 'react-router';
import { extractApiError } from '../../api/client';
import { channelApi } from '../../api/channels';
import { useVoice } from '../../hooks/useVoice';
import { isMessageUnread } from '../../hooks/useUnreadCounts';
import { usePermissions } from '../../hooks/usePermissions';
import { useUIStore } from '../../stores/uiStore';
import type { ContextPanelMode } from '../../stores/uiStore';
import { useReadStateStore } from '../../stores/readStateStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { toast } from '../../stores/toastStore';
import type { ReadState } from '../../types';
import { canAccessGuildSettings } from '../../lib/guildSettingsAccess';
import { Tooltip } from '../ui/Tooltip';
import { cn } from '../../lib/utils';
import { getIdentityColor } from '../../lib/colors';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useMutedGuilds } from '../../hooks/useMutedGuilds';
import { entityScopeKey } from '../../lib/serverScope';
import { TopBarOverlay } from './overlays/TopBarOverlay';
import { InboxOverlay } from './overlays/InboxOverlay';
import { HelpOverlay } from './overlays/HelpOverlay';
import { VoiceConnectionCheck } from '../voice/VoiceConnectionCheck';
import { ChannelSwitcher } from './ChannelSwitcher';

interface TopBarProps {
  channelName?: string;
  channelTopic?: string;
  isVoice?: boolean;
  isForum?: boolean;
  isDM?: boolean;
  recipientName?: string;
  dmChannelId?: string;
  /** Owning guild id — powers the breadcrumb chip → guild Home navigation. */
  guildId?: string;
  /** Owning guild name — the breadcrumb chip label ("GuildName /"). */
  guildName?: string;
}

/** Isolated so connectionLatency ticks don't re-render the full TopBar. */
function ConnectionLatencyBadge() {
  const connectionLatency = useUIStore((s) => s.connectionLatency);
  return (
    <Tooltip content={`Latency: ${connectionLatency}ms`} side="bottom">
      <div className="chat-header-connection ml-1 items-center gap-1.5 rounded-sm bg-bg-mod-subtle px-2 py-1">
        <Wifi size={12} className={cn(
          connectionLatency < 100
            ? 'text-accent-success'
            : connectionLatency < 300
              ? 'text-accent-warning'
              : 'text-accent-danger'
        )} />
        <span className={cn(
          'font-mono text-[10px] font-semibold tabular-nums',
          connectionLatency < 100
            ? 'text-accent-success'
            : connectionLatency < 300
              ? 'text-accent-warning'
              : 'text-accent-danger'
        )}>
          {connectionLatency}ms
        </span>
      </div>
    </Tooltip>
  );
}

export function TopBar(props: TopBarProps) {
  const scope = useCurrentAccountScope();
  const { channelId } = useParams();
  const target = props.dmChannelId ?? channelId ?? 'header';
  return <OwnedTopBar key={scope ? entityScopeKey(scope, target) : `unavailable:${target}`} {...props} />;
}

function OwnedTopBar({
  channelName,
  channelTopic,
  isVoice,
  isForum,
  isDM,
  recipientName,
  dmChannelId,
  guildId,
  guildName,
}: TopBarProps) {
  const navigate = useNavigate();
  const { guildId: paramGuildId, channelId } = useParams();
  const resolvedGuildId = guildId ?? paramGuildId;
  const { actions } = useConversationActions(dmChannelId ?? channelId);

  // contextPanelMode is the single source of truth for the right panel.
  const contextPanelMode = useUIStore((s) => s.contextPanelMode);
  const toggleContextPanelMode = useUIStore((s) => s.toggleContextPanelMode);
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const connectionStatus = useUIStore((s) => s.connectionStatus);
  const channelsById = useCurrentChannelStore((s) => s.channelsById);
  const channelsByGuild = useCurrentChannelStore((s) => s.channelsByGuild);
  const systemAudioCaptureActive = useVoiceStore((s) => s.systemAudioCaptureActive);
  const { connected: voiceConnected, channelId: voiceChannelId, joinChannel, leaveChannel } = useVoice();
  const [dmCallLoading, setDmCallLoading] = useState(false);
  // A failed DM call offers the guided check right where the failure appeared.
  const [showVoiceCheck, setShowVoiceCheck] = useState(false);

  const setGuildSettingsId = useUIStore((s) => s.setGuildSettingsId);
  const { permissions, isAdmin: isGuildAdmin } = usePermissions(
    isDM ? null : (resolvedGuildId ?? null),
  );
  const canOpenSpaceSettings =
    !isDM && Boolean(resolvedGuildId) && canAccessGuildSettings(permissions, isGuildAdmin);

  const isInDmCall = isDM && voiceConnected && voiceChannelId === (dmChannelId || channelId);

  const handleDmCallToggle = async () => {
    if (!isDM || (!isInDmCall && !actions.voice.allowed)) return;
    const targetChannelId = dmChannelId || channelId;
    if (!targetChannelId) return;

    if (isInDmCall) {
      await leaveChannel();
      return;
    }

    setDmCallLoading(true);
    try {
      // Use 'dm' as guildId sentinel to select DM voice endpoint
      await joinChannel(targetChannelId, 'dm');
      const voiceState = useVoiceStore.getState();
      if (
        voiceState.connectionError
        && voiceState.connectionErrorChannelId === targetChannelId
      ) {
        toast.error(`Could not start voice call: ${voiceState.connectionError}`, undefined, {
          label: 'Run connection check',
          onClick: () => setShowVoiceCheck(true),
        });
      }
    } catch {
      toast.error('Could not start voice call.', undefined, {
        label: 'Run connection check',
        onClick: () => setShowVoiceCheck(true),
      });
    } finally {
      setDmCallLoading(false);
    }
  };

  const [showFollowManager, setShowFollowManager] = useState(false);
  const [followers, setFollowers] = useState<
    Array<{ id: string; target_channel_id: string; target_guild_id: string }>
  >([]);
  const [followersLoading, setFollowersLoading] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);
  const [followBusyTargetId, setFollowBusyTargetId] = useState<string | null>(null);
  const [showInbox, setShowInbox] = useState(false);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const readScope = useCurrentAccountScope();
  const readStateRecord = useCurrentReadStates();
  const readStates = useMemo(() => Object.values(readStateRecord), [readStateRecord]);
  const [showHelp, setShowHelp] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryText, setSummaryText] = useState('');
  const [summaryMeta, setSummaryMeta] = useState<{ provider: string; model: string; messageCount: number } | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const followDialogRef = useRef<HTMLDivElement>(null);
  const summaryDialogRef = useRef<HTMLDivElement>(null);
  const { mutedGuildKeys } = useMutedGuilds();

  const closeTopBarSurfaces = useCallback(() => {
    setShowFollowManager(false);
    setShowInbox(false);
    setShowHelp(false);
    setShowSummary(false);
  }, []);

  const closeContextPanel = useCallback(() => {
    if (contextPanelMode) toggleContextPanelMode(contextPanelMode);
  }, [contextPanelMode, toggleContextPanelMode]);

  // TopBar modals and the right ContextPanel share one secondary-surface
  // budget. Replacing one with the other avoids stacked chrome and makes one
  // Escape close exactly one visible layer.
  const prepareTopBarSurface = useCallback(() => {
    closeTopBarSurfaces();
    closeContextPanel();
  }, [closeContextPanel, closeTopBarSurfaces]);

  useFocusTrap(followDialogRef as RefObject<HTMLDivElement | null>, showFollowManager, () => setShowFollowManager(false));
  useFocusTrap(summaryDialogRef as RefObject<HTMLDivElement | null>, showSummary, () => setShowSummary(false));

  const selectedChannel = channelId ? channelsById[channelId] : undefined;
  const allChannels = useMemo(() => Object.values(channelsById), [channelsById]);
  const isGroupDm = isDM && (selectedChannel?.type === 3 || selectedChannel?.channel_type === 3);
  const isAnnouncementChannel = selectedChannel?.type === 5 || selectedChannel?.channel_type === 5;
  const followTargets = useMemo(() => {
    if (!selectedChannel?.guild_id) return [];
    return (channelsByGuild[selectedChannel.guild_id] || []).filter(
      (channel) =>
        channel.id !== selectedChannel.id
        && (channel.type === 0 || channel.channel_type === 0),
    );
  }, [channelsByGuild, selectedChannel]);

  const unreadItems = useMemo(() => {
    const result: Array<{ state: ReadState; channelName: string }> = [];
    const stateByChannel = new Map(readStates.map((state) => [state.channel_id, state]));
    for (const channel of allChannels) {
      if (channel.id === channelId) continue;
      if (channel?.guild_id && readScope && mutedGuildKeys.includes(entityScopeKey(readScope, channel.guild_id))) {
        continue;
      }
      if (!channel.last_message_id || channel.type === 4 || channel.channel_type === 4) continue;
      const state = stateByChannel.get(channel.id) ?? {
        channel_id: channel.id,
        last_message_id: '',
        mention_count: 0,
      };
      const hasUnread = isMessageUnread(channel.last_message_id, state.last_message_id);
      if (hasUnread) {
        result.push({
          state,
          channelName: channel.name || state.channel_id,
        });
      }
    }
    result.sort((a, b) => b.state.mention_count - a.state.mention_count);
    return result;
  }, [readStates, allChannels, mutedGuildKeys, channelId, readScope]);
  const inboxMentions = unreadItems.reduce((total, item) => total + item.state.mention_count, 0);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Mod+K is owned by CommandPalette (toggle). Do not also force-open here —
      // both listeners fire on the same keydown and the open+toggle race leaves
      // the palette stuck open when the user meant to close it.
      // Help lists Mod+F as "Search in channel" — open the shared search panel.
      if (
        (event.ctrlKey || event.metaKey)
        && event.key.toLowerCase() === 'f'
        && !event.shiftKey
        && channelId
      ) {
        event.preventDefault();
        closeTopBarSurfaces();
        useUIStore.getState().setContextPanelMode('search');
      }
      if (event.key === 'Escape') {
        const anyOpen =
          showFollowManager || showInbox || showHelp || showSummary;
        if (!anyOpen) return;
        event.preventDefault();
        closeTopBarSurfaces();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    channelId,
    closeTopBarSurfaces,
    showFollowManager,
    showHelp,
    showInbox,
    showSummary,
  ]);

  // Read state lives in the shared store, kept live by dispatch and mark-read
  // call sites; pull an authoritative snapshot once on mount.
  useEffect(() => {
    void useReadStateStore.getState().refreshAll();
  }, []);

  const openSummary = async () => {
    if (!channelId || !actions.summary.allowed) return;
    prepareTopBarSurface();
    setShowSummary(true);
    setSummaryLoading(true);
    setSummaryText('');
    setSummaryError(null);
    try {
      const { data } = await channelApi.summarizeChannel(channelId, 180);
      setSummaryText(data.summary);
      setSummaryMeta({
        provider: data.provider,
        model: data.model,
        messageCount: data.message_count,
      });
    } catch (err: unknown) {
      setSummaryError(`Failed to summarize channel: ${extractApiError(err)}`);
      setSummaryMeta(null);
    } finally {
      setSummaryLoading(false);
    }
  };

  const refreshFollowers = useCallback(async () => {
    if (!channelId) return;
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
    if (!channelId) return;
    prepareTopBarSurface();
    setShowFollowManager(true);
    await refreshFollowers();
  };

  const addFollower = async (targetChannelId: string, targetGuildId: string) => {
    if (!channelId) return;
    setFollowBusyTargetId(targetChannelId);
    setFollowError(null);
    try {
      await channelApi.addFollower(channelId, targetChannelId, targetGuildId);
      await refreshFollowers();
    } catch (err) {
      setFollowError(`Failed to follow channel: ${extractApiError(err)}`);
    } finally {
      setFollowBusyTargetId(null);
    }
  };

  const removeFollower = async (targetChannelId: string) => {
    if (!channelId) return;
    setFollowBusyTargetId(targetChannelId);
    setFollowError(null);
    try {
      await channelApi.removeFollower(channelId, targetChannelId);
      await refreshFollowers();
    } catch (err) {
      setFollowError(`Failed to unfollow channel: ${extractApiError(err)}`);
    } finally {
      setFollowBusyTargetId(null);
    }
  };

  const openInbox = async () => {
    prepareTopBarSurface();
    setInboxError(null);
    try {
      if (!readScope) throw new Error('Sign in to this server before opening the inbox.');
      await useReadStateStore.getState().refresh(readScope);
    } catch (err) {
      setInboxError(`Failed to load inbox: ${extractApiError(err)}`);
    }
    setShowInbox(true);
  };

  const openHelp = () => {
    prepareTopBarSurface();
    setShowHelp(true);
  };

  const openSpaceSettings = () => {
    if (!resolvedGuildId) return;
    prepareTopBarSurface();
    setGuildSettingsId(resolvedGuildId);
  };

  // Drives a ContextPanel mode off the single source of truth.
  const panelToggle = (mode: Exclude<ContextPanelMode, null>) => () => {
    closeTopBarSurfaces();
    toggleContextPanelMode(mode);
  };

  const primaryActions: HeaderAction[] = [
    ...(isDM && (dmChannelId || channelId) ? [{
      label: isInDmCall ? 'End direct message call' : 'Start direct message voice call',
      icon: isInDmCall ? PhoneOff : Phone,
      onClick: () => void handleDmCallToggle(),
      active: Boolean(isInDmCall),
      disabled: dmCallLoading || (!isInDmCall && !actions.voice.allowed),
      reason: isInDmCall ? null : actions.voice.reason,
    }] : []),
    { label: 'Search Messages', icon: Search, onClick: panelToggle('search'),
      active: contextPanelMode === 'search', controlsPanel: true, disabled: !channelId,
      reason: channelId ? null : 'Select a channel to search' },
    ...(!isDM || isGroupDm ? [{ label: 'Member List', icon: Users, onClick: panelToggle('members'),
      active: contextPanelMode === 'members', controlsPanel: true }] : []),
  ];
  const secondaryActions: ContextMenuItem[] = [
    { label: 'Catch up summary', icon: <Sparkles size={17} />, action: () => void openSummary(),
      disabled: !actions.summary.allowed, description: actions.summary.reason ?? undefined },
    { label: 'Pinned messages', icon: <Pin size={17} />, action: panelToggle('pins'), disabled: !channelId },
    ...(!isDM && !isVoice ? [{ label: 'Threads', icon: <MessagesSquare size={17} />, action: panelToggle('threads') }] : []),
    ...(isAnnouncementChannel ? [{ label: 'Manage follows', icon: <Share2 size={17} />, action: () => void openFollowManager(), disabled: !channelId }] : []),
    ...(!isDM ? [{ label: 'Space leaderboard', icon: <TrendingUp size={17} />, action: panelToggle('economy') }] : []),
    ...(canOpenSpaceSettings && resolvedGuildId ? [{ label: 'Space settings', icon: <Settings size={17} />, action: openSpaceSettings }] : []),
    { label: '', action: () => {}, divider: true },
    { label: 'Inbox', icon: <Inbox size={17} />, action: () => void openInbox(), description: attentionDescription(unreadItems.length, inboxMentions) },
    { label: 'Keyboard shortcuts', icon: <HelpCircle size={17} />, action: openHelp },
  ];
  const contextualSurfaces: Partial<Record<Exclude<ContextPanelMode, null>, ActiveHeaderSurface>> = {
    pins: { label: 'Pinned messages', icon: Pin, onClose: panelToggle('pins') },
    threads: { label: 'Threads', icon: MessagesSquare, onClose: panelToggle('threads') },
    economy: { label: 'Space leaderboard', icon: TrendingUp, onClose: panelToggle('economy') },
  };
  const activeSurface: ActiveHeaderSurface | undefined = showSummary
    ? { label: 'Catch up summary', icon: Sparkles, onClose: () => setShowSummary(false) }
    : showFollowManager ? { label: 'Channel follows', icon: Share2, onClose: () => setShowFollowManager(false) }
    : showInbox ? { label: 'Inbox', icon: Inbox, onClose: () => setShowInbox(false) }
    : showHelp ? { label: 'Keyboard shortcuts', icon: HelpCircle, onClose: () => setShowHelp(false) }
    : contextPanelMode ? contextualSurfaces[contextPanelMode] : undefined;

  const ChannelIcon = isVoice ? Volume2 : isForum ? MessageSquare : Hash;
  const showBreadcrumb = !isDM && Boolean(resolvedGuildId) && Boolean(guildName);

  return (
    <div className={cn("chat-header relative z-10 w-full shrink-0 border-b border-border-subtle bg-bg-secondary", isGroupDm && "chat-header-group-dm")}>
      <div className="chat-header-grid">
      {/* Left: breadcrumb + channel info */}
      <div className="relative flex min-w-0 flex-1 items-center gap-2">
        <button
          type="button"
          onClick={() => {
            const ui = useUIStore.getState();
            // Opening the mobile sidebar overlay must dismiss the members/context
            // overlay; otherwise both z-[80] surfaces stack.
            if (ui.sidebarCollapsed) {
              ui.setContextPanelMode(null);
              ui.setSidebarCollapsed(false);
              return;
            }
            ui.setSidebarCollapsed(true);
          }}
          className="chat-header-navigation inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-interactive-normal outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-interactive-hover focus-visible:shadow-[var(--focus-ring)]"
          title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
        {isDM ? (
          <div className="flex min-w-0 items-center gap-2.5">
            <button
              type="button"
              onClick={() => navigate('/app/dms')}
              className="chat-header-navigation inline-flex h-8 shrink-0 items-center gap-1 rounded-sm px-1.5 text-label font-medium text-text-secondary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)] sm:px-2"
              aria-label="Back to Messages"
              title="Back to Messages"
            >
              <ChevronLeft size={16} aria-hidden />
              <span className="hidden sm:inline">Messages</span>
            </button>
            <span
              className="chat-header-avatar flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-label font-semibold text-text-on-light"
              style={{ backgroundColor: getIdentityColor(dmChannelId || channelId || recipientName || '0') }}
            >
              {recipientName?.charAt(0).toUpperCase() || '?'}
            </span>
            <span className="chat-header-dm-name truncate text-[15px] font-semibold text-text-primary">
              {recipientName || 'Direct Message'}
            </span>
            <span className="chat-header-detail h-4 w-px shrink-0 bg-border-strong" aria-hidden />
            <span className="chat-header-detail truncate text-label text-text-secondary">Direct message</span>
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-1.5">
            {showBreadcrumb && (
              <>
                <button
                  type="button"
                  onClick={() => navigate(`/app/guilds/${resolvedGuildId}`)}
                  className="chat-header-breadcrumb max-w-[10rem] shrink-0 items-center gap-1 rounded-sm px-1.5 py-1 text-label font-medium text-text-secondary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
                  aria-label={`Go to ${guildName} home`}
                  title={`Go to ${guildName} home`}
                >
                  <span className="truncate">{guildName}</span>
                </button>
                <ChevronRight size={14} className="chat-header-breadcrumb shrink-0 text-text-muted" aria-hidden />
              </>
            )}
            {resolvedGuildId ? (
              <ChannelSwitcher
                guildId={resolvedGuildId}
                guildName={guildName}
                channelId={channelId}
                channelName={channelName || 'channel'}
                channelType={selectedChannel?.type ?? selectedChannel?.channel_type}
                channels={channelsByGuild[resolvedGuildId] || []}
              />
            ) : (
              <>
                <ChannelIcon size={18} className="shrink-0 text-channel-icon" />
                <span className="truncate text-[15px] font-semibold text-text-primary">
                  {channelName || 'channel'}
                </span>
              </>
            )}
            {channelTopic && (
              <>
                <span className="hidden h-4 w-px shrink-0 bg-border-strong lg:block" aria-hidden />
                <span className="hidden min-w-0 truncate text-label text-text-secondary lg:block">
                  {channelTopic}
                </span>
              </>
            )}
          </div>
        )}
      </div>

      {isGroupDm && <div className="chat-header-mobile-dm-title">{recipientName || 'Group message'}</div>}
      <ConversationHeaderActions primary={primaryActions} items={secondaryActions}
        activeSurface={activeSurface} unread={unreadItems.length} mentions={inboxMentions}
        indicator={connectionStatus === 'connected' ? <ConnectionLatencyBadge /> : undefined} />
      {systemAudioCaptureActive && <div role="status" aria-label="System audio capture is active" className="chat-header-capture-status">
        <AlertTriangle size={16} aria-hidden className="shrink-0" />
        <span>System audio capture is active</span>
      </div>}
      </div>

      {/* Summary overlay */}
      <TopBarOverlay
        open={showSummary}
        onClose={() => setShowSummary(false)}
        dialogRef={summaryDialogRef as RefObject<HTMLDivElement | null>}
        titleId="topbar-summary-title"
        title="Catch Up Summary"
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
            className="rounded-md border border-accent-danger/30 bg-danger-tint px-4 py-3 text-label text-accent-danger"
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
            <pre className="whitespace-pre-wrap rounded-md border border-border-subtle bg-bg-mod-subtle p-4 text-body leading-relaxed text-text-secondary">
              {summaryText || 'No summary available.'}
            </pre>
          </>
        )}
      </TopBarOverlay>

      {/* Channel follows overlay */}
      <TopBarOverlay
        open={showFollowManager}
        onClose={() => setShowFollowManager(false)}
        dialogRef={followDialogRef as RefObject<HTMLDivElement | null>}
        titleId="topbar-follows-title"
        title="Channel Follows"
        icon={Share2}
        closeLabel="Close channel follows"
        panelClassName="max-h-[min(82dvh,40rem)] w-full max-w-xl"
        bodyClassName="p-4 sm:p-5"
      >
        {followError && (
          <div
            role="alert"
            className="mb-3 rounded-md border border-accent-danger/30 bg-danger-tint px-4 py-3 text-label text-accent-danger"
          >
            {followError}
          </div>
        )}
        {followersLoading ? (
          <div className="py-6 text-center text-label text-text-muted">Loading follows…</div>
        ) : followTargets.length > 0 ? (
          <ul className="divide-y divide-border-subtle">
            {followTargets.map((targetChannel) => {
              const existing = followers.find(
                (entry) => entry.target_channel_id === targetChannel.id,
              );
              const busy = followBusyTargetId === targetChannel.id;
              return (
                <li key={targetChannel.id} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="flex min-w-0 items-center gap-1.5 text-label font-medium text-text-primary">
                    <Hash size={15} className="shrink-0 text-channel-icon" />
                    <span className="truncate">{targetChannel.name}</span>
                  </span>
                  {existing ? (
                    <button
                      type="button"
                      className="inline-flex h-8 shrink-0 items-center rounded-sm bg-bg-mod-subtle px-3 text-meta font-semibold text-accent-danger outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-danger-tint focus-visible:shadow-[var(--focus-ring)] disabled:opacity-60"
                      onClick={() => void removeFollower(targetChannel.id)}
                      disabled={busy}
                    >
                      {busy ? 'Removing…' : 'Unfollow'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="inline-flex h-8 shrink-0 items-center rounded-sm bg-accent-primary px-3 text-meta font-semibold text-text-on-accent shadow-sm outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-primary-hover focus-visible:shadow-[var(--focus-ring)] disabled:opacity-60"
                      onClick={() => void addFollower(targetChannel.id, targetChannel.guild_id || '')}
                      disabled={busy || !targetChannel.guild_id}
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
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm bg-accent-tint text-accent-primary">
              <Share2 size={20} />
            </span>
            <div className="min-w-0 pt-0.5">
              <h3 className="text-subhead text-text-primary">Nothing to follow into yet</h3>
              <p className="mt-1 text-label text-text-secondary">
                Create another text channel in this space to cross-post announcements from here.
              </p>
            </div>
          </div>
        )}
      </TopBarOverlay>

      {/* Inbox overlay */}
      <InboxOverlay
        open={showInbox}
        onClose={() => setShowInbox(false)}
        unreadItems={unreadItems}
        allChannels={allChannels}
        error={inboxError}
      />

      {/* Help/shortcuts overlay */}
      <HelpOverlay
        open={showHelp}
        onClose={() => setShowHelp(false)}
      />

      {/* Guided voice check, offered when a DM call fails to start. */}
      <VoiceConnectionCheck
        open={showVoiceCheck}
        onClose={() => setShowVoiceCheck(false)}
        autoStart
      />
    </div>
  );
}
