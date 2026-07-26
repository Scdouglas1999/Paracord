import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { Search, Hash, Volume2, Settings, Home, Shield, MessageCircle, ArrowRight, Bot, UserPlus, Users, MessagesSquare, MessageSquarePlus } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { DmPickerModal } from '../message/DmPickerModal';
import { useUIStore } from '../../stores/uiStore';
import { useGuildStore } from '../../stores/guildStore';
import { useChannelStore } from '../../stores/channelStore';
import { useAuthStore } from '../../stores/authStore';
import { useServerListStore } from '../../stores/serverListStore';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { LOCAL_SERVER_ID } from '../../lib/connectionManager';
import { canAccessGuildSettingsSync } from '../../lib/guildSettingsAccess';
import { isAdmin } from '../../types';
import { cn } from '../../lib/utils';
import type { Channel, Guild } from '../../types';
import { displayName } from '../../lib/displayName';

interface PaletteItem {
  id: string;
  label: string;
  sublabel?: string;
  icon: React.ReactNode;
  action: () => void;
  category: string;
  keywords?: string;
}

const EMPTY_CHANNELS: Channel[] = [];

export function CommandPalette() {
  const open = useUIStore((s) => s.commandPaletteOpen);
  const setOpen = useUIStore((s) => s.setCommandPaletteOpen);
  const guilds = useGuildStore((s) => s.guilds);
  const channelsByGuild = useChannelStore((s) => s.channelsByGuild);
  const dmChannels = useChannelStore((s) => s.channelsByGuild[''] ?? EMPTY_CHANNELS);
  const dmChannelsByServer = useChannelStore((s) => s.dmChannelsByServer);
  const activeServerId = useServerListStore((s) => s.activeServerId);
  const selectGuild = useGuildStore((s) => s.selectGuild);
  const selectChannel = useChannelStore((s) => s.selectChannel);
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dmPickerOpen, setDmPickerOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  const handleClose = useCallback(() => {
    setOpen(false);
    const returnTarget = returnFocusRef.current;
    if (returnTarget && document.contains(returnTarget)) {
      requestAnimationFrame(() => returnTarget.focus());
    }
  }, [setOpen]);

  // Reset state on open
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      if (document.activeElement instanceof HTMLElement && !panelRef.current?.contains(document.activeElement)) {
        returnFocusRef.current = document.activeElement;
      }
      if (query !== '') setQuery('');
      if (selectedIndex !== 0) setSelectedIndex(0);
    }
    wasOpenRef.current = open;
  }, [open, query, selectedIndex]);

  useFocusTrap(panelRef, open, handleClose);

  // Build palette items from all available navigation targets
  const allItems = useMemo((): PaletteItem[] => {
    const items: PaletteItem[] = [];

    // Social action commands — everything social reachable from ⌘K (do not
    // duplicate the "Friends" destination with the Home nav item below, which now
    // lands on the App Home rather than the friends page).
    items.push({
      id: 'action-new-message',
      label: 'New message',
      sublabel: 'Start a direct or group DM',
      icon: <MessageSquarePlus size={16} />,
      action: () => setDmPickerOpen(true),
      category: 'Actions',
      keywords: 'new message dm direct compose start conversation group',
    });

    items.push({
      id: 'action-add-friend',
      label: 'Add a friend',
      sublabel: 'Send a friend request',
      icon: <UserPlus size={16} />,
      action: () => navigate('/app/friends'),
      category: 'Actions',
      keywords: 'add friend request invite people',
    });

    items.push({
      id: 'action-all-conversations',
      label: 'All conversations',
      sublabel: 'Open your direct messages',
      icon: <MessagesSquare size={16} />,
      action: () => navigate('/app/dms'),
      category: 'Actions',
      keywords: 'all conversations direct messages dms inbox',
    });

    items.push({
      id: 'action-friends',
      label: 'Friends',
      sublabel: 'Online, pending, and blocked',
      icon: <Users size={16} />,
      action: () => navigate('/app/friends'),
      category: 'Actions',
      keywords: 'friends online pending requests blocked',
    });

    // Navigation items
    items.push({
      id: 'nav-home',
      label: 'Go to Home',
      sublabel: 'Calls, friends around, and recent DMs',
      icon: <Home size={16} />,
      action: () => {
        selectGuild(null);
        useChannelStore.getState().selectGuild(null);
        navigate('/app');
      },
      category: 'Navigation',
      keywords: 'home overview happening now',
    });

    items.push({
      id: 'nav-settings',
      label: 'User Settings',
      sublabel: 'Account, appearance, notifications',
      icon: <Settings size={16} />,
      action: () => useUIStore.getState().setUserSettingsOpen(true),
      category: 'Navigation',
      keywords: 'settings preferences account profile',
    });

    items.push({
      id: 'nav-developers',
      label: 'Developer Portal',
      sublabel: 'Bot applications and API access',
      icon: <Bot size={16} />,
      action: () => navigate('/app/developers'),
      category: 'Navigation',
      keywords: 'developer portal bots applications api',
    });

    if (user && isAdmin(user.flags)) {
      items.push({
        id: 'nav-admin',
        label: 'Admin Dashboard',
        sublabel: 'Instance administration',
        icon: <Shield size={16} />,
        action: () => navigate('/app/admin'),
        category: 'Navigation',
        keywords: 'admin dashboard administration server instance',
      });
    }

    // Guild channels
    guilds.forEach((guild: Guild) => {
      const guildChannels = channelsByGuild[guild.id] || [];
      guildChannels.forEach((channel: Channel) => {
        if (channel.type === 4) return; // Skip categories

        const isVoice = channel.type === 2 || channel.channel_type === 2;
        items.push({
          id: `channel-${guild.id}-${channel.id}`,
          label: channel.name || 'unknown',
          sublabel: guild.name,
          icon: isVoice ? <Volume2 size={16} /> : <Hash size={16} />,
          action: () => {
            selectGuild(guild.id);
            useChannelStore.getState().selectGuild(guild.id);
            selectChannel(channel.id);
            navigate(`/app/guilds/${guild.id}/channels/${channel.id}`);
          },
          category: 'Channels',
          keywords: `${channel.name} ${guild.name} channel ${isVoice ? 'voice' : 'text'}`,
        });
      });

      // Space settings — only when the viewer can open them (not instance admin).
      if (canAccessGuildSettingsSync(guild.id)) {
        items.push({
          id: `guild-settings-${guild.id}`,
          label: 'Space settings',
          sublabel: guild.name,
          icon: <Settings size={16} />,
          action: () => useUIStore.getState().setGuildSettingsId(guild.id),
          category: 'Navigation',
          keywords: `${guild.name} space settings server settings admin manage`,
        });
      }

      // Guild itself (navigate to first channel)
      items.push({
        id: `guild-${guild.id}`,
        label: guild.name,
        sublabel: `${(guildChannels.filter(c => c.type !== 4)).length} channels`,
        icon: (
          <div className="flex h-5 w-5 items-center justify-center rounded bg-accent-primary/20 text-[9px] font-bold text-accent-primary">
            {guild.name.charAt(0).toUpperCase()}
          </div>
        ),
        action: async () => {
          selectGuild(guild.id);
          await useChannelStore.getState().selectGuild(guild.id);
          await useChannelStore.getState().fetchChannels(guild.id);
          const channels = useChannelStore.getState().channelsByGuild[guild.id] || [];
          const firstChannel = channels.find(c => c.type === 0) || channels.find(c => c.type !== 4) || channels[0];
          if (firstChannel) {
            selectChannel(firstChannel.id);
            navigate(`/app/guilds/${guild.id}/channels/${firstChannel.id}`);
          }
        },
        category: 'Spaces',
        keywords: `${guild.name} server space`,
      });
    });

    // DM channels — merged across EVERY connected server (mirrors the unified
    // sidebar's dmChannelsByServer), deduped by channel id, with the active
    // server's '' mirror seeding the list for back-compat. Without this, ⌘K
    // could only reach DMs on the active server even though background-server
    // DMs are clickable in the sidebar.
    const dmById = new Map<string, { channel: Channel; serverId: string }>();
    const activeId = activeServerId ?? LOCAL_SERVER_ID;
    for (const dm of dmChannels) {
      if (!dmById.has(dm.id)) dmById.set(dm.id, { channel: dm, serverId: activeId });
    }
    for (const [serverId, list] of Object.entries(dmChannelsByServer)) {
      for (const dm of list) {
        if (!dmById.has(dm.id)) dmById.set(dm.id, { channel: dm, serverId });
      }
    }
    dmById.forEach(({ channel: dm, serverId }) => {
      const recipientName = dm.recipient ? displayName(dm.recipient) : 'Direct Message';
      items.push({
        id: `dm-${serverId}-${dm.id}`,
        label: recipientName,
        sublabel: 'Direct Message',
        icon: <MessageCircle size={16} />,
        action: () => {
          if (useServerListStore.getState().activeServerId !== serverId) {
            useServerListStore.getState().setActive(serverId);
          }
          selectGuild(null);
          useChannelStore.getState().selectGuild(null);
          selectChannel(dm.id);
          navigate(`/app/dms/${dm.id}`);
        },
        category: 'Direct Messages',
        keywords: `${recipientName} dm direct message`,
      });
    });

    return items;
  }, [guilds, channelsByGuild, dmChannels, dmChannelsByServer, activeServerId, user, navigate, selectGuild, selectChannel, setDmPickerOpen]);

  // Filter items based on query
  const filteredItems = useMemo(() => {
    if (!query.trim()) return allItems;
    const q = query.toLowerCase().trim();
    return allItems.filter((item) => {
      const searchText = `${item.label} ${item.sublabel || ''} ${item.keywords || ''}`.toLowerCase();
      return searchText.includes(q);
    });
  }, [allItems, query]);

  // Group filtered items by category
  const groupedItems = useMemo(() => {
    const groups: { category: string; items: PaletteItem[] }[] = [];
    const categoryOrder = ['Actions', 'Navigation', 'Channels', 'Spaces', 'Direct Messages'];
    const categoryMap = new Map<string, PaletteItem[]>();

    filteredItems.forEach((item) => {
      if (!categoryMap.has(item.category)) {
        categoryMap.set(item.category, []);
      }
      categoryMap.get(item.category)!.push(item);
    });

    categoryOrder.forEach((cat) => {
      const items = categoryMap.get(cat);
      if (items && items.length > 0) {
        groups.push({ category: cat, items });
      }
    });

    return groups;
  }, [filteredItems]);

  // Flat list for keyboard navigation
  const flatItems = useMemo(() => groupedItems.flatMap((g) => g.items), [groupedItems]);

  // Clamp selected index
  useEffect(() => {
    if (selectedIndex >= flatItems.length) {
      setSelectedIndex(Math.max(0, flatItems.length - 1));
    }
  }, [flatItems.length, selectedIndex]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.querySelector(`[data-index="${selectedIndex}"]`);
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const handleSelect = useCallback((item: PaletteItem) => {
    handleClose();
    // Use requestAnimationFrame to run navigation after the palette closes
    requestAnimationFrame(() => {
      item.action();
    });
  }, [handleClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, flatItems.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (flatItems[selectedIndex]) {
          handleSelect(flatItems[selectedIndex]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        handleClose();
        break;
    }
  }, [flatItems, selectedIndex, handleSelect, handleClose]);

  // Global keyboard shortcut
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (!open && document.activeElement instanceof HTMLElement) {
          returnFocusRef.current = document.activeElement;
        }
        setOpen(!open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, setOpen]);

  let flatIndex = 0;
  const activeItemId = flatItems[selectedIndex]?.id;

  return (
    <>
    <Modal
      open={open}
      onClose={handleClose}
      panelRef={panelRef}
      manageFocus={false}
      onKeyDown={handleKeyDown}
      labelledBy="command-palette-title"
      placement="top"
      size="md"
      panelClassName="border-border-strong"
    >
      <h2 id="command-palette-title" className="sr-only">Command Palette</h2>
      {/* Search input — top inset, on the deeper tertiary surface */}
      <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-3.5">
        <Search size={18} className="shrink-0 text-text-muted" />
        <input
          ref={inputRef}
          autoFocus
          aria-controls="command-palette-list"
          aria-activedescendant={activeItemId ? `command-item-${activeItemId}` : undefined}
          aria-label="Search command palette"
          className="flex-1 bg-transparent px-1 py-0.5 text-body text-text-primary outline-none placeholder:text-text-muted"
          placeholder="Jump to a channel, space, or setting…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedIndex(0);
          }}
        />
        <kbd className="rounded-xs bg-bg-mod-strong px-1.5 py-0.5 font-code text-meta font-semibold text-text-muted">
          ESC
        </kbd>
      </div>

      {/* Results */}
      <div
        ref={listRef}
        id="command-palette-list"
        role="listbox"
        aria-label="Command palette results"
        className="max-h-[420px] overflow-y-auto p-2 scrollbar-thin"
      >
        {groupedItems.length > 0 ? (
          groupedItems.map((group) => (
            <div key={group.category} className="mb-1.5 last:mb-0">
              <div className="px-3 pb-1 pt-3 text-section uppercase text-text-muted first:pt-1">
                {group.category}
              </div>
              {group.items.map((item) => {
                const currentIndex = flatIndex++;
                const isSelected = currentIndex === selectedIndex;
                return (
                  <button
                    key={item.id}
                    id={`command-item-${item.id}`}
                    role="option"
                    aria-selected={isSelected}
                    data-index={currentIndex}
                    tabIndex={-1}
                    onClick={() => handleSelect(item)}
                    onMouseEnter={() => setSelectedIndex(currentIndex)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-sm px-3 py-2.5 text-left transition-colors duration-[140ms] ease-[var(--ease-out)]',
                      isSelected
                        ? 'bg-accent-tint text-text-primary'
                        : 'text-text-secondary hover:bg-bg-mod-subtle'
                    )}
                  >
                    <span className={cn(
                      'flex h-5 w-5 shrink-0 items-center justify-center transition-colors',
                      isSelected ? 'text-accent-primary' : 'text-text-muted'
                    )}>
                      {item.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-label font-semibold">{item.label}</span>
                      {item.sublabel && (
                        <span className="block truncate text-meta text-text-muted">{item.sublabel}</span>
                      )}
                    </span>
                    {isSelected ? (
                      <kbd className="shrink-0 rounded-xs bg-bg-mod-strong px-1.5 py-0.5 font-code text-meta tabular-nums text-text-secondary">
                        ↵
                      </kbd>
                    ) : (
                      <ArrowRight size={14} className="shrink-0 text-text-muted opacity-0" aria-hidden />
                    )}
                  </button>
                );
              })}
            </div>
          ))
        ) : (
          <div className="px-3 py-8">
            <div className="text-label font-semibold text-text-primary">
              Nothing matches “{query.trim()}”
            </div>
            <p className="mt-1 text-meta text-text-secondary">
              Try a command name, a channel, or a space you belong to.
            </p>
          </div>
        )}
      </div>

      {/* Footer hints */}
      <div className="flex items-center justify-between border-t border-border-subtle px-4 py-2">
        <div className="flex items-center gap-3 text-meta text-text-muted">
          <span className="flex items-center gap-1">
            <kbd className="rounded-xs bg-bg-mod-strong px-1 py-0.5 font-code text-[10px] text-text-secondary">&uarr;</kbd>
            <kbd className="rounded-xs bg-bg-mod-strong px-1 py-0.5 font-code text-[10px] text-text-secondary">&darr;</kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded-xs bg-bg-mod-strong px-1 py-0.5 font-code text-[10px] text-text-secondary">&crarr;</kbd>
            select
          </span>
        </div>
        <div className="font-code text-meta tabular-nums text-text-muted">
          {flatItems.length} result{flatItems.length !== 1 ? 's' : ''}
        </div>
      </div>
    </Modal>
    {/* "New message" opens the shared DM picker directly — reusing the extracted
        DmPickerModal rather than a bespoke ⌘K flow (layout-spec §2). */}
    <DmPickerModal open={dmPickerOpen} onClose={() => setDmPickerOpen(false)} />
    </>
  );
}
