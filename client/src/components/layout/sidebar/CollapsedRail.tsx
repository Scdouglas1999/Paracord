import { Home, MessageSquare, Plus, Search } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../../../lib/utils';
import { IconButton } from '../../ui';
import { LitAvatar } from '../../light';
import { guildInitials, resolveGuildIconUrl } from '../../../lib/guildIcon';
import type { BuildingLight, PersonLight } from '../../../lib/attention/light';

/**
 * The collapsed 64px rail (docs/layout-spec.md §6; Ctrl+B toggles it).
 *
 * Navigation has to survive the collapse, so the buildings stay — as their
 * marks, each carrying the brightest window it has lit. The window dot is the
 * same light the expanded column draws, and it keeps its words in the button's
 * accessible name, so a collapsed rail is still readable without color (§9).
 *
 * Desktop only: on a phone the column is a full overlay or nothing (§6).
 */

export interface CollapsedRailProps {
  buildings: readonly BuildingLight[];
  activeBuildingKey?: string | null;
  account: PersonLight;
  onOpenSearch: () => void;
  onOpenHome: () => void;
  onOpenMessages: () => void;
  onOpenLobby: (building: BuildingLight) => void;
  onAddBuilding: () => void;
  onOpenSettings: () => void;
  homeActive?: boolean;
  messagesActive?: boolean;
  /** The call dock, while you are in a room. */
  footer?: ReactNode;
}

function BuildingMark({
  building,
  active,
  onOpen,
  tabStop,
  navIndex,
}: {
  building: BuildingLight;
  active: boolean;
  onOpen: (building: BuildingLight) => void;
  tabStop: boolean;
  navIndex: number;
}) {
  const iconSrc = resolveGuildIconUrl({ icon: building.icon });
  const level = building.roomsLit > 0 ? 'on' : building.readingCount > 0 ? 'warm' : 'dark';
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      aria-label={`${building.name} — ${building.caption}`}
      title={building.name}
      data-nav-index={navIndex}
      tabIndex={tabStop ? 0 : -1}
      onClick={() => onOpen(building)}
      className={cn(
        'pc-focusable relative flex h-11 w-11 shrink-0 items-center justify-center overflow-visible',
        'rounded-[var(--radius-card)] text-meta font-semibold',
        'transition-[background-color,color] duration-[var(--duration-fast)] ease-[var(--ease-out)]',
        active
          ? 'bg-bg-raised text-text-primary shadow-[var(--shadow-raised)]'
          : 'bg-bg-plate text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary',
      )}
    >
      <span className="pc-display flex h-full w-full items-center justify-center overflow-hidden rounded-[var(--radius-card)]">
        {iconSrc ? (
          <img src={iconSrc} alt="" className="h-full w-full object-cover" />
        ) : (
          guildInitials(building.name)
        )}
      </span>
      {level !== 'dark' && (
        <span
          aria-hidden
          className={cn('pc-window absolute -right-0.5 -top-0.5', level === 'on' ? 'is-talking' : 'is-reading')}
          style={{ width: 8, height: 8 }}
        />
      )}
    </button>
  );
}

export function CollapsedRail({
  buildings,
  activeBuildingKey = null,
  account,
  onOpenSearch,
  onOpenHome,
  onOpenMessages,
  onOpenLobby,
  onAddBuilding,
  onOpenSettings,
  homeActive = false,
  messagesActive = false,
  footer,
}: CollapsedRailProps) {
  const activeIndex = Math.max(
    0,
    buildings.findIndex((building) => building.key === activeBuildingKey),
  );

  return (
    <div className="flex h-full w-16 flex-col items-center gap-2 py-2">
      <IconButton label="Search — open command palette" size="md" tone="raised" onClick={onOpenSearch}>
        <Search size={16} aria-hidden />
      </IconButton>
      <IconButton label="Home" size="md" active={homeActive} onClick={onOpenHome}>
        <Home size={16} aria-hidden />
      </IconButton>
      <IconButton label="Messages" size="md" active={messagesActive} onClick={onOpenMessages}>
        <MessageSquare size={16} aria-hidden />
      </IconButton>

      <div
        data-roving-container=""
        role="listbox"
        aria-label="Servers"
        aria-orientation="vertical"
        className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto scrollbar-none"
      >
        {buildings.map((building, index) => (
          <BuildingMark
            key={building.key}
            building={building}
            active={building.key === activeBuildingKey}
            onOpen={onOpenLobby}
            navIndex={index}
            tabStop={index === activeIndex}
          />
        ))}
      </div>

      <IconButton label="Add a server" size="md" onClick={onAddBuilding}>
        <Plus size={16} aria-hidden />
      </IconButton>

      <div className="mt-auto flex flex-col items-center gap-2">
        {footer}
        <button
          type="button"
          aria-label={`${account.name} — ${account.label}. Open user settings`}
          onClick={onOpenSettings}
          className="pc-focusable rounded-full"
        >
          <LitAvatar person={account} size={32} hideLabel />
        </button>
      </div>
    </div>
  );
}
