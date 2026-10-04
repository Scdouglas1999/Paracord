import { useMemo, type MouseEvent as ReactMouseEvent } from 'react';

import type { PersonLight } from '../../../lib/attention/light';
import { AvatarStack } from '../../ix/identity';
import { IxGlyph } from '../../ix/glyphs';
import { CreamButton, ToolChip } from '../../ix/primitives';
import { presenceLine } from './homeCaptions';

export interface ServerBarProps {
  /** Everyone the server can see, online first. The pile shows the online ones. */
  people: readonly PersonLight[];
  online: number;
  members: number;
  muted: boolean;
  /** Opens the people sheet (the same one as the toolbar's members control). */
  onMembers: () => void;
  /** Opens the notification menu at the chip. */
  onNotificationMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  onEvents: () => void;
  onMedia: () => void;
  /** Null when there is no channel to invite anyone into. */
  onInvite: (() => void) | null;
  /** Null unless the viewer may manage the server. */
  onSettings: (() => void) | null;
}

/** How many faces the pile shows before the count takes over. */
const PILE = 5;

/**
 * The row under the Overview's title (docs/index-spec.md §8.1): who is here, and
 * what you can do from the server's front page. The names and the topic are the
 * large title and its subtitle; the mark, the menu and the rest of the header live
 * in the sidebar.
 *
 * Invite is the one cream button; the rest are quiet chips with words on them, not
 * icons that need guessing.
 */
export function ServerBar({
  people,
  online,
  members,
  muted,
  onMembers,
  onNotificationMenu,
  onEvents,
  onMedia,
  onInvite,
  onSettings,
}: ServerBarProps) {
  const pile = useMemo(
    () =>
      people
        .filter((person) => person.level === 'on')
        .slice(0, PILE)
        .map((person) => ({ userId: person.userId, name: person.name, avatar: person.avatar })),
    [people],
  );
  const line = presenceLine(online, members);

  return (
    <div className="ix-bar" data-testid="ix-overview-bar">
      <button type="button" className="ix-bar__members" aria-label={`${line}. Show members`} onClick={onMembers}>
        {pile.length > 0 && <AvatarStack people={pile} size={24} overlap={7} ring="var(--ix-main)" />}
        <span className="ix-bar__line">{line}</span>
      </button>

      <div className="ix-bar__actions" role="group" aria-label="Server actions">
        {onInvite && (
          <CreamButton size="sm" onClick={onInvite}>
            <IxGlyph name="invite" size={14} />
            Invite people
          </CreamButton>
        )}
        <ToolChip onClick={onEvents}>
          <IxGlyph name="event" size={14} />
          Events
        </ToolChip>
        <ToolChip onClick={onMedia}>
          <IxGlyph name="attach" size={14} />
          Media
        </ToolChip>
        <ToolChip
          aria-haspopup="menu"
          aria-label={muted ? 'Notifications: muted' : 'Notifications'}
          onClick={onNotificationMenu}
        >
          {muted ? 'Muted' : 'Notifications'}
        </ToolChip>
        {onSettings && <ToolChip onClick={onSettings}>Server settings</ToolChip>}
      </div>
    </div>
  );
}
