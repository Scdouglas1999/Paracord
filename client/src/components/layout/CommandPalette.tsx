import { activateChannel } from '../../lib/channelNavigation';
import { guildLandingPath } from '../../lib/guildNavigation';
import { entityScopeKey } from '../../lib/serverScope';
import { useAvailableChannels } from '../../hooks/useChannels';
import { activateGuild } from '../../lib/guildNavigation';
import { useAvailableGuilds, useSelectedGuildId } from '../../hooks/useGuilds';
import { useCurrentAccountScope, useCurrentUser } from '../../hooks/useCurrentUser';
import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams } from 'react-router';
import { Settings, Shield, Bot, UserPlus, Users, MessagesSquare, MessageSquarePlus } from 'lucide-react';
import { Kbd } from '../ui/Kbd';
import { DmPickerModal } from '../message/DmPickerModal';
import { useUIStore } from '../../stores/uiStore';
import { useGuildStore } from '../../stores/guildStore';
import { useChannelStore } from '../../stores/channelStore';
import { useMemberStore } from '../../stores/memberStore';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useMobile } from '../../hooks/useMobile';
import { canAccessGuildSettingsSync } from '../../lib/guildSettingsAccess';
import { isAdmin } from '../../types';
import { cn } from '../../lib/utils';
import { displayName } from '../../lib/displayName';
import { IxGlyph } from '../ix/glyphs';
import { Avatar, ServerMark } from '../ix/identity';
import { openProfileCard, type ProfileSubject } from '../ix/menus/hostStore';
import { MENU_EXIT_MS, useExitPresence } from '../ix/sheets/useExitPresence';
import { openSearchWith } from '../glass/sheets/sheetStore';
import { arrangeSwitcher, searchRowLabel, type SwitcherCandidate } from './switcherModel';

/**
 * The quick switcher (docs/index-spec.md §4.2, §6.3; Ctrl K / ⌘K and the sidebar's
 * search field): a near-solid panel 420 wide, radius 16, anchored over the
 * sidebar's top where the search field is (full screen on a phone). It is scoped
 * to the current server first (its channels, rooms and people), then the other
 * servers and direct messages; commands (New message, Add a friend, Settings, ...)
 * are listed after the places, only when what is typed matches them; and the last
 * row, always, is "Search messages in <server> for ..." which opens the message
 * search sheet with the words carried over. Typing filters, arrows move, Enter
 * opens, Esc closes. The ordering lives in `switcherModel.ts`.
 *
 * It is a dialog named "Quick switcher": the shared focus trap owns Tab and
 * Escape and puts focus back on what had it.
 */

interface PaletteItem extends SwitcherCandidate {
  icon: ReactNode;
  action: () => void;
  /** A person: choosing the row opens their profile card beside the panel instead of running `action`. */
  profile?: ProfileSubject;
}

/** Where the panel sits: over the sidebar's search field, else the sidebar's top. */
function panelAnchor(): { left: number; top: number } {
  if (typeof document === 'undefined') return { left: 12, top: 14 };
  const field = document.querySelector<HTMLElement>('[data-testid="ix-search-field"]');
  const rect = field?.getBoundingClientRect();
  if (rect && rect.width > 0) return { left: Math.max(8, rect.left), top: Math.max(8, rect.top - 7) };
  const side = document.querySelector<HTMLElement>('[data-testid="ix-sidebar"]')?.getBoundingClientRect();
  return { left: Math.max(8, (side?.left ?? 0) + 12), top: 14 };
}

export function CommandPalette() {
  const open = useUIStore((s) => s.commandPaletteOpen);
  const setOpen = useUIStore((s) => s.setCommandPaletteOpen);
  const guilds = useAvailableGuilds();
  const channelsByGuild = useChannelStore((s) => s.channelsByGuild);
  const availableChannels = useAvailableChannels();
  const selectGuild = useGuildStore((s) => s.selectGuild);
  const user = useCurrentUser();
  const scope = useCurrentAccountScope();
  const navigate = useNavigate();
  const { guildId: routeGuildId, channelId: routeChannelId } = useParams();
  const selectedGuildId = useSelectedGuildId();
  // The server the switcher is scoped to: the route's, else the one selected.
  const scopeGuildId = routeGuildId ?? selectedGuildId ?? null;
  const members = useMemberStore((s) => (scope && scopeGuildId ? s.members.get(entityScopeKey(scope, scopeGuildId)) : undefined));
  const phone = useMobile();

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dmPickerOpen, setDmPickerOpen] = useState(false);
  const [anchor, setAnchor] = useState(() => panelAnchor());
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const { mounted, exiting } = useExitPresence(open, MENU_EXIT_MS);

  const handleClose = useCallback(() => {
    setOpen(false);
    const returnTarget = returnFocusRef.current;
    if (returnTarget && document.contains(returnTarget)) {
      requestAnimationFrame(() => returnTarget.focus());
    }
  }, [setOpen]);

  // Reset state on open, and measure where the sidebar's search field is.
  useLayoutEffect(() => {
    if (open && !wasOpenRef.current) {
      if (document.activeElement instanceof HTMLElement && !panelRef.current?.contains(document.activeElement)) {
        returnFocusRef.current = document.activeElement;
      }
      setQuery('');
      setSelectedIndex(0);
      setAnchor(panelAnchor());
    }
    wasOpenRef.current = open;
  }, [open]);

  useFocusTrap(panelRef, open, handleClose);

  const searchGuild = useMemo(() => guilds.find((guild) => guild.id === scopeGuildId) ?? null, [guilds, scopeGuildId]);
  // Message search needs a conversation or a server on the page to search.
  const canSearchMessages = Boolean(routeGuildId || routeChannelId);

  // Everything the switcher can go to or do.
  const candidates = useMemo((): PaletteItem[] => {
    const items: PaletteItem[] = [];

    guilds.forEach((guild) => {
      const key = entityScopeKey(guild.scope, guild.id);
      const guildChannels = channelsByGuild[key] || [];
      const current = guild.id === scopeGuildId;
      const markOf = <ServerMark guildId={guild.id} name={guild.name} icon={guild.icon_hash ?? guild.icon ?? null} hue={guild.hue ?? null} size={24} />;

      guildChannels.forEach((channel) => {
        if (channel.type === 4) return; // Skip categories
        const type = channel.type ?? channel.channel_type;
        const isRoom = type === 2 || type === 13;
        const here = () => {
          activateGuild(guild);
          activateChannel(channel);
          navigate(`/app/guilds/${guild.id}/channels/${channel.id}`);
        };
        if (current) {
          items.push({
            id: `${isRoom ? 'room' : 'channel'}-${guild.key}-${channel.id}`,
            category: isRoom ? 'rooms' : 'channels',
            label: channel.name || 'unknown',
            sublabel: isRoom ? 'Room' : undefined,
            icon: <IxGlyph name={isRoom ? (type === 13 ? 'stage' : 'speaker') : 'hello'} size={16} />,
            action: here,
            keywords: `${channel.name} ${guild.name} ${isRoom ? 'room voice' : 'channel text'}`,
          });
        } else if (!isRoom) {
          items.push({
            id: `elsewhere-${guild.key}-${channel.id}`,
            category: 'elsewhere',
            label: channel.name || 'unknown',
            sublabel: guild.name,
            icon: <IxGlyph name="hello" size={16} />,
            action: here,
            keywords: `${channel.name} ${guild.name} channel`,
          });
        }
      });

      // Server settings: only when the viewer can open them (not instance admin).
      if (canAccessGuildSettingsSync(guild.id, guild.scope)) {
        items.push({
          id: `guild-settings-${guild.id}`,
          category: 'commands',
          label: 'Server settings',
          sublabel: guild.name,
          icon: <Settings size={16} strokeWidth={1.7} />,
          action: () => { activateGuild(guild); useUIStore.getState().setGuildSettingsId(guild.id); },
          keywords: `${guild.name} server settings admin manage`,
        });
      }

      if (!current) {
        items.push({
          id: `guild-${guild.key}`,
          category: 'servers',
          label: guild.name,
          sublabel: `${guildChannels.filter((c) => c.type !== 4).length} channels`,
          icon: markOf,
          action: async () => {
            navigate(await guildLandingPath(guild));
          },
          keywords: `${guild.name} server community`,
        });
      }
    });

    // The people of the current server (found by typing).
    (members ?? []).forEach((member) => {
      const name = displayName(member.user, member.nick);
      items.push({
        id: `person-${member.user.id}`,
        category: 'people',
        label: name,
        sublabel: member.user.username !== name ? `@${member.user.username}` : undefined,
        icon: <Avatar userId={member.user.id} name={name} avatar={member.user.avatar_hash ?? member.user.avatar ?? null} size={24} />,
        action: () => undefined,
        profile: member.user,
        keywords: `${member.user.username} ${member.user.display_name ?? ''} ${member.nick ?? ''} person member`,
      });
    });

    availableChannels.filter((channel) => !channel.guild_id).forEach((dm) => {
      const serverId = dm.scope.serverId;
      const recipientName = dm.recipient ? displayName(dm.recipient) : (dm.name || 'Direct message');
      items.push({
        id: `dm-${serverId}-${dm.id}`,
        category: 'dms',
        label: recipientName,
        sublabel: dm.recipient ? undefined : 'Group',
        icon: dm.recipient
          ? <Avatar userId={dm.recipient.id} name={recipientName} avatar={dm.recipient.avatar_hash ?? null} size={24} />
          : <IxGlyph name="people" size={16} />,
        action: () => {
          activateChannel(dm);
          selectGuild(null);
          navigate(`/app/dms/${dm.id}`);
        },
        keywords: `${recipientName} dm direct message`,
      });
    });

    // Commands: listed after the places, and only when the typed words match them.
    const command = (id: string, label: string, sublabel: string, icon: ReactNode, action: () => void, keywords: string) =>
      items.push({ id, category: 'commands', label, sublabel, icon, action, keywords });

    command('action-new-message', 'New message', 'Start a direct or group message', <MessageSquarePlus size={16} strokeWidth={1.7} />,
      () => setDmPickerOpen(true), 'new message dm direct compose start conversation group');
    command('action-add-friend', 'Add a friend', 'Send a friend request', <UserPlus size={16} strokeWidth={1.7} />,
      () => navigate('/app/friends'), 'add friend request invite people');
    command('action-all-conversations', 'All conversations', 'Open your direct messages', <MessagesSquare size={16} strokeWidth={1.7} />,
      () => navigate('/app/dms'), 'all conversations direct messages dms inbox people');
    command('action-friends', 'Friends', 'Online, pending, and blocked', <Users size={16} strokeWidth={1.7} />,
      () => navigate('/app/friends'), 'friends online pending requests blocked');
    command('nav-settings', 'User settings', 'Account, appearance, notifications', <Settings size={16} strokeWidth={1.7} />,
      () => useUIStore.getState().setUserSettingsOpen(true), 'settings preferences account profile');
    command('nav-developers', 'Developer portal', 'Bot applications and API access', <Bot size={16} strokeWidth={1.7} />,
      () => navigate('/app/developers'), 'developer portal bots applications api');
    if (user && isAdmin(user.flags)) {
      command('nav-admin', 'Admin dashboard', 'Instance administration', <Shield size={16} strokeWidth={1.7} />,
        () => navigate('/app/admin'), 'admin dashboard administration server instance');
    }

    return items;
  }, [guilds, channelsByGuild, availableChannels, members, user, navigate, selectGuild, scopeGuildId]);

  const groups = useMemo(() => arrangeSwitcher(candidates, query), [candidates, query]);

  // The last row: search the messages, with the words carried over.
  const searchItem = useMemo((): PaletteItem | null => {
    if (!canSearchMessages) return null;
    return {
      id: 'search-messages',
      category: 'commands',
      label: searchRowLabel(searchGuild?.name ?? null, query),
      icon: <IxGlyph name="search" size={16} />,
      action: () => openSearchWith(query),
    };
  }, [canSearchMessages, searchGuild, query]);

  // Flat list for keyboard navigation: the groups in order, then the search row.
  const flatItems = useMemo(
    () => [...groups.flatMap((g) => g.items), ...(searchItem ? [searchItem] : [])],
    [groups, searchItem],
  );

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
    if (selected && typeof selected.scrollIntoView === 'function') {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const handleSelect = useCallback((item: PaletteItem) => {
    // A person's card opens at the panel's top left (over the sidebar), measured before it closes.
    const rect = panelRef.current?.getBoundingClientRect();
    const corner = { x: rect?.left ?? 0, y: rect?.top ?? 0 };
    handleClose();
    // Run after the switcher closes so what the choice opens takes focus.
    requestAnimationFrame(() => {
      if (item.profile) openProfileCard(item.profile, corner);
      else item.action();
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
  const activeItem = flatItems[selectedIndex];
  const renderRow = (item: PaletteItem) => {
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
        className="ix-switcher__row"
      >
        <span className="ix-switcher__icon">{item.icon}</span>
        <span className="ix-switcher__label">{item.label}</span>
        {item.sublabel && <span className="ix-switcher__sub">{item.sublabel}</span>}
        {isSelected && <Kbd aria-hidden>↵</Kbd>}
      </button>
    );
  };

  const style = phone
    ? undefined
    : ({ left: anchor.left, top: anchor.top } as CSSProperties);

  return (
    <>
      {mounted && typeof document !== 'undefined' && createPortal(
        <div
          className={cn('ix-switcher-scrim', exiting && 'is-leaving')}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) handleClose();
          }}
        >
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Quick switcher"
            tabIndex={-1}
            data-testid="ix-switcher"
            data-native-overlay-occlude=""
            className={cn('ix-switcher', exiting ? 'is-leaving' : 'is-entering')}
            data-layout={phone ? 'phone' : 'popover'}
            style={style}
            onKeyDown={handleKeyDown}
            {...(exiting ? { 'aria-hidden': true as const, inert: true as const } : null)}
          >
            <div className="ix-switcher__field">
              <IxGlyph name="search" size={16} />
              <input
                ref={inputRef}
                autoFocus
                role="combobox"
                aria-expanded="true"
                aria-autocomplete="list"
                aria-controls="command-palette-list"
                aria-activedescendant={activeItem ? `command-item-${activeItem.id}` : undefined}
                aria-label="Search the quick switcher"
                autoComplete="off"
                spellCheck={false}
                className="ix-switcher__input"
                placeholder={searchGuild ? 'Jump to a channel, room or person' : 'Jump to a conversation or server'}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSelectedIndex(0);
                }}
              />
              <Kbd>Esc</Kbd>
            </div>

            <div
              ref={listRef}
              id="command-palette-list"
              role="listbox"
              aria-label="Quick switcher results"
              className="ix-switcher__list"
            >
              {groups.map((group) => (
                <div key={group.category} role="group" aria-label={group.label} className="ix-switcher__group">
                  <div className="ix-switcher__label-row" role="presentation">{group.label}</div>
                  {group.items.map(renderRow)}
                </div>
              ))}
              {groups.length === 0 && query.trim() !== '' && (
                <div className="ix-switcher__none">
                  <div className="ix-switcher__none-title">Nothing matches “{query.trim()}”</div>
                  <p>Try a channel, a person, a server or a command.</p>
                </div>
              )}
            </div>

            {searchItem && (
              <div className="ix-switcher__foot" role="presentation">
                {renderRow(searchItem)}
              </div>
            )}
            <div className="sr-only" role="status" aria-live="polite">
              {flatItems.length} result{flatItems.length === 1 ? '' : 's'}
            </div>
          </div>
        </div>,
        document.body,
      )}
      {/* "New message" opens the shared DM picker directly (layout-spec §2). */}
      <DmPickerModal open={dmPickerOpen} onClose={() => setDmPickerOpen(false)} />
    </>
  );
}
