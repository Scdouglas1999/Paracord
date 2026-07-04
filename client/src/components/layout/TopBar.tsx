import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import {
  AlertTriangle,
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
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { extractApiError } from '../../api/client';
import { channelApi } from '../../api/channels';
import { authApi } from '../../api/auth';
import { useVoice } from '../../hooks/useVoice';
import { useUIStore } from '../../stores/uiStore';
import type { ContextPanelMode } from '../../stores/uiStore';
import { useChannelStore } from '../../stores/channelStore';
import { useReadStateStore } from '../../stores/readStateStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { toast } from '../../stores/toastStore';
import type { ReadState } from '../../types';
import { Tooltip } from '../ui/Tooltip';
import { cn } from '../../lib/utils';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { getVersionedJson } from '../../lib/versionedStorage';
import { TopBarOverlay } from './overlays/TopBarOverlay';
import { InboxOverlay } from './overlays/InboxOverlay';
import { HelpOverlay } from './overlays/HelpOverlay';

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
  const toggleSidebarCollapsed = useUIStore((s) => s.toggleSidebarCollapsed);
  const setCommandPaletteOpen = useUIStore((s) => s.setCommandPaletteOpen);
  const connectionStatus = useUIStore((s) => s.connectionStatus);
  const connectionLatency = useUIStore((s) => s.connectionLatency);
  const channelsByGuild = useChannelStore((s) => s.channelsByGuild);
  const systemAudioCaptureActive = useVoiceStore((s) => s.systemAudioCaptureActive);
  const { connected: voiceConnected, channelId: voiceChannelId, joinChannel, leaveChannel } = useVoice();
  const [dmCallLoading, setDmCallLoading] = useState(false);

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
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryText, setSummaryText] = useState('');
  const [summaryMeta, setSummaryMeta] = useState<{ provider: string; model: string; messageCount: number } | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const followDialogRef = useRef<HTMLDivElement>(null);
  const summaryDialogRef = useRef<HTMLDivElement>(null);
  const [mutedGuildIds, setMutedGuildIds] = useState<string[]>([]);

  useFocusTrap(followDialogRef as RefObject<HTMLDivElement | null>, showFollowManager, () => setShowFollowManager(false));
  useFocusTrap(summaryDialogRef as RefObject<HTMLDivElement | null>, showSummary, () => setShowSummary(false));

  const allChannels = useMemo(() => Object.values(channelsByGuild).flat(), [channelsByGuild]);
  const selectedChannel = useMemo(
    () => (channelId ? allChannels.find((channel) => channel.id === channelId) : undefined),
    [allChannels, channelId],
  );
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
    for (const state of readStates) {
      const channel = allChannels.find((c) => c.id === state.channel_id);
      if (channel?.guild_id && mutedGuildIds.includes(channel.guild_id)) {
        continue;
      }
      const hasUnread = Boolean(channel?.last_message_id && channel.last_message_id !== state.last_message_id);
      if (hasUnread) {
        result.push({
          state,
          channelName: channel?.name || state.channel_id,
        });
      }
    }
    return result;
  }, [readStates, allChannels, mutedGuildIds]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandPaletteOpen(true);
      }
      if (event.key === 'Escape') {
        setShowFollowManager(false);
        setShowInbox(false);
        setShowHelp(false);
        setShowSummary(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [channelId, setCommandPaletteOpen]);

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
    await refreshFollowers();
    setShowFollowManager(true);
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

  const TopBarIcon = ({
    onClick,
    icon: Icon,
    active,
    tooltip,
    disabled,
    className,
    badge,
  }: {
    onClick: () => void;
    icon: LucideIcon;
    active?: boolean;
    tooltip: string;
    disabled?: boolean;
    className?: string;
    badge?: number;
  }) => (
    <div className={className}>
      <Tooltip content={tooltip} side="bottom">
        <button
          aria-label={tooltip}
          aria-pressed={active}
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

  // Drives a ContextPanel mode off the single source of truth.
  const panelToggle = (mode: Exclude<ContextPanelMode, null>) => () => toggleContextPanelMode(mode);

  const ChannelIcon = isVoice ? Volume2 : isForum ? MessageSquare : Hash;
  const showBreadcrumb = !isDM && Boolean(resolvedGuildId) && Boolean(guildName);

  return (
    <div className="z-10 flex h-[3.25rem] w-full shrink-0 items-center justify-between gap-2 border-b border-border-subtle bg-bg-secondary px-3 sm:px-4">
      {/* Left: breadcrumb + channel info */}
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        <button
          type="button"
          onClick={toggleSidebarCollapsed}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-interactive-normal outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-interactive-hover focus-visible:shadow-[var(--focus-ring)]"
          title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
        {isDM ? (
          <div className="flex min-w-0 items-center gap-2.5">
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
                  className="hidden max-w-[10rem] shrink-0 items-center gap-1 rounded-sm px-1.5 py-1 text-label font-medium text-text-secondary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)] sm:inline-flex"
                  aria-label={`Go to ${guildName} home`}
                  title={`Go to ${guildName} home`}
                >
                  <span className="truncate">{guildName}</span>
                </button>
                <ChevronRight size={14} className="hidden shrink-0 text-text-muted sm:block" aria-hidden />
              </>
            )}
            <ChannelIcon size={18} className="shrink-0 text-channel-icon" />
            <span className="truncate text-[15px] font-semibold text-text-primary">
              {channelName || 'channel'}
            </span>
            {channelTopic && (
              <>
                <span className="hidden h-4 w-px shrink-0 bg-border-strong md:block" aria-hidden />
                <span className="hidden min-w-0 truncate text-label text-text-secondary md:block">
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
          tooltip={channelId ? 'Search Messages' : 'Select a channel to search'}
          disabled={!channelId}
        />
        <TopBarIcon
          icon={Sparkles}
          onClick={() => void openSummary()}
          active={showSummary}
          tooltip={channelId ? 'Summarize Channel' : 'Select a channel to summarize'}
          disabled={!channelId}
        />
        <TopBarIcon
          icon={Pin}
          onClick={panelToggle('pins')}
          active={contextPanelMode === 'pins'}
          tooltip={channelId ? 'Pinned Messages' : 'Select a channel to view pins'}
          disabled={!channelId}
        />
        {!isDM && !isVoice && (
          <TopBarIcon
            icon={MessagesSquare}
            onClick={panelToggle('threads')}
            active={contextPanelMode === 'threads'}
            tooltip="Threads"
          />
        )}
        {isAnnouncementChannel && (
          <TopBarIcon
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
              icon={TrendingUp}
              onClick={panelToggle('economy')}
              active={contextPanelMode === 'economy'}
              tooltip="Guild Leaderboard"
            />
            <TopBarIcon
              icon={Users}
              onClick={panelToggle('members')}
              active={contextPanelMode === 'members'}
              tooltip="Member List"
            />
          </>
        )}
        <TopBarIcon icon={Inbox} onClick={() => void openInbox()} tooltip="Inbox" badge={unreadItems.length} />
        <TopBarIcon className="hidden md:block" icon={HelpCircle} onClick={() => setShowHelp(true)} tooltip="Shortcuts" />

        {/* Connection latency indicator */}
        {connectionStatus === 'connected' && (
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
        )}
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
