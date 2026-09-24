import type { MouseEvent } from 'react';
import { Grid3x3 } from 'lucide-react';
import { NavRow } from '../ui';
import { dailyWordHref } from './model';

/** "Daily word" under a server's plate, while the add-on is on. */
export function DailyWordSidebarRow({
  guildId,
  active,
  tabStop,
  onOpen,
}: {
  guildId: string;
  active: boolean;
  tabStop: boolean;
  onOpen?: (guildId: string) => void;
}) {
  const onClick = (event: MouseEvent<HTMLElement>) => {
    if (!onOpen) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    onOpen(guildId);
  };

  return (
    <NavRow
      href={dailyWordHref(guildId)}
      role="option"
      aria-selected={active}
      active={active}
      tabIndex={tabStop ? 0 : -1}
      data-nav-index={`daily-word-${guildId}`}
      icon={<Grid3x3 size={16} />}
      onClick={onClick}
    >
      Daily word
    </NavRow>
  );
}
