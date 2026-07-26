import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Bell,
  ChevronDown,
  Hash,
  LayoutGrid,
  MessageSquare,
  Radio,
  Search,
  Volume2,
} from 'lucide-react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { buildChannelGroups } from '../../lib/features/channelGroups';
import { cn } from '../../lib/utils';
import { ChannelType, type Channel } from '../../types';

interface ChannelSwitcherProps {
  guildId: string;
  guildName?: string;
  channelId?: string;
  channelName: string;
  channelType?: number;
  channels: Channel[];
}

function isDestination(channel: Channel): boolean {
  const type = channel.type ?? channel.channel_type;
  return (
    type === ChannelType.Text ||
    type === ChannelType.Announcement ||
    type === ChannelType.Forum ||
    type === ChannelType.Voice ||
    type === ChannelType.Stage
  );
}

function iconForType(type: number | undefined) {
  if (type === ChannelType.Voice) return Volume2;
  if (type === ChannelType.Stage) return Radio;
  if (type === ChannelType.Forum) return MessageSquare;
  if (type === ChannelType.Announcement) return Bell;
  return Hash;
}

/**
 * Lightweight room movement from chat. Rooms remains the canonical space map;
 * this popover is the fast local switcher for people already in a conversation.
 */
export function ChannelSwitcher({
  guildId,
  guildName,
  channelId,
  channelName,
  channelType,
  channels,
}: ChannelSwitcherProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return buildChannelGroups(channels.filter(isDestination))
      .map((group) => ({
        ...group,
        channels: group.channels.filter((channel) => {
          if (!needle) return true;
          return (
            channel.name?.toLowerCase().includes(needle) ||
            channel.topic?.toLowerCase().includes(needle)
          );
        }),
      }))
      .filter((group) => group.channels.length > 0);
  }, [channels, query]);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setQuery('');
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const closeFromTrap = useCallback(() => close(true), [close]);

  // Modal Escape + Tab trap so shell keyboard nav doesn't close the ContextPanel
  // behind an orphan room menu when focus has left the popover.
  useFocusTrap(menuRef, open, closeFromTrap);

  // Route / selection changes should dismiss the local switcher.
  useEffect(() => {
    close();
  }, [channelId, guildId, close]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open, close]);

  const moveFocus = (direction: 1 | -1, toEdge?: 'start' | 'end') => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[data-room-destination]') ?? [],
    );
    if (items.length === 0) return;
    if (toEdge) {
      items[toEdge === 'start' ? 0 : items.length - 1]?.focus();
      return;
    }
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = index < 0 ? (direction > 0 ? 0 : items.length - 1) : index + direction;
    items[Math.max(0, Math.min(items.length - 1, next))]?.focus();
  };

  const CurrentIcon = iconForType(channelType);

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Switch room, current: ${channelName}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex h-8 min-w-0 max-w-[15rem] items-center gap-1.5 rounded-sm px-1.5 text-left outline-none',
          'text-text-primary transition-colors duration-[140ms] ease-[var(--ease-out)]',
          'hover:bg-bg-mod-subtle focus-visible:shadow-[var(--focus-ring)]',
          open && 'bg-bg-mod-subtle',
        )}
      >
        <CurrentIcon size={18} className="shrink-0 text-channel-icon" aria-hidden />
        <span className="truncate text-[15px] font-semibold">{channelName}</span>
        <ChevronDown
          size={14}
          aria-hidden
          className={cn(
            'shrink-0 text-text-muted transition-transform duration-[140ms] ease-[var(--ease-out)]',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="dialog"
          aria-modal="true"
          tabIndex={-1}
          aria-label={`Switch room in ${guildName || 'this space'}`}
          className="absolute left-0 top-[calc(100%+0.5rem)] z-50 w-[min(20rem,calc(100vw-4rem))] overflow-hidden rounded-md border border-border-subtle bg-bg-floating shadow-lg"
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              moveFocus(1);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              moveFocus(-1);
            } else if (event.key === 'Home' && event.target !== searchRef.current) {
              event.preventDefault();
              moveFocus(1, 'start');
            } else if (event.key === 'End' && event.target !== searchRef.current) {
              event.preventDefault();
              moveFocus(1, 'end');
            }
          }}
        >
          <div className="border-b border-border-subtle p-2">
            <label className="flex h-9 items-center gap-2 rounded-sm border border-border-subtle bg-bg-tertiary px-2.5 focus-within:border-accent-primary focus-within:shadow-[var(--focus-ring-input)]">
              <Search size={15} className="shrink-0 text-text-muted" aria-hidden />
              <span className="sr-only">Find a room</span>
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Find a room"
                className="min-w-0 flex-1 bg-transparent text-label text-text-primary outline-none placeholder:text-text-muted"
              />
            </label>
          </div>

          <div className="max-h-[min(25rem,65dvh)] overflow-y-auto p-1.5 scrollbar-thin">
            <button
              type="button"
              data-room-destination=""
              onClick={() => {
                navigate(`/app/guilds/${guildId}`);
                close();
              }}
              className="flex h-9 w-full items-center gap-2 rounded-sm px-2 text-left text-label font-medium text-text-secondary outline-none transition-colors hover:bg-bg-mod-subtle hover:text-text-primary focus:bg-accent-tint focus:text-text-primary"
            >
              <LayoutGrid size={17} className="shrink-0 text-channel-icon" aria-hidden />
              <span className="flex-1 truncate">Rooms home</span>
            </button>

            {groups.length === 0 ? (
              <p className="px-2 py-5 text-center text-label text-text-muted">
                No matching rooms.
              </p>
            ) : (
              groups.map((group) => (
                <div key={group.id} className="mt-1 border-t border-border-subtle pt-1">
                  <p className="px-2 py-1 text-section uppercase text-text-muted">{group.name}</p>
                  {group.channels.map((channel) => {
                    const type = channel.type ?? channel.channel_type;
                    const Icon = iconForType(type);
                    const active = channel.id === channelId;
                    return (
                      <button
                        key={channel.id}
                        type="button"
                        data-room-destination=""
                        aria-current={active ? 'page' : undefined}
                        onClick={() => {
                          navigate(`/app/guilds/${guildId}/channels/${channel.id}`);
                          close();
                        }}
                        className={cn(
                          'relative flex h-9 w-full items-center gap-2 rounded-sm px-2 text-left outline-none transition-colors',
                          active
                            ? 'bg-accent-tint text-text-primary'
                            : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary focus:bg-accent-tint focus:text-text-primary',
                        )}
                      >
                        {active && (
                          <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-accent-secondary" aria-hidden />
                        )}
                        <Icon
                          size={17}
                          className={active ? 'text-accent-primary' : 'text-channel-icon'}
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1 truncate text-label font-medium">
                          {channel.name || 'unknown'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
