import * as React from 'react';
import { Settings, UserPlus } from 'lucide-react';

import { Button, IconButton } from '../../ui';
import { getIdentityColor } from '../../../lib/colors';
import { guildInitials } from '../../../lib/guildIcon';
import { cn } from '../../../lib/utils';

export interface LobbyHeaderProps {
  guildId: string;
  name: string;
  /** Resolved guild icon, or null for the initials mark. */
  iconSrc?: string | null;
  /** "24 of 61 have their lights on · 2 rooms lit · thermal test at 1 pm". */
  summary: string;
  /**
   * What the building's operator wrote about it (`hub_settings.welcome_text`).
   * When they wrote one it IS the secondary sentence: a building gets one line,
   * and the person who runs it outranks the generated one. The generated line
   * stays in the accessibility tree so §9's text equivalent for the light does
   * not go with it.
   */
  welcome?: string | null;
  /** Invite is offered only when there is a room to invite somebody into. */
  onInvite?: () => void;
  /** Space settings — permission-gated by the caller. */
  onSettings?: () => void;
}

/**
 * The Lobby's header (docs/lantern-stage-spec.md §7.3): the building mark, its
 * name in Gabarito, one line of facts, and the two things you can do from the
 * street — let somebody in, or change the building.
 *
 * The summary line is the §9 text equivalent for everything the window maps and
 * lit cards below say in light: how many people are here, how many rooms are
 * lit, what is coming up. When the operator has written a welcome line, that
 * line is shown instead and the summary moves into the accessibility tree — the
 * words are still there, the band is still one line deep.
 */
export const LobbyHeader = React.forwardRef<HTMLElement, LobbyHeaderProps>(function LobbyHeader(
  { guildId, name, iconSrc, summary, welcome, onInvite, onSettings },
  ref,
) {
  const written = welcome?.trim() ?? '';
  return (
    <header ref={ref} className="flex flex-wrap items-end gap-x-4 gap-y-3">
      <span
        aria-hidden
        className={cn(
          'pc-display flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden',
          'rounded-[var(--radius-card)] text-name font-bold text-text-on-light',
        )}
        style={{ background: iconSrc ? undefined : getIdentityColor(guildId) }}
      >
        {iconSrc ? (
          <img src={iconSrc} alt="" className="h-full w-full object-cover" draggable={false} />
        ) : (
          guildInitials(name)
        )}
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* A phone gets the whole name on two lines rather than an ellipsis;
            a desktop row truncates so the header stays one band deep. */}
        <h1 className="pc-display text-display break-words text-text-primary sm:truncate">
          {name}
        </h1>
        {written ? (
          <>
            <p className="truncate text-meta text-text-body">{written}</p>
            <p className="sr-only">{summary}</p>
          </>
        ) : (
          <p className="truncate text-meta text-text-faint">{summary}</p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {onInvite && (
          <Button variant="ghost" size="md" onClick={onInvite} aria-label="Invite people">
            <UserPlus size={16} aria-hidden />
            <span className="hidden sm:inline" aria-hidden>
              Invite
            </span>
          </Button>
        )}
        {onSettings && (
          <IconButton label="Space settings" onClick={onSettings}>
            <Settings size={18} aria-hidden />
          </IconButton>
        )}
      </div>
    </header>
  );
});
