import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Hash,
  Search,
  Pin,
  Users,
  Inbox,
  HelpCircle,
  Volume2,
  MessageSquare,
  X,
  PanelLeftClose,
  PanelLeftOpen,
  Wifi,
} from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { useNavigate, useParams } from 'react-router-dom';
import { channelApi } from '../../api/channels';
import { authApi } from '../../api/auth';
import { useUIStore } from '../../stores/uiStore';
import { useChannelStore } from '../../stores/channelStore';
import { useMessageStore } from '../../stores/messageStore';
import { useVoiceStore } from '../../stores/voiceStore';
import type { Message, ReadState } from '../../types';
import { Tooltip } from '../ui/Tooltip';
import { cn } from '../../lib/utils';
import { useFocusTrap } from '../../hooks/useFocusTrap';

interface TopBarProps {
  channelName?: string;
  channelTopic?: string;
  isVoice?: boolean;
  isForum?: boolean;
  isDM?: boolean;
  recipientName?: string;
}

export function TopBar({ channelName, channelTopic, isVoice, isForum, isDM, recipientName }: TopBarProps) {
  const { channelId } = useParams();
  const navigate = useNavigate();
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
  const unpinMessage = useMessageStore((s) => s.unpinMessage);
  const channelsByGuild = useChannelStore((s) => s.channelsByGuild);
  const systemAudioCaptureActive = useVoiceStore((s) => s.systemAudioCaptureActive);

  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Message[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [showPins, setShowPins] = useState(false);
  const [pins, setPins] = useState<Message[]>([]);
  const [showInbox, setShowInbox] = useState(false);
  const [readStates, setReadStates] = useState<ReadState[]>([]);
  const [showHelp, setShowHelp] = useState(false);
  const searchDialogRef = useRef<HTMLDivElement>(null);
  const pinsDialogRef = useRef<HTMLDivElement>(null);
  const inboxDialogRef = useRef<HTMLDivElement>(null);
  const helpDialogRef = useRef<HTMLDivElement>(null);
  const [mutedGuildIds, setMutedGuildIds] = useState<string[]>([]);
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(max-width: 768px)').matches;
  });

  useFocusTrap(searchDialogRef, showSearch, () => setShowSearch(false));
  useFocusTrap(pinsDialogRef, showPins, () => setShowPins(false));
  useFocusTrap(inboxDialogRef, showInbox, () => setShowInbox(false));
  useFocusTrap(helpDialogRef, showHelp, () => setShowHelp(false));

  const allChannels = useMemo(() => Object.values(channelsByGuild).flat(), [channelsByGuild]);

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
    if (!showSearch || !channelId || !searchQuery.trim()) {
      setSearchResults([]);
      setSearchError(null);
      return;
    }
    const timeout = setTimeout(async () => {
      try {
        const { data } = await channelApi.searchMessages(channelId, searchQuery.trim(), 25);
        setSearchResults(data);
        setSearchError(null);
      } catch {
        try {
          const { data: recent } = await channelApi.getMessages(channelId, { limit: 100 });
          const query = searchQuery.trim().toLowerCase();
          const fallbackResults = recent
            .filter((message) => {
              const content = (message.content ?? '').toLowerCase();
              const author = (message.author?.username ?? '').toLowerCase();
              return content.includes(query) || author.includes(query);
            })
            .slice(0, 25);

          setSearchResults(fallbackResults);
          setSearchError(
            fallbackResults.length === 0 ? 'Search is temporarily unavailable for this server.' : null
          );
        } catch {
          setSearchResults([]);
          setSearchError('Search is temporarily unavailable for this server.');
        }
      }
    }, 250);
    return () => clearTimeout(timeout);
  }, [showSearch, channelId, searchQuery]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandPaletteOpen(true);
      }
      if (event.key === 'Escape') {
        setShowSearch(false);
        setShowPins(false);
        setShowInbox(false);
        setShowHelp(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [channelId, setCommandPaletteOpen]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mediaQuery = window.matchMedia('(max-width: 768px)');
    const updateIsMobile = () => setIsMobile(mediaQuery.matches);
    updateIsMobile();
    mediaQuery.addEventListener('change', updateIsMobile);
    return () => mediaQuery.removeEventListener('change', updateIsMobile);
  }, []);

  useEffect(() => {
    let disposed = false;
    const refreshReadStates = async () => {
      try {
        const { data } = await authApi.getReadStates();
        if (!disposed) {
          setReadStates(data);
        }
      } catch {
        // keep existing unread snapshot on transient fetch failures
      }
    };

    void refreshReadStates();
    const intervalId = window.setInterval(() => {
      void refreshReadStates();
    }, 30000);

    // Immediately refresh when a channel is marked as read
    const onReadStateUpdated = () => void refreshReadStates();
    window.addEventListener('paracord:read-state-updated', onReadStateUpdated);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
      window.removeEventListener('paracord:read-state-updated', onReadStateUpdated);
    };
  }, []);

  useEffect(() => {
    const readMutedGuilds = () => {
      try {
        const raw = localStorage.getItem('paracord:muted-guilds');
        setMutedGuildIds(raw ? JSON.parse(raw) : []);
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
    try {
      const { data } = await channelApi.getPins(channelId);
      setPins(data);
    } catch {
      setPins([]);
    }
    setShowPins(true);
  };

  const openInbox = async () => {
    try {
      const raw = localStorage.getItem('paracord:muted-guilds');
      setMutedGuildIds(raw ? JSON.parse(raw) : []);
    } catch {
      setMutedGuildIds([]);
    }
    try {
      const { data } = await authApi.getReadStates();
      setReadStates(data);
    } catch {
      setReadStates([]);
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
    icon: any;
    active?: boolean;
    tooltip: string;
    disabled?: boolean;
    className?: string;
    badge?: number;
  }) => (
    <div className={className}>
      <Tooltip content={tooltip} side="bottom">
        <button
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
    <div className="z-10 flex min-h-[80px] w-full shrink-0 items-start justify-between border-b border-border-subtle/50 px-4 pb-3 pt-4 sm:px-5 sm:pb-3.5 sm:pt-4.5 md:px-6">
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
            onClick={() => {}}
            active
            tooltip="System audio capture is active"
            disabled
            className="text-amber-400"
          />
        )}
        <TopBarIcon
          icon={Search}
          onClick={() => toggleSearchPanel()}
          active={searchPanelOpen}
          tooltip={channelId ? 'Search Messages' : 'Select a channel to search'}
          disabled={!channelId}
        />
        <TopBarIcon
          icon={Pin}
          onClick={() => void openPins()}
          tooltip={channelId ? 'Pinned Messages' : 'Select a channel to view pins'}
          disabled={!channelId}
        />
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
      <AnimatePresence>
        {showSearch && (
          <div
            className="fixed inset-0 z-50 flex items-start justify-center px-2 pb-[calc(var(--safe-bottom)+0.75rem)] pt-[calc(var(--safe-top)+3.75rem)] sm:px-4 sm:pt-20"
            style={{ backgroundColor: 'var(--overlay-backdrop)' }}
            onClick={() => setShowSearch(false)}
          >
            <motion.div
              ref={searchDialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="topbar-search-title"
              tabIndex={-1}
              initial={{ opacity: 0, scale: 0.95, y: -20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: -20 }}
              transition={{ duration: 0.18 }}
              className="glass-modal max-h-[min(82dvh,44rem)] w-full max-w-3xl overflow-hidden rounded-xl border sm:rounded-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="panel-divider flex items-center gap-3 border-b px-5 py-4.5">
                <span id="topbar-search-title" className="sr-only">Search Messages</span>
                <Search size={20} className="text-text-muted" />
                <input
                  autoFocus
                  className="flex-1 bg-transparent text-lg text-text-primary outline-none placeholder:text-text-muted"
                  placeholder={channelId ? `Search in #${channelName || 'channel'}` : 'Search messages'}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                <button className="command-icon-btn" onClick={() => setShowSearch(false)} aria-label="Close search"><X size={16} /></button>
              </div>
              <div className="max-h-[min(67dvh,34rem)] overflow-y-auto p-3.5 scrollbar-thin">
                {searchResults.length > 0 ? (
                  <div className="space-y-1.5">
                    {searchResults.map((msg) => (
                      <button
                        key={msg.id}
                        className="group w-full rounded-xl border border-transparent p-3.5 text-left transition-all hover:border-border-subtle hover:bg-bg-mod-subtle"
                        onClick={() => {
                          const messageChannel = allChannels.find((c) => c.id === msg.channel_id);
                          if (messageChannel?.guild_id) {
                            navigate(`/app/guilds/${messageChannel.guild_id}/channels/${msg.channel_id}`);
                          } else {
                            navigate(`/app/dms/${msg.channel_id}`);
                          }
                          window.location.hash = `msg-${msg.id}`;
                          setShowSearch(false);
                        }}
                      >
                        <div className="mb-1 flex items-baseline justify-between">
                          <span className="mr-2 text-sm font-semibold text-text-primary">{msg.author.username}</span>
                          <span className="text-xs text-text-muted">{new Date(msg.created_at || msg.timestamp || '').toLocaleString()}</span>
                        </div>
                        <div className="text-[15px] text-text-secondary">{msg.content || <span className="italic text-text-muted">(attachment)</span>}</div>
                      </button>
                    ))}
                  </div>
                ) : searchQuery.trim() ? (
                  searchError ? (
                    <div className="p-8 text-center text-accent-danger">{searchError}</div>
                  ) : (
                    <div className="p-8 text-center text-text-muted">No results found</div>
                  )
                ) : (
                  <div className="p-8 text-center text-text-muted">Search for messages, users, or keywords</div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Pins overlay */}
      <AnimatePresence>
        {showPins && (
          <div
            className="fixed inset-0 z-50 flex items-start justify-center px-2 pb-[calc(var(--safe-bottom)+0.75rem)] pt-[calc(var(--safe-top)+3.75rem)] sm:px-4 sm:pt-20"
            style={{ backgroundColor: 'var(--overlay-backdrop)' }}
            onClick={() => setShowPins(false)}
          >
            <motion.div
              ref={pinsDialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="topbar-pins-title"
              tabIndex={-1}
              initial={{ opacity: 0, scale: 0.95, y: -20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: -20 }}
              transition={{ duration: 0.18 }}
              className="glass-modal max-h-[min(82dvh,40rem)] w-full max-w-xl overflow-hidden rounded-xl border sm:rounded-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="panel-divider flex items-center justify-between border-b px-5 py-4.5">
                <div id="topbar-pins-title" className="font-bold text-text-primary">Pinned Messages</div>
                <button className="command-icon-btn" onClick={() => setShowPins(false)} aria-label="Close pinned messages"><X size={16} /></button>
              </div>
              <div className="max-h-[min(67dvh,31rem)] space-y-4 overflow-y-auto bg-bg-primary p-4 sm:p-5 scrollbar-thin">
                {pins.map((msg) => (
                  <div key={msg.id} className="rounded-xl border border-border-subtle bg-bg-mod-subtle p-3.5">
                    <div className="mb-2 flex items-center gap-2">
                      <div className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-bg-tertiary text-[10px] text-text-muted">
                        {msg.author.avatar ? <img src={msg.author.avatar} alt="" className="h-full w-full object-cover" /> : msg.author.username[0]}
                      </div>
                      <span className="text-sm font-semibold text-text-primary">{msg.author.username}</span>
                      <span className="ml-auto text-xs text-text-muted">{new Date(msg.created_at || msg.timestamp || '').toLocaleDateString()}</span>
                    </div>
                    <div className="mb-2 text-sm text-text-primary">{msg.content || '(attachment only)'}</div>
                    {channelId && (
                      <button
                        className="inline-flex h-9 items-center rounded-lg border border-transparent px-3 text-sm font-semibold text-accent-danger transition-colors hover:border-accent-danger/35 hover:bg-accent-danger/12"
                        onClick={async () => {
                          await unpinMessage(channelId, msg.id);
                          const { data } = await channelApi.getPins(channelId);
                          setPins(data);
                        }}
                      >
                        Unpin this message
                      </button>
                    )}
                  </div>
                ))}
                {pins.length === 0 && (
                  <div className="py-8 text-center text-text-muted">
                    <Pin size={48} className="mx-auto mb-4 opacity-20" />
                    No pinned messages in this channel yet.
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Inbox overlay */}
      <AnimatePresence>
        {showInbox && (
          <div
            className="fixed inset-0 z-50 flex items-start justify-center px-2 pb-[calc(var(--safe-bottom)+0.75rem)] pt-[calc(var(--safe-top)+3.75rem)] sm:px-4 sm:pt-20"
            style={{ backgroundColor: 'var(--overlay-backdrop)' }}
            onClick={() => setShowInbox(false)}
          >
            <motion.div
              ref={inboxDialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="topbar-inbox-title"
              tabIndex={-1}
              initial={{ opacity: 0, scale: 0.95, y: -20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: -20 }}
              transition={{ duration: 0.18 }}
              className="glass-modal max-h-[min(82dvh,40rem)] w-full max-w-xl overflow-hidden rounded-xl border sm:rounded-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="panel-divider flex items-center justify-between border-b px-5 py-4.5">
                <div id="topbar-inbox-title" className="font-bold text-text-primary">Inbox</div>
                <button className="command-icon-btn" onClick={() => setShowInbox(false)} aria-label="Close inbox"><X size={16} /></button>
              </div>
              <div className="max-h-[min(67dvh,31rem)] overflow-y-auto bg-bg-primary p-0 scrollbar-thin">
                {unreadItems.length > 0 ? (
                  unreadItems.map(({ state, channelName: unreadChannelName }) => {
                    const channel = allChannels.find((c) => c.id === state.channel_id);
                    return (
                      <button
                        key={state.channel_id}
                        className="flex w-full flex-col border-b border-border-subtle p-4.5 text-left transition-colors hover:bg-bg-mod-subtle"
                        onClick={() => {
                          setShowInbox(false);
                          if (channel?.guild_id) {
                            navigate(`/app/guilds/${channel.guild_id}/channels/${state.channel_id}`);
                          } else {
                            navigate(`/app/dms/${state.channel_id}`);
                          }
                        }}
                      >
                        <div className="mb-1 flex items-center justify-between">
                          <span className="text-sm font-semibold text-text-primary">#{unreadChannelName}</span>
                          <span className="h-2 w-2 rounded-full bg-accent-primary"></span>
                        </div>
                        <div className="text-sm text-text-muted">Unread messages</div>
                      </button>
                    );
                  })
                ) : (
                  <div className="px-8 py-12 text-center text-text-muted">
                    <Inbox size={48} className="mx-auto mb-4 opacity-20" />
                    You're all caught up! No unread messages.
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Help/shortcuts overlay */}
      <AnimatePresence>
        {showHelp && (
          <div
            className="fixed inset-0 z-50 flex items-start justify-center px-2 pb-[calc(var(--safe-bottom)+0.75rem)] pt-[calc(var(--safe-top)+3.75rem)] sm:px-4 sm:pt-20"
            style={{ backgroundColor: 'var(--overlay-backdrop)' }}
            onClick={() => setShowHelp(false)}
          >
            <motion.div
              ref={helpDialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="topbar-help-title"
              tabIndex={-1}
              initial={{ opacity: 0, scale: 0.95, y: -20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: -20 }}
              transition={{ duration: 0.18 }}
              className="glass-modal max-h-[min(82dvh,32rem)] w-full max-w-md overflow-hidden rounded-xl sm:rounded-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="panel-divider flex items-center justify-between border-b px-5 py-4.5">
                <div id="topbar-help-title" className="font-bold text-text-primary">Keyboard Shortcuts</div>
                <button className="command-icon-btn" onClick={() => setShowHelp(false)} aria-label="Close keyboard shortcuts"><X size={16} /></button>
              </div>
              <div className="space-y-4 p-5">
                {[
                  { label: 'Command Palette', keys: ['Ctrl', 'K'] },
                  { label: 'Search in Channel', keys: ['Ctrl', 'F'] },
                  { label: 'Send Message', keys: ['Enter'] },
                  { label: 'New Line', keys: ['Shift', 'Enter'] },
                  { label: 'Close Modal', keys: ['Esc'] },
                ].map((item) => (
                  <div key={item.label} className="flex items-center justify-between">
                    <span className="text-sm text-text-secondary">{item.label}</span>
                    <div className="flex gap-1.5">
                      {item.keys.map((k) => (
                        <kbd key={k} className="min-w-[28px] rounded border border-border-subtle bg-bg-mod-subtle px-2 py-1 text-center font-mono text-sm text-text-muted">{k}</kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
