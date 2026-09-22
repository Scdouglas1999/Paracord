import type { MouseEvent } from 'react';
import { Trophy } from 'lucide-react';
import { Chip, NavRow } from '../ui';
import { sportsHref } from './model';

export function SportsSidebarRow({
  guildId,
  liveCount,
  active,
  tabStop,
  onOpen,
}: {
  guildId: string;
  liveCount: number;
  active: boolean;
  tabStop: boolean;
  onOpen?: (guildId: string) => void;
}) {
  const href = sportsHref(guildId);
  const onClick = (event: MouseEvent<HTMLElement>) => {
    if (!onOpen) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    onOpen(guildId);
  };

  return (
    <NavRow
      href={href}
      role="option"
      aria-selected={active}
      active={active}
      tabIndex={tabStop ? 0 : -1}
      data-nav-index={`sports-${guildId}`}
      icon={<Trophy size={16} />}
      onClick={onClick}
      trailing={
        liveCount > 0 ? (
          <Chip size="sm" aria-label={`${liveCount} live`}>
            <span className="pc-live-dot pc-sports-live" aria-hidden />
            {liveCount} live
          </Chip>
        ) : null
      }
    >
      Sports
    </NavRow>
  );
}
