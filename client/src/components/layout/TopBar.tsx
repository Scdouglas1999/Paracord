import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import {
  AlertTriangle,
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
  X,
  PanelLeftClose,
  PanelLeftOpen,
  Wifi,
  Phone,
  PhoneOff,
  Loader2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { extractApiError } from '../../api/client';
import { channelApi } from '../../api/channels';
import { authApi } from '../../api/auth';
import { useVoice } from '../../hooks/useVoice';
import { useUIStore } from '../../stores/uiStore';
import { useChannelStore } from '../../stores/channelStore';
import { useReadStateStore } from '../../stores/readStateStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { toast } from '../../stores/toastStore';
import type { Message, ReadState } from '../../types';
import { Tooltip } from '../ui/Tooltip';
import { cn } from '../../lib/utils';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useMobile } from '../../hooks/useMobile';
import { getVersionedJson } from '../../lib/versionedStorage';
import { TopBarOverlay } from './overlays/TopBarOverlay';
import { SearchOverlay } from './overlays/SearchOverlay';
import { PinnedMessagesOverlay } from './overlays/PinnedMessagesOverlay';
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
}

export function TopBar({ channelName, channelTopic, isVoice, isForum, isDM, recipientName, dmChannelId }: TopBarProps) {
  const { channelId } = useParams();
  const toggleMemberPanel = useUIStore((s) => s.toggleMemberPanel);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const setSidebarCollapsed = useUIStore((s) => s.setSidebarCollapsed);
  const memberPanelOpen = useUIStore((s) => s.memberPanelOpen);
  const setCommandPaletteOpen = useUIStore((s) => s.setCommandPaletteOpen);
  const toggleSearchPanel = useUIStore((s) => s.toggleSearchPanel);
  const searchPanelOpen = useUIStore((s) => s.searchPanelOpen);
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

  const [pins, setPins] = useState<Message[]>([]);
  const [showFollowManager, setShowFollowManager] = useState(false);
  const [followers, setFollowers] = useState<
    Array<{ id: string; target_channel_id: string; target_guild_id: string }>
  >([]);
  const [followersLoading, setFollowersLoading] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);
  const [followBusyTargetId, setFollowBusyTargetId] = useState<string | null>(null);
  const [showPins, setShowPins] = useState(false);
  const [pinsError, setPinsError] = useState<string | null>(null);
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
  const isMobile = useMobile();

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
        setShowPins(false);
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

  const openPins = async () => {
    if (!channelId) return;
    setPinsError(null);
    try {
      const { data } = await channelApi.getPins(channelId);
      setPins(data);
    } catch (err) {
      setPins([]);
      setPinsError(`Failed to load pinned messages: ${extractApiError(err)}`);
    }
    setShowPins(true);
  };

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
          onClick={onClick}
          disabled={disabled}
          className={cn(
            'architect-top-icon relative',
            active && 'architect-top-icon-active',
            disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-text-muted'
          )}
        >
          <Icon size={isMobile ? 17 : 16} />
          {badge != null && badge > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-primary px-1 text-[9px] font-bold text-white">
              {badge > 99 ? '99+' : badge}
            </span>
          )}
        </button>
      </Tooltip>
    </div>
  );

  return (
    <div className="z-10 flex min-h-[80px] w-full shrink-0 items-start justify-between px-4 pb-3 pt-4 sm:px-5 sm:pb-3.5 sm:pt-4.5 md:px-6">
      {/* Left: channel info */}
      <div className="mr-2 flex min-w-0 flex-1 items-start overflow-hidden sm:mr-3">
        {!isMobile && (
          <button
            type="button"
            onClick={toggleSidebar}
            className={cn(
              'mr-3.5 mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors',
              sidebarOpen
                ? 'border-border-subtle bg-bg-mod-subtle text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary'
                : 'border-border-subtle/80 bg-bg-mod-subtle/40 text-text-muted hover:bg-bg-mod-subtle hover:text-text-primary'
            )}
            title={sidebarOpen ? 'Collapse channel sidebar' : 'Expand channel sidebar'}
            aria-label={sidebarOpen ? 'Collapse channel sidebar' : 'Expand channel sidebar'}
          >
            {sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
          </button>
        )}
        {isMobile && (
          <button
            type="button"
            onClick={() => {
              if (!sidebarOpen) toggleSidebar();
              setSidebarCollapsed(false);
            }}
            className="mr-2.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border-subtle/70 bg-bg-mod-subtle text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
            title="Open sidebar"
            aria-label="Open sidebar"
          >
            <PanelLeftOpen size={16} />
          </button>
        )}
        {isDM ? (
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-bg-mod-strong text-sm font-semibold text-text-primary">
              {recipientName?.charAt(0).toUpperCase() || '?'}
            </div>
            <div className="min-w-0">
              <span className="block truncate text-[17px] font-semibold leading-tight text-text-primary">
                {recipientName || 'Direct Message'}
              </span>
              <span className="mt-1 block truncate text-xs text-text-muted">Direct conversation</span>
            </div>
          </div>
        ) : (
          <div className="flex min-w-0 flex-col pt-0.5">
            <div className="flex min-w-0 items-center gap-2">
              {isVoice ? (
                <Volume2 size={15} className="shrink-0 text-text-muted" />
              ) : isForum ? (
                <MessageSquare size={15} className="shrink-0 text-text-muted" />
              ) : (
                <Hash size={15} className="shrink-0 text-text-muted" />
              )}
              <span className="truncate text-[17px] font-semibold leading-tight text-text-primary">
                {`# ${channelName || 'channel'}`}
              </span>
            </div>
            <span className="mt-1 block max-w-[54ch] truncate text-xs text-text-muted">
              {channelTopic || 'Conversation and collaboration'}
            </span>
          </div>
        )}
      </div>

      {/* Right: action buttons */}
      <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
        {systemAudioCaptureActive && (
          <TopBarIcon
            icon={AlertTriangle}
            onClick={() => { }}
            active
            tooltip="System audio capture is active"
            disabled
            className="text-amber-400"
          />
        )}
        {isDM && (dmChannelId || channelId) && (
          <Tooltip content={isInDmCall ? 'End Call' : 'Start Voice Call'} side="bottom">
            <button
              aria-label={isInDmCall ? 'End direct message call' : 'Start direct message voice call'}
              onClick={() => void handleDmCallToggle()}
              disabled={dmCallLoading}
              className={cn(
                'architect-top-icon',
                isInDmCall ? 'text-accent-danger hover:bg-accent-danger/10' : 'text-accent-success hover:bg-accent-success/10',
                dmCallLoading && 'cursor-not-allowed opacity-40'
              )}
            >
              {isInDmCall ? <PhoneOff size={isMobile ? 17 : 16} /> : <Phone size={isMobile ? 17 : 16} />}
            </button>
          </Tooltip>
        )}
        <TopBarIcon
          icon={Search}
          onClick={() => toggleSearchPanel()}
          active={searchPanelOpen}
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
          onClick={() => void openPins()}
          tooltip={channelId ? 'Pinned Messages' : 'Select a channel to view pins'}
          disabled={!channelId}
        />
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
          <TopBarIcon
            icon={Users}
            onClick={() => toggleMemberPanel()}
            active={memberPanelOpen}
            tooltip="Member List"
          />
        )}
        <TopBarIcon icon={Inbox} onClick={() => void openInbox()} tooltip="Inbox" badge={unreadItems.length} />
        <TopBarIcon className="hidden md:block" icon={HelpCircle} onClick={() => setShowHelp(true)} tooltip="Shortcuts" />

        {/* Connection latency indicator */}
        {connectionStatus === 'connected' && (
          <Tooltip content={`Latency: ${connectionLatency}ms`} side="bottom">
            <div className="hidden items-center gap-1 rounded-lg border border-border-subtle/60 px-2 py-1 md:flex">
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

      {/* Search overlay */}
      <SearchOverlay
        open={searchPanelOpen}
        onClose={() => toggleSearchPanel()}
        channelId={channelId}
        channelName={channelName}
        allChannels={allChannels}
      />

      {/* Summary overlay */}
      <TopBarOverlay
        open={showSummary}
        onClose={() => setShowSummary(false)}
        dialogRef={summaryDialogRef as RefObject<HTMLDivElement | null>}
        titleId="topbar-summary-title"
        panelClassName="max-h-[min(82dvh,40rem)] w-full max-w-2xl"
      >
              <div className="panel-divider flex items-center justify-between border-b px-5 py-4.5">
                <div className="flex items-center gap-2">
                  <Sparkles size={16} className="text-accent-primary" />
                  <div id="topbar-summary-title" className="font-bold text-text-primary">Catch Up Summary</div>
                </div>
                <button className="command-icon-btn" onClick={() => setShowSummary(false)} aria-label="Close summary"><X size={16} /></button>
              </div>
              <div className="max-h-[min(67dvh,31rem)] overflow-y-auto bg-bg-primary p-4 sm:p-5 scrollbar-thin">
                {summaryLoading ? (
                  <div className="flex items-center justify-center gap-2 py-12 text-text-muted">
                    <Loader2 size={16} className="animate-spin" />
                    <span>Generating summary...</span>
                  </div>
                ) : summaryError ? (
                  <div
                    role="alert"
                    className="rounded-xl border border-accent-danger/30 bg-accent-danger/10 px-4 py-3 text-sm text-accent-danger"
                  >
                    {summaryError}
                  </div>
                ) : (
                  <>
                    {summaryMeta && (
                      <div className="mb-3 text-xs text-text-muted">
                        Provider: <span className="font-semibold text-text-secondary">{summaryMeta.provider}</span>
                        {' · '}
                        Model: <span className="font-semibold text-text-secondary">{summaryMeta.model}</span>
                        {' · '}
                        Messages: <span className="font-semibold text-text-secondary">{summaryMeta.messageCount}</span>
                      </div>
                    )}
                    <pre className="whitespace-pre-wrap rounded-xl border border-border-subtle bg-bg-mod-subtle p-4 text-sm leading-6 text-text-secondary">
                      {summaryText || 'No summary available.'}
                    </pre>
                  </>
                )}
              </div>
      </TopBarOverlay>

      {/* Pins overlay */}
      <PinnedMessagesOverlay
        open={showPins}
        onClose={() => setShowPins(false)}
        channelId={channelId}
        pins={pins}
        onPinsChange={setPins}
        error={pinsError}
        onErrorChange={setPinsError}
      />

      {/* Channel follows overlay */}
      <TopBarOverlay
        open={showFollowManager}
        onClose={() => setShowFollowManager(false)}
        dialogRef={followDialogRef as RefObject<HTMLDivElement | null>}
        titleId="topbar-follows-title"
        panelClassName="max-h-[min(82dvh,40rem)] w-full max-w-xl"
      >
        <div className="panel-divider flex items-center justify-between border-b px-5 py-4.5">
          <div id="topbar-follows-title" className="font-bold text-text-primary">
            Channel Follows
          </div>
          <button
            className="command-icon-btn"
            onClick={() => setShowFollowManager(false)}
            aria-label="Close channel follows"
          >
            <X size={16} />
          </button>
        </div>
        <div className="max-h-[min(67dvh,31rem)] space-y-3 overflow-y-auto bg-bg-primary p-4 sm:p-5 scrollbar-thin">
          {followError && (
            <div
              role="alert"
              className="rounded-xl border border-accent-danger/30 bg-accent-danger/10 px-4 py-3 text-sm text-accent-danger"
            >
              {followError}
            </div>
          )}
          {followersLoading ? (
            <div className="py-6 text-center text-sm text-text-muted">Loading follows...</div>
          ) : (
            <div className="space-y-2">
              {followTargets.map((targetChannel) => {
                const existing = followers.find(
                  (entry) => entry.target_channel_id === targetChannel.id,
                );
                const busy = followBusyTargetId === targetChannel.id;
                return (
                  <div
                    key={targetChannel.id}
                    className="flex items-center justify-between rounded-xl border border-border-subtle bg-bg-mod-subtle/40 px-3 py-2.5"
                  >
                    <span className="truncate text-sm font-medium text-text-primary">
                      # {targetChannel.name}
                    </span>
                    {existing ? (
                      <button
                        type="button"
                        className="rounded-md border border-accent-danger/35 bg-accent-danger/10 px-2.5 py-1 text-xs font-semibold text-accent-danger transition-colors hover:bg-accent-danger/15 disabled:opacity-60"
                        onClick={() => void removeFollower(targetChannel.id)}
                        disabled={busy}
                      >
                        {busy ? 'Removing...' : 'Unfollow'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="rounded-md border border-accent-primary/40 bg-accent-primary/10 px-2.5 py-1 text-xs font-semibold text-accent-primary transition-colors hover:bg-accent-primary/20 disabled:opacity-60"
                        onClick={() => void addFollower(targetChannel.id, targetChannel.guild_id || '')}
                        disabled={busy || !targetChannel.guild_id}
                      >
                        {busy ? 'Adding...' : 'Follow'}
                      </button>
                    )}
                  </div>
                );
              })}
              {followTargets.length === 0 && (
                <div className="rounded-xl border border-border-subtle bg-bg-mod-subtle/40 px-4 py-6 text-center text-sm text-text-muted">
                  No eligible text channels available for follows.
                </div>
              )}
            </div>
          )}
        </div>
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
