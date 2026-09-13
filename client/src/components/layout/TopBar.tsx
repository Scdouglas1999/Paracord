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
  Hash,
  Search,
  Sparkles,
  Pin,
  Share2,
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
  Users,
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
import { HereNowStrip, LitAvatar } from '../light';
import { Well } from '../ui';
import { useHereNow, useRoomLight } from '../../hooks/useLights';
import { flicker, onMotion, RollingNumber } from '../../lib/motion';
import {
  isReading,
  peerLightSentence,
  useDmLight,
} from '../message/messageLight';
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

/**
 * Pinned-message counts, remembered per channel for a few minutes.
 *
 * §7.4 puts a count on the header's pins control, and the server has no count
 * endpoint — only the list. Caching it keeps a room switch from re-asking for
 * something that changes rarely, and a failure simply leaves the control
 * countless rather than showing a number nobody can trust.
 */
const PIN_COUNT_TTL_MS = 5 * 60_000;
const pinCountCache = new Map<string, { count: number; atMs: number }>();

/** Isolated so connectionLatency ticks don't re-render the full TopBar. */
function ConnectionLatencyBadge() {
  const connectionLatency = useUIStore((s) => s.connectionLatency);
  return (
    <Tooltip content={`Latency: ${connectionLatency}ms`} side="bottom">
      <div className="chat-header-connection ml-1 items-center gap-1.5 rounded-[var(--radius-chip)] bg-bg-raised px-2 py-1 shadow-[var(--shadow-chip)]">
        <Wifi size={12} className={cn(
          connectionLatency < 100
            ? 'text-accent-success'
            : connectionLatency < 300
              ? 'text-accent-warning'
              : 'text-accent-danger'
        )} />
        <span className={cn(
          'pc-mono text-[10px] font-semibold',
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
  const { actions, encrypted, encryption } = useConversationActions(dmChannelId ?? channelId);

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

  /* --- The room, as light (§7.4 / §7.6) ---------------------------------- */
  const conversationId = dmChannelId ?? channelId;
  // A guild room is lit by its building; a DM is a text room in its own right.
  // Both hooks run unconditionally — only one of them has anything to say.
  const roomLight = useRoomLight(isDM ? null : resolvedGuildId, isDM ? null : channelId);
  const hereNow = useHereNow(isDM ? null : resolvedGuildId, isDM ? null : channelId);
  const dm = useDmLight(isDM ? conversationId : undefined, readScope);
  const peerReading = isReading(dm.room, dm.peer?.userId);
  const roomIsLit = isDM ? Boolean(dm.room?.lit) : Boolean(roomLight?.lit);
  const roomIsVoice = Boolean(isVoice);
  /* §5.1: "reading light flickers once when a message lands". This window IS
     the room's reading light, and the message that lands is one the person at
     this keyboard just sent — so the composer says so on the motion bus and the
     window answers. Nothing else on screen moves. */
  const roomWindowRef = useRef<HTMLSpanElement>(null);
  useEffect(
    () => onMotion('say:sent', (detail) => {
      if (detail.channelId === conversationId) flicker(roomWindowRef.current);
    }),
    [conversationId],
  );
  // §7.6: the encryption state is a plain label, never a badge or a lock icon
  // standing on its own.
  const encryptionLabel = !encrypted
    ? 'Not encrypted'
    : encryption === 'ready'
      ? 'End-to-end encrypted'
      : encryption === 'unlock'
        ? 'Encryption locked on this device'
        : encryption === 'identity_mismatch'
          ? 'Encryption keys do not match'
          : 'Encryption needs setup';
  const roomSubtitle = [guildName, channelTopic].filter(Boolean).join(' · ');

  // Threads are already in the channel list — counting them costs nothing.
  const threadCount = useMemo(() => {
    if (isDM || !resolvedGuildId || !channelId) return 0;
    return (channelsByGuild[resolvedGuildId] ?? []).filter(
      (entry) =>
        (entry.channel_type ?? entry.type) === 6 && entry.parent_id === channelId,
    ).length;
  }, [channelId, channelsByGuild, isDM, resolvedGuildId]);

  const pinScopeKey = readScope && conversationId ? entityScopeKey(readScope, conversationId) : null;
  const [pinCount, setPinCount] = useState<number | null>(() =>
    pinScopeKey ? (pinCountCache.get(pinScopeKey)?.count ?? null) : null,
  );
  useEffect(() => {
    if (!pinScopeKey || !conversationId) {
      setPinCount(null);
      return;
    }
    const cached = pinCountCache.get(pinScopeKey);
    if (cached && Date.now() - cached.atMs < PIN_COUNT_TTL_MS) {
      setPinCount(cached.count);
      return;
    }
    let cancelled = false;
    channelApi
      .getPins(conversationId)
      .then(({ data }) => {
        if (cancelled) return;
        pinCountCache.set(pinScopeKey, { count: data.length, atMs: Date.now() });
        setPinCount(data.length);
      })
      .catch(() => {
        // A count is decoration; the pins panel reports its own failure.
        if (!cancelled) setPinCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, pinScopeKey]);

  const primaryActions: HeaderAction[] = [
    ...(isDM && (dmChannelId || channelId) ? [{
      label: isInDmCall ? 'End direct message call' : 'Start direct message voice call',
      icon: isInDmCall ? PhoneOff : Phone,
      onClick: () => void handleDmCallToggle(),
      active: Boolean(isInDmCall),
      disabled: dmCallLoading || (!isInDmCall && !actions.voice.allowed),
      reason: isInDmCall ? null : actions.voice.reason,
    }] : []),
    { label: 'Search messages', icon: Search, onClick: panelToggle('search'),
      active: contextPanelMode === 'search', controlsPanel: true, disabled: !channelId,
      reason: channelId ? null : 'Select a channel to search' },
    // §7.4: pins and threads sit in the header with their counts. Below the
    // small breakpoint they fold into the overflow menu (layout-spec §7.8),
    // which lists them at every width.
    { label: 'Pinned messages', icon: Pin, onClick: panelToggle('pins'),
      active: contextPanelMode === 'pins', controlsPanel: true, disabled: !channelId,
      count: pinCount, overflowWhenNarrow: true },
    ...(!isDM && !isVoice ? [{ label: 'Threads', icon: MessagesSquare, onClick: panelToggle('threads'),
      active: contextPanelMode === 'threads', controlsPanel: true,
      count: threadCount, overflowWhenNarrow: true }] : []),
  ];
  const secondaryActions: ContextMenuItem[] = [
    { label: 'Catch up summary', icon: <Sparkles size={17} />, action: () => void openSummary(),
      disabled: !actions.summary.allowed, description: actions.summary.reason ?? undefined },
    { label: 'Pinned messages', icon: <Pin size={17} />, action: panelToggle('pins'), disabled: !channelId },
    ...(!isDM && !isVoice ? [{ label: 'Threads', icon: <MessagesSquare size={17} />, action: panelToggle('threads') }] : []),
    ...(isAnnouncementChannel ? [{ label: 'Manage follows', icon: <Share2 size={17} />, action: () => void openFollowManager(), disabled: !channelId }] : []),
    // A group message's recipients: who it is addressed to, and the only list
    // the panel still opens (§6.5, §7.6). A 1:1 DM's "list" is the one person
    // already named in the header strip.
    ...(isGroupDm ? [{ label: 'People in this message', icon: <Users size={17} />, action: panelToggle('recipients') }] : []),
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
    recipients: { label: 'People in this message', icon: Users, onClose: panelToggle('recipients') },
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
    <div className={cn('chat-header relative z-10 w-full shrink-0 border-b border-border-subtle', isGroupDm && 'chat-header-group-dm')}>
      <div className="flex min-h-[3.5rem] flex-wrap items-center gap-x-3.5 gap-y-2 px-3 py-2.5 sm:px-6 sm:py-3.5">
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
          className="chat-header-navigation pc-focusable inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-text-secondary transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary"
          title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>

        {isDM ? (
          /* §7.6: a DM is a text room between two people. The peer's own light
             is the window dot, so the header opens with their face. */
          <div className="flex min-w-0 items-center gap-2.5">
            <button
              type="button"
              onClick={() => navigate('/app/dms')}
              className="pc-focusable inline-flex h-8 shrink-0 items-center gap-1 rounded-[var(--radius-control)] px-1.5 text-label font-medium text-text-secondary transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary sm:px-2"
              aria-label="Back to messages"
              title="Back to messages"
            >
              <ChevronLeft size={16} aria-hidden />
              <span className="hidden sm:inline">Messages</span>
            </button>
            {dm.peer ? (
              <LitAvatar person={dm.peer} size={32} hideLabel className="chat-header-avatar" />
            ) : (
              <span
                ref={roomWindowRef}
                className={cn('pc-window h-2.5 w-2.5 shrink-0', roomIsLit && 'is-reading')}
                aria-hidden
              />
            )}
            <div className="flex min-w-0 flex-col">
              <span className="chat-header-dm-name pc-display truncate text-[20px] font-bold leading-tight tracking-[-0.01em] text-text-primary">
                {recipientName || 'Direct message'}
              </span>
              <span className="hidden truncate text-meta text-text-faint lg:block">
                {encryptionLabel}
              </span>
            </div>
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-2.5">
            {/* The room's own window: amber when people are reading it, white
                when it is a voice room with people in it, dark when nobody is
                there. The counts beside it are the words that go with it. */}
            <span
              ref={roomWindowRef}
              className={cn(
                'pc-window h-2.5 w-2.5 shrink-0',
                roomIsLit && (roomIsVoice ? 'is-talking' : 'is-reading'),
              )}
              aria-hidden
            />
            <div className="flex min-w-0 flex-col">
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
                <span className="flex min-w-0 items-center gap-1.5">
                  <ChannelIcon size={18} className="shrink-0 text-channel-icon" />
                  <span className="pc-display truncate text-[20px] font-bold leading-tight tracking-[-0.01em] text-text-primary">
                    {channelName || 'channel'}
                  </span>
                </span>
              )}
              {/* §7.4: "Kestrel Robotics · Hardware bring-up" — the building is
                  the way back to its Lobby, so it is the only breadcrumb the
                  header needs. */}
              {roomSubtitle && (
                <span className="hidden min-w-0 truncate text-meta text-text-faint lg:block">
                  {showBreadcrumb ? (
                    <>
                      <button
                        type="button"
                        onClick={() => navigate(`/app/guilds/${resolvedGuildId}`)}
                        className="pc-focusable rounded-[var(--radius-window)] transition-colors duration-[140ms] ease-[var(--ease-out)] hover:text-text-secondary hover:underline"
                        aria-label={`Go to ${guildName} home`}
                        title={`Go to ${guildName} home`}
                      >
                        {guildName}
                      </button>
                      {channelTopic ? ` · ${channelTopic}` : ''}
                    </>
                  ) : (
                    roomSubtitle
                  )}
                </span>
              )}
            </div>
          </div>
        )}

        {/* §6.5: the people who are here now are a lit strip in the header, and
            its sheet is the only full list of people in the product. */}
        {isDM ? (
          // A one-to-one DM's "full list" is one person, so the strip simply
          // states their light; a group is a room and gets the people sheet.
          !isGroupDm && dm.peer ? (
            <Well
              bare
              as="div"
              className="hidden min-w-0 items-center gap-2.5 rounded-[var(--radius-card)] py-[5px] pl-[7px] pr-3 md:flex"
            >
              <LitAvatar person={dm.peer} size={24} hideLabel />
              <span className="min-w-0 truncate text-label text-text-body">
                <span className="font-semibold text-text-primary">{dm.peer.name}</span>
                {peerLightSentence(dm.peer, peerReading).slice(dm.peer.name.length)}
              </span>
            </Well>
          ) : (
            <HereNowStrip
              hereNow={dm.hereNow}
              everyone={dm.people}
              context={`reading ${dm.name}`}
              className="hidden md:block"
              caption={
                <>
                  <RollingNumber
                    className="font-semibold text-text-primary"
                    value={dm.hereNow.here}
                    format={(count) => `${count} reading`}
                  />
                  {' · '}
                  <RollingNumber
                    value={dm.hereNow.lightsOn}
                    format={(count) => `${count} lights on`}
                    announce={false}
                  />
                </>
              }
            />
          )
        ) : (
          !isVoice && (
            // §7.4: a text room's strip says what being there means — "5
            // reading · 19 lights on" — not the Stage's "N here".
            <HereNowStrip
              hereNow={hereNow}
              context={`reading ${channelName ?? 'this room'}`}
              className="hidden md:block"
              caption={
                // §5.1 "numbers re-roll": these two change when somebody starts
                // or stops reading the room, which is a thing a person did.
                <>
                  <RollingNumber
                    className="font-semibold text-text-primary"
                    value={hereNow.here}
                    format={(count) => `${count} reading`}
                  />
                  {' · '}
                  <RollingNumber
                    value={hereNow.lightsOn}
                    format={(count) => `${count} lights on`}
                    announce={false}
                  />
                </>
              }
            />
          )
        )}

        {isGroupDm && <div className="chat-header-mobile-dm-title w-full">{recipientName || 'Group message'}</div>}

        <div className="ml-auto flex min-w-0 items-center gap-2">
          <ConversationHeaderActions primary={primaryActions} items={secondaryActions}
            activeSurface={activeSurface} unread={unreadItems.length} mentions={inboxMentions}
            indicator={connectionStatus === 'connected' ? <ConnectionLatencyBadge /> : undefined} />
        </div>

        {systemAudioCaptureActive && <div role="status" aria-label="System audio capture is active" className="chat-header-capture-status w-full">
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

      {/* Channel follows overlay */}
      <TopBarOverlay
        open={showFollowManager}
        onClose={() => setShowFollowManager(false)}
        dialogRef={followDialogRef as RefObject<HTMLDivElement | null>}
        titleId="topbar-follows-title"
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
                      className="inline-flex h-8 shrink-0 items-center rounded-chip bg-bg-mod-subtle px-3 text-meta font-semibold text-accent-danger outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-danger-tint focus-visible:shadow-[var(--focus-ring)] disabled:opacity-60"
                      onClick={() => void removeFollower(targetChannel.id)}
                      disabled={busy}
                    >
                      {busy ? 'Removing…' : 'Unfollow'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="inline-flex h-8 shrink-0 items-center rounded-chip bg-accent-primary px-3 text-meta font-semibold text-text-on-accent shadow-[var(--shadow-chip)] outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-primary-hover focus-visible:shadow-[var(--focus-ring)] disabled:opacity-60"
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
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-chip bg-accent-tint text-accent-primary">
              <Share2 size={20} />
            </span>
            <div className="min-w-0 pt-0.5">
              <h3 className="text-heading text-text-primary">Nothing to follow into yet</h3>
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
