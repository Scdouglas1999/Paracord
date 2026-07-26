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
  MoreHorizontal,
  TrendingUp,
  Settings,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useNavigate, useParams } from 'react-router';
import { extractApiError } from '../../api/client';
import { channelApi } from '../../api/channels';
import { authApi } from '../../api/auth';
import { useVoice } from '../../hooks/useVoice';
import { isMessageUnread } from '../../hooks/useUnreadCounts';
import { usePermissions } from '../../hooks/usePermissions';
import { useUIStore } from '../../stores/uiStore';
import type { ContextPanelMode } from '../../stores/uiStore';
import { useChannelStore } from '../../stores/channelStore';
import { useReadStateStore } from '../../stores/readStateStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { toast } from '../../stores/toastStore';
import type { ReadState } from '../../types';
import { canAccessGuildSettings } from '../../lib/guildSettingsAccess';
import { Tooltip } from '../ui/Tooltip';
import { cn } from '../../lib/utils';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { getVersionedJson } from '../../lib/versionedStorage';
import { TopBarOverlay } from './overlays/TopBarOverlay';
import { InboxOverlay } from './overlays/InboxOverlay';
import { HelpOverlay } from './overlays/HelpOverlay';
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
      <div className="ml-1 hidden items-center gap-1.5 rounded-sm bg-bg-mod-subtle px-2 py-1 md:flex">
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

export function TopBar({
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

  // contextPanelMode is the single source of truth for the right panel.
  const contextPanelMode = useUIStore((s) => s.contextPanelMode);
  const toggleContextPanelMode = useUIStore((s) => s.toggleContextPanelMode);
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const connectionStatus = useUIStore((s) => s.connectionStatus);
  const channelsById = useChannelStore((s) => s.channelsById);
  const channelsByGuild = useChannelStore((s) => s.channelsByGuild);
  const systemAudioCaptureActive = useVoiceStore((s) => s.systemAudioCaptureActive);
  const { connected: voiceConnected, channelId: voiceChannelId, joinChannel, leaveChannel } = useVoice();
  const [dmCallLoading, setDmCallLoading] = useState(false);

  const setGuildSettingsId = useUIStore((s) => s.setGuildSettingsId);
  const { permissions, isAdmin: isGuildAdmin } = usePermissions(
    isDM ? null : (resolvedGuildId ?? null),
  );
  const canOpenSpaceSettings =
    !isDM && Boolean(resolvedGuildId) && canAccessGuildSettings(permissions, isGuildAdmin);

  const isInDmCall = isDM && voiceConnected && voiceChannelId === (dmChannelId || channelId);

  const handleDmCallToggle = async () => {
    if (!isDM) return;
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
        toast.error(`Could not start voice call: ${voiceState.connectionError}`);
      }
    } catch {
      toast.error('Could not start voice call.');
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
  const readStateRecord = useReadStateStore((s) => s.readStates);
  const readStates = useMemo(() => Object.values(readStateRecord), [readStateRecord]);
  const [showHelp, setShowHelp] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [showMoreActions, setShowMoreActions] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryText, setSummaryText] = useState('');
  const [summaryMeta, setSummaryMeta] = useState<{ provider: string; model: string; messageCount: number } | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const followDialogRef = useRef<HTMLDivElement>(null);
  const summaryDialogRef = useRef<HTMLDivElement>(null);
  const moreActionsRef = useRef<HTMLDivElement>(null);
  const [mutedGuildIds, setMutedGuildIds] = useState<string[]>([]);

  const closeTopBarSurfaces = useCallback(() => {
    setShowFollowManager(false);
    setShowInbox(false);
    setShowHelp(false);
    setShowSummary(false);
    setShowMoreActions(false);
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
      if (channel?.guild_id && mutedGuildIds.includes(channel.guild_id)) {
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
  }, [readStates, allChannels, mutedGuildIds, channelId]);
  const inboxBadge = useMemo(() => {
    const mentions = unreadItems.reduce((total, item) => total + item.state.mention_count, 0);
    return mentions > 0 ? mentions : unreadItems.length;
  }, [unreadItems]);

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
        useUIStore.getState().setContextPanelMode('search');
      }
      if (event.key === 'Escape') {
        const anyOpen =
          showFollowManager || showInbox || showHelp || showSummary || showMoreActions;
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
    showMoreActions,
    showSummary,
  ]);

  useEffect(() => {
    if (!showMoreActions) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!moreActionsRef.current?.contains(event.target as Node)) {
        setShowMoreActions(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [showMoreActions]);

  // Read state lives in the shared store, kept live by dispatch and mark-read
  // call sites; pull an authoritative snapshot once on mount.
  useEffect(() => {
    void useReadStateStore.getState().refresh();
  }, []);

  useEffect(() => {
    const readMutedGuilds = () => {
      try {
        setMutedGuildIds(getVersionedJson<string[]>('muted-guilds', [], ['muted-guilds']));
      } catch {
        setMutedGuildIds([]);
      }
    };
    readMutedGuilds();
    window.addEventListener('storage', readMutedGuilds);
    window.addEventListener('paracord-muted-guilds-updated', readMutedGuilds as EventListener);
    return () => {
      window.removeEventListener('storage', readMutedGuilds);
      window.removeEventListener('paracord-muted-guilds-updated', readMutedGuilds as EventListener);
    };
  }, []);

  const openSummary = async () => {
    if (!channelId) return;
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
      setMutedGuildIds(getVersionedJson<string[]>('muted-guilds', [], ['muted-guilds']));
    } catch {
      setMutedGuildIds([]);
    }
    try {
      const { data } = await authApi.getReadStates();
      useReadStateStore.getState().setAll(data);
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

  const TopBarIcon = ({
    onClick,
    icon: Icon,
    active,
    tooltip,
    disabled,
    className,
    badge,
    controlsPanel,
  }: {
    onClick: () => void;
    icon: LucideIcon;
    active?: boolean;
    tooltip: string;
    disabled?: boolean;
    className?: string;
    badge?: number;
    /** True for toggles that drive the ContextPanel → expose aria-expanded. */
    controlsPanel?: boolean;
  }) => (
    <div className={className}>
      <Tooltip content={tooltip} side="bottom">
        <button
          aria-label={tooltip}
          aria-pressed={active}
          aria-expanded={controlsPanel ? Boolean(active) : undefined}
          onClick={onClick}
          disabled={disabled}
          className={cn(
            'relative inline-flex h-9 w-9 items-center justify-center rounded-sm text-interactive-normal outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-interactive-hover focus-visible:shadow-[var(--focus-ring)]',
            active && 'bg-accent-tint text-accent-primary hover:bg-accent-tint-strong hover:text-accent-primary',
            disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-interactive-muted',
          )}
        >
          <Icon size={18} />
          {badge != null && badge > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-accent-primary px-1 text-[10px] font-bold tabular-nums text-text-on-accent">
              {badge > 99 ? '99+' : badge}
            </span>
          )}
        </button>
      </Tooltip>
    </div>
  );

  const MoreAction = ({
    label,
    icon: Icon,
    onClick,
    active,
    disabled,
  }: {
    label: string;
    icon: LucideIcon;
    onClick: () => void;
    active?: boolean;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        onClick();
        setShowMoreActions(false);
      }}
      className={cn(
        'flex h-9 w-full items-center gap-2.5 rounded-sm px-2.5 text-left text-label outline-none transition-colors',
        active
          ? 'bg-accent-tint text-text-primary'
          : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary focus:bg-accent-tint focus:text-text-primary',
        disabled && 'cursor-not-allowed opacity-40',
      )}
    >
      <Icon size={17} className={active ? 'text-accent-primary' : 'text-channel-icon'} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );

  // Drives a ContextPanel mode off the single source of truth.
  const panelToggle = (mode: Exclude<ContextPanelMode, null>) => () => {
    closeTopBarSurfaces();
    toggleContextPanelMode(mode);
  };

  const ChannelIcon = isVoice ? Volume2 : isForum ? MessageSquare : Hash;
  const showBreadcrumb = !isDM && Boolean(resolvedGuildId) && Boolean(guildName);

  return (
    <div className="relative z-10 flex h-[3.25rem] w-full shrink-0 items-center justify-between gap-2 border-b border-border-subtle bg-bg-secondary px-3 sm:px-4">
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
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-interactive-normal outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-interactive-hover focus-visible:shadow-[var(--focus-ring)]"
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
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-sm px-1.5 text-label font-medium text-text-secondary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)] sm:px-2"
              aria-label="Back to Messages"
              title="Back to Messages"
            >
              <ChevronLeft size={16} aria-hidden />
              <span className="hidden sm:inline">Messages</span>
            </button>
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-primary text-label font-semibold text-text-on-accent">
              {recipientName?.charAt(0).toUpperCase() || '?'}
            </span>
            <span className="truncate text-[15px] font-semibold text-text-primary">
              {recipientName || 'Direct Message'}
            </span>
            <span className="hidden h-4 w-px shrink-0 bg-border-strong sm:block" aria-hidden />
            <span className="hidden truncate text-label text-text-secondary sm:block">Direct message</span>
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-1.5">
            {showBreadcrumb && (
              <>
                <button
                  type="button"
                  onClick={() => navigate(`/app/guilds/${resolvedGuildId}`)}
                  className="hidden max-w-[10rem] shrink-0 items-center gap-1 rounded-sm px-1.5 py-1 text-label font-medium text-text-secondary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)] lg:inline-flex"
                  aria-label={`Go to ${guildName} home`}
                  title={`Go to ${guildName} home`}
                >
                  <span className="truncate">{guildName}</span>
                </button>
                <ChevronRight size={14} className="hidden shrink-0 text-text-muted lg:block" aria-hidden />
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

      {/* Right: context toggles + anchored popovers */}
      <div className="flex shrink-0 items-center gap-0.5">
        {systemAudioCaptureActive && (
          <Tooltip content="System audio capture is active" side="bottom">
            <button
              type="button"
              disabled
              aria-label="System audio capture is active"
              className="inline-flex h-9 w-9 cursor-default items-center justify-center rounded-sm bg-warning-tint text-accent-warning"
            >
              <AlertTriangle size={18} />
            </button>
          </Tooltip>
        )}
        {isDM && (dmChannelId || channelId) && (
          <Tooltip content={isInDmCall ? 'End Call' : 'Start Voice Call'} side="bottom">
            <button
              aria-label={isInDmCall ? 'End direct message call' : 'Start direct message voice call'}
              onClick={() => void handleDmCallToggle()}
              disabled={dmCallLoading}
              className={cn(
                'inline-flex h-9 w-9 items-center justify-center rounded-sm outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
                isInDmCall ? 'text-accent-danger hover:bg-danger-tint' : 'text-accent-success hover:bg-success-tint',
                dmCallLoading && 'cursor-not-allowed opacity-40'
              )}
            >
              {isInDmCall ? <PhoneOff size={18} /> : <Phone size={18} />}
            </button>
          </Tooltip>
        )}
        <TopBarIcon
          icon={Search}
          onClick={panelToggle('search')}
          active={contextPanelMode === 'search'}
          controlsPanel
          tooltip={channelId ? 'Search Messages' : 'Select a channel to search'}
          disabled={!channelId}
        />
        <TopBarIcon
          className="hidden md:block"
          icon={Sparkles}
          onClick={() => void openSummary()}
          active={showSummary}
          tooltip={channelId ? 'Summarize Channel' : 'Select a channel to summarize'}
          disabled={!channelId}
        />
        <TopBarIcon
          className="hidden md:block"
          icon={Pin}
          onClick={panelToggle('pins')}
          active={contextPanelMode === 'pins'}
          controlsPanel
          tooltip={channelId ? 'Pinned Messages' : 'Select a channel to view pins'}
          disabled={!channelId}
        />
        {!isDM && !isVoice && (
          <TopBarIcon
            className="hidden md:block"
            icon={MessagesSquare}
            onClick={panelToggle('threads')}
            active={contextPanelMode === 'threads'}
            controlsPanel
            tooltip="Threads"
          />
        )}
        {isAnnouncementChannel && (
          <TopBarIcon
            className="hidden md:block"
            icon={Share2}
            onClick={() => void openFollowManager()}
            active={showFollowManager}
            tooltip="Manage follows"
            disabled={!channelId}
          />
        )}
        {!isDM && (
          <>
            <TopBarIcon
              className="hidden md:block"
              icon={TrendingUp}
              onClick={panelToggle('economy')}
              active={contextPanelMode === 'economy'}
              controlsPanel
              tooltip="Guild Leaderboard"
            />
            <TopBarIcon
              icon={Users}
              onClick={panelToggle('members')}
              active={contextPanelMode === 'members'}
              controlsPanel
              tooltip="Member List"
            />
            {canOpenSpaceSettings && resolvedGuildId && (
              <TopBarIcon
                className="hidden md:block"
                icon={Settings}
                onClick={openSpaceSettings}
                tooltip="Space settings"
              />
            )}
          </>
        )}
        <TopBarIcon className="hidden md:block" icon={Inbox} onClick={() => void openInbox()} tooltip="Inbox" badge={inboxBadge} />
        <TopBarIcon className="hidden md:block" icon={HelpCircle} onClick={openHelp} tooltip="Shortcuts" />

        <div ref={moreActionsRef} className="relative md:hidden">
          <button
            type="button"
            aria-label="More channel actions"
            aria-haspopup="menu"
            aria-expanded={showMoreActions}
            onClick={() => setShowMoreActions((value) => !value)}
            className={cn(
              'inline-flex h-9 w-9 items-center justify-center rounded-sm text-interactive-normal outline-none transition-colors',
              'hover:bg-bg-mod-subtle hover:text-interactive-hover focus-visible:shadow-[var(--focus-ring)]',
              showMoreActions && 'bg-accent-tint text-accent-primary',
            )}
          >
            <MoreHorizontal size={18} />
          </button>

          {showMoreActions && (
            <div
              role="menu"
              aria-label="More channel actions"
              className="absolute right-0 top-[calc(100%+0.45rem)] z-50 w-56 rounded-md border border-border-subtle bg-bg-floating p-1.5 shadow-lg"
            >
              <MoreAction
                label="Catch up summary"
                icon={Sparkles}
                onClick={() => void openSummary()}
                active={showSummary}
                disabled={!channelId}
              />
              <MoreAction
                label="Pinned messages"
                icon={Pin}
                onClick={panelToggle('pins')}
                active={contextPanelMode === 'pins'}
                disabled={!channelId}
              />
              {!isDM && !isVoice && (
                <MoreAction
                  label="Threads"
                  icon={MessagesSquare}
                  onClick={panelToggle('threads')}
                  active={contextPanelMode === 'threads'}
                />
              )}
              {isAnnouncementChannel && (
                <MoreAction
                  label="Manage follows"
                  icon={Share2}
                  onClick={() => void openFollowManager()}
                  active={showFollowManager}
                  disabled={!channelId}
                />
              )}
              {!isDM && (
                <MoreAction
                  label="Space leaderboard"
                  icon={TrendingUp}
                  onClick={panelToggle('economy')}
                  active={contextPanelMode === 'economy'}
                />
              )}
              {canOpenSpaceSettings && resolvedGuildId && (
                <MoreAction
                  label="Space settings"
                  icon={Settings}
                  onClick={openSpaceSettings}
                />
              )}
              <div className="my-1 h-px bg-border-subtle" aria-hidden />
              <MoreAction
                label="Inbox"
                icon={Inbox}
                onClick={() => void openInbox()}
              />
              <MoreAction
                label="Keyboard shortcuts"
                icon={HelpCircle}
                onClick={openHelp}
              />
            </div>
          )}
        </div>

        {/* Connection latency indicator — isolated so latency ticks don't re-render TopBar */}
        {connectionStatus === 'connected' && <ConnectionLatencyBadge />}
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
    </div>
  );
}
