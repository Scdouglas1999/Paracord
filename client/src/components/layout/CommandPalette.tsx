import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Hash, Volume2, Settings, Home, Shield, MessageCircle, ArrowRight } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { useUIStore } from '../../stores/uiStore';
import { useGuildStore } from '../../stores/guildStore';
import { useChannelStore } from '../../stores/channelStore';
import { useAuthStore } from '../../stores/authStore';
import { isAdmin } from '../../types';
import { cn } from '../../lib/utils';
import type { Channel, Guild } from '../../types';

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
  const selectGuild = useGuildStore((s) => s.selectGuild);
  const selectChannel = useChannelStore((s) => s.selectChannel);
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset state on open
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      // Focus input after animation
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [open]);

  // Build palette items from all available navigation targets
  const allItems = useMemo((): PaletteItem[] => {
    const items: PaletteItem[] = [];

    // Navigation items
    items.push({
      id: 'nav-home',
      label: 'Go to Home',
      sublabel: 'Friends & Direct Messages',
      icon: <Home size={16} />,
      action: () => {
        selectGuild(null);
        useChannelStore.getState().selectGuild(null);
        navigate('/app/friends');
      },
      category: 'Navigation',
      keywords: 'home friends dm direct message',
    });

    items.push({
      id: 'nav-settings',
      label: 'User Settings',
      sublabel: 'Account, appearance, notifications',
      icon: <Settings size={16} />,
      action: () => navigate('/app/settings'),
      category: 'Navigation',
      keywords: 'settings preferences account profile',
    });

    if (user && isAdmin(user.flags)) {
      items.push({
        id: 'nav-admin',
        label: 'Admin Dashboard',
        sublabel: 'Server administration',
        icon: <Shield size={16} />,
        action: () => navigate('/app/admin'),
        category: 'Navigation',
        keywords: 'admin dashboard administration server',
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

    // DM channels
    dmChannels.forEach((dm: Channel) => {
      const recipientName = dm.recipient?.username || 'Direct Message';
      items.push({
        id: `dm-${dm.id}`,
        label: recipientName,
        sublabel: 'Direct Message',
        icon: <MessageCircle size={16} />,
        action: () => {
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
  }, [guilds, channelsByGuild, dmChannels, user, navigate, selectGuild, selectChannel]);

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
    const categoryOrder = ['Navigation', 'Channels', 'Spaces', 'Direct Messages'];
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

  const handleClose = useCallback(() => {
    setOpen(false);
  }, [setOpen]);

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
        setOpen(!open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, setOpen]);

  let flatIndex = 0;

  return (
    <AnimatePresence>
      {open && (
        <div
          className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh]"
          style={{ backgroundColor: 'var(--overlay-backdrop)' }}
          onClick={handleClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: -12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -12 }}
            transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
            className="glass-modal w-full max-w-[560px] overflow-hidden rounded-2xl border border-border-strong/50"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleKeyDown}
          >
            {/* Search input */}
            <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-3">
              <Search size={18} className="shrink-0 text-text-muted" />
              <input
                ref={inputRef}
                autoFocus
                className="flex-1 bg-transparent text-[15px] text-text-primary outline-none placeholder:text-text-muted"
                placeholder="Where would you like to go?"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSelectedIndex(0);
                }}
              />
              <kbd className="flex items-center gap-0.5 rounded border border-border-subtle bg-bg-mod-subtle px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
                ESC
              </kbd>
            </div>

            {/* Results */}
            <div ref={listRef} className="max-h-[400px] overflow-y-auto p-2 scrollbar-thin">
              {groupedItems.length > 0 ? (
                groupedItems.map((group) => (
                  <div key={group.category} className="mb-1">
                    <div className="px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-widest text-text-muted">
                      {group.category}
                    </div>
                    {group.items.map((item) => {
                      const currentIndex = flatIndex++;
                      const isSelected = currentIndex === selectedIndex;
                      return (
                        <button
                          key={item.id}
                          data-index={currentIndex}
                          onClick={() => handleSelect(item)}
                          onMouseEnter={() => setSelectedIndex(currentIndex)}
                          className={cn(
                            'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors',
                            isSelected
                              ? 'bg-accent-primary/12 text-text-primary'
                              : 'text-text-secondary hover:bg-bg-mod-subtle'
                          )}
                        >
                          <div className={cn(
                            'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors',
                            isSelected ? 'bg-accent-primary/20 text-accent-primary' : 'bg-bg-mod-subtle text-text-muted'
                          )}>
                            {item.icon}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[13px] font-semibold">{item.label}</div>
                            {item.sublabel && (
                              <div className="truncate text-[11px] text-text-muted">{item.sublabel}</div>
                            )}
                          </div>
                          {isSelected && (
                            <ArrowRight size={14} className="shrink-0 text-accent-primary" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))
              ) : (
                <div className="flex flex-col items-center justify-center px-4 py-10">
                  <Search size={32} className="mb-3 text-text-muted/40" />
                  <div className="text-sm font-medium text-text-muted">No results found</div>
                  <div className="mt-1 text-xs text-text-muted/70">Try a different search term</div>
                </div>
              )}
            </div>

            {/* Footer hints */}
            <div className="flex items-center justify-between border-t border-border-subtle/60 px-4 py-2">
              <div className="flex items-center gap-3 text-[10px] text-text-muted">
                <span className="flex items-center gap-1">
                  <kbd className="rounded border border-border-subtle/60 bg-bg-mod-subtle/60 px-1 py-0.5 font-mono text-[9px]">&uarr;</kbd>
                  <kbd className="rounded border border-border-subtle/60 bg-bg-mod-subtle/60 px-1 py-0.5 font-mono text-[9px]">&darr;</kbd>
                  navigate
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="rounded border border-border-subtle/60 bg-bg-mod-subtle/60 px-1 py-0.5 font-mono text-[9px]">&crarr;</kbd>
                  select
                </span>
              </div>
              <div className="text-[10px] text-text-muted">
                {flatItems.length} result{flatItems.length !== 1 ? 's' : ''}
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
