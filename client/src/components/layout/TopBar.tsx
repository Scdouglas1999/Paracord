import { useEffect, useMemo, useState } from 'react';
import { Hash, Search, Pin, Users, Inbox, HelpCircle, Volume2, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { useNavigate, useParams } from 'react-router-dom';
import { channelApi } from '../../api/channels';
import { authApi } from '../../api/auth';
import { useUIStore } from '../../stores/uiStore';
import { useChannelStore } from '../../stores/channelStore';
import { useMessageStore } from '../../stores/messageStore';
import type { Message, ReadState } from '../../types';
import { Tooltip } from '../ui/Tooltip';
import { cn } from '../../lib/utils';

interface TopBarProps {
  channelName?: string;
  channelTopic?: string;
  isVoice?: boolean;
  isDM?: boolean;
  recipientName?: string;
}

export function TopBar({ channelName, channelTopic, isVoice, isDM, recipientName }: TopBarProps) {
  const { channelId } = useParams();
  const navigate = useNavigate();
  const toggleMemberSidebar = useUIStore((s) => s.toggleMemberSidebar);
  const toggleMemberPanel = useUIStore((s) => s.toggleMemberPanel);
  const memberSidebarOpen = useUIStore((s) => s.memberSidebarOpen);
  const memberPanelOpen = useUIStore((s) => s.memberPanelOpen);
  const setCommandPaletteOpen = useUIStore((s) => s.setCommandPaletteOpen);
  const unpinMessage = useMessageStore((s) => s.unpinMessage);
  const channelsByGuild = useChannelStore((s) => s.channelsByGuild);

  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Message[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [showPins, setShowPins] = useState(false);
  const [pins, setPins] = useState<Message[]>([]);
  const [showInbox, setShowInbox] = useState(false);
  const [readStates, setReadStates] = useState<ReadState[]>([]);
  const [showHelp, setShowHelp] = useState(false);
  const [mutedGuildIds, setMutedGuildIds] = useState<string[]>([]);

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
            'relative flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-all hover:bg-bg-mod-subtle hover:text-text-primary',
            active && 'bg-bg-mod-subtle text-text-primary',
            disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-text-muted'
          )}
        >
          <Icon size={16} />
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
    <div className="z-10 flex h-[var(--spacing-header-height)] w-full shrink-0 items-center justify-between border-b border-border-subtle/50 bg-gradient-to-r from-transparent to-transparent px-3 md:px-5">
      {/* Left: channel info */}
      <div className="mr-3 flex min-w-0 flex-1 items-center overflow-hidden">
        {isDM ? (
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-primary/80 text-xs font-semibold text-white md:h-10 md:w-10">
              {recipientName?.charAt(0).toUpperCase() || '?'}
            </div>
            <div className="min-w-0">
              <span className="block truncate text-[15px] font-semibold text-text-primary">
                {recipientName || 'Direct Message'}
              </span>
            </div>
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            {isVoice ? (
              <Volume2 size={16} className="shrink-0 text-accent-primary/70" />
            ) : (
              <Hash size={16} className="shrink-0 text-text-muted" />
            )}
            <span className="truncate text-[15px] font-semibold text-text-primary">
              {channelName || 'channel'}
            </span>
            {channelTopic && (
              <>
                <div className="mx-2 hidden h-4 w-px shrink-0 bg-border-subtle/80 md:block" />
                <span className="hidden max-w-md truncate text-[13px] text-text-muted md:block">{channelTopic}</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* Right: action buttons */}
      <div className="flex shrink-0 items-center gap-1">
        <TopBarIcon
          icon={Search}
          onClick={() => setShowSearch(true)}
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
            onClick={() => { toggleMemberSidebar(); toggleMemberPanel(); }}
            active={memberSidebarOpen || memberPanelOpen}
            tooltip="Member List"
          />
        )}
        <TopBarIcon className="hidden sm:block" icon={Inbox} onClick={() => void openInbox()} tooltip="Inbox" />
        <TopBarIcon className="hidden md:block" icon={HelpCircle} onClick={() => setShowHelp(true)} tooltip="Shortcuts" />
      </div>

      {/* Search overlay */}
      <AnimatePresence>
        {showSearch && (
          <div
            className="fixed inset-0 z-50 flex items-start justify-center pt-20"
            style={{ backgroundColor: 'var(--overlay-backdrop)' }}
            onClick={() => setShowSearch(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: -20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: -20 }}
              transition={{ duration: 0.18 }}
              className="glass-modal w-full max-w-3xl overflow-hidden rounded-2xl border"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="panel-divider flex items-center gap-3 border-b px-5 py-4.5">
                <Search size={20} className="text-text-muted" />
                <input
                  autoFocus
                  className="flex-1 bg-transparent text-lg text-text-primary outline-none placeholder:text-text-muted"
                  placeholder={channelId ? `Search in #${channelName || 'channel'}` : 'Search messages'}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                <button className="command-icon-btn" onClick={() => setShowSearch(false)}><X size={16} /></button>
              </div>
              <div className="max-h-[500px] overflow-y-auto p-3.5 scrollbar-thin">
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
            className="fixed inset-0 z-50 flex items-start justify-center pt-20"
            style={{ backgroundColor: 'var(--overlay-backdrop)' }}
            onClick={() => setShowPins(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: -20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: -20 }}
              transition={{ duration: 0.18 }}
              className="glass-modal w-full max-w-xl overflow-hidden rounded-2xl border"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="panel-divider flex items-center justify-between border-b px-5 py-4.5">
                <div className="font-bold text-text-primary">Pinned Messages</div>
                <button className="command-icon-btn" onClick={() => setShowPins(false)}><X size={16} /></button>
              </div>
              <div className="max-h-[500px] space-y-4 overflow-y-auto bg-bg-primary p-5 scrollbar-thin">
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
            className="fixed inset-0 z-50 flex items-start justify-center pt-20"
            style={{ backgroundColor: 'var(--overlay-backdrop)' }}
            onClick={() => setShowInbox(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: -20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: -20 }}
              transition={{ duration: 0.18 }}
              className="glass-modal w-full max-w-xl overflow-hidden rounded-2xl border"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="panel-divider flex items-center justify-between border-b px-5 py-4.5">
                <div className="font-bold text-text-primary">Inbox</div>
                <button className="command-icon-btn" onClick={() => setShowInbox(false)}><X size={16} /></button>
              </div>
              <div className="max-h-[500px] overflow-y-auto bg-bg-primary p-0 scrollbar-thin">
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
            className="fixed inset-0 z-50 flex items-start justify-center pt-20"
            style={{ backgroundColor: 'var(--overlay-backdrop)' }}
            onClick={() => setShowHelp(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: -20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: -20 }}
              transition={{ duration: 0.18 }}
              className="glass-modal w-full max-w-md overflow-hidden rounded-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="panel-divider flex items-center justify-between border-b px-5 py-4.5">
                <div className="font-bold text-text-primary">Keyboard Shortcuts</div>
                <button className="command-icon-btn" onClick={() => setShowHelp(false)}><X size={16} /></button>
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
