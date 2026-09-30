import { useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { Bell, BellOff, CheckCheck, Image as ImageIcon, Settings, UserPlus } from 'lucide-react';

import { PageRow, PagePerson } from '../../home/PageRow';
import { Face } from '../../glass/places/Lead';
import { PersonFaceTooltip, usePresenceStatusLine, StatusLineText } from '../../user/PresenceActivity';
import { Button, IconButton, Popover } from '../../ui';
import type { ContextMenuItem } from '../../ui/ContextMenu';
import { getIdentityColor } from '../../../lib/colors';
import { guildInitials } from '../../../lib/guildIcon';
import { useAuthenticatedImage } from '../../../lib/authenticatedImage';
import { presenceLabel } from '../../../lib/presence';
import type { PersonLight } from '../../../lib/attention/light';
import { cn } from '../../../lib/utils';
import { presenceLine } from './homeCaptions';

export interface ServerHeadProps {
  guildId: string;
  name: string;
  description: string | null;
  iconSrc: string | null;
  /** Everyone the server can see, online first. The pile shows the online ones. */
  people: readonly PersonLight[];
  online: number;
  members: number;
  muted: boolean;
  /** A phone: a smaller mark and title. */
  phone: boolean;
  /** Opens the notification menu at the bell. */
  onNotificationMenu: (event: ReactMouseEvent<HTMLElement>, items: ContextMenuItem[]) => void;
  onToggleMute: () => void;
  onMarkRead: () => void;
  onMedia: () => void;
  /** Null when there is no channel to invite anyone into. */
  onInvite: (() => void) | null;
  /** Null unless the viewer may manage the server. */
  onSettings: (() => void) | null;
}

/** How many faces the pile shows before the count takes over. */
const PILE = 6;

/**
 * The head of a server's Overview (docs/glass-spec.md §2.3, §3.1): the mark, the
 * name at the server-title size (28/600, narrow), who is online, the server's own
 * description, and what you can do from here. It sits over the banner's fade, so
 * the banner is what lights it.
 *
 * Utilities are icon-only circles (notifications, media, settings); Invite keeps
 * its label, because it is a verb. None of them is the cream button: that is Join,
 * on a live room.
 */
export function ServerHead({
  guildId,
  name,
  description,
  iconSrc,
  people,
  online,
  members,
  muted,
  phone,
  onNotificationMenu,
  onToggleMute,
  onMarkRead,
  onMedia,
  onInvite,
  onSettings,
}: ServerHeadProps) {
  const icon = useAuthenticatedImage(iconSrc);
  const onlinePeople = useMemo(() => people.filter((person) => person.level === 'on'), [people]);
  const size = phone ? 56 : 72;

  const bellItems: ContextMenuItem[] = [
    {
      label: muted ? 'Unmute server' : 'Mute server',
      description: muted ? 'Notifications from this server come back.' : 'No notifications from this server.',
      icon: muted ? <Bell size={16} /> : <BellOff size={16} />,
      action: onToggleMute,
    },
    { label: 'Mark as read', icon: <CheckCheck size={16} />, action: onMarkRead },
  ];

  return (
    <header className="glass-ov__head" data-compact={phone ? '' : undefined}>
      <span
        aria-hidden
        className="glass-ov__mark"
        style={
          {
            width: size,
            height: size,
            fontSize: size * 0.36,
            background: icon ? 'var(--bub)' : getIdentityColor(guildId),
          } as CSSProperties
        }
      >
        {icon ? <img src={icon} alt="" draggable={false} /> : guildInitials(name)}
      </span>

      <div className="glass-ov__id">
        <h1 className="glass-title-server glass-ov__name">{name}</h1>
        <MembersButton people={people} onlinePeople={onlinePeople} online={online} members={members} />
      </div>

      <div className="glass-ov__actions">
        <IconButton
          label={muted ? 'Notifications: muted' : 'Notifications'}
          tone="raised"
          active={muted}
          onClick={(event) => onNotificationMenu(event, bellItems)}
        >
          {muted ? <BellOff size={18} aria-hidden /> : <Bell size={18} aria-hidden />}
        </IconButton>
        <IconButton label="Media" tone="raised" onClick={onMedia}>
          <ImageIcon size={18} aria-hidden />
        </IconButton>
        {onSettings && (
          <IconButton label="Server settings" tone="raised" onClick={onSettings}>
            <Settings size={18} aria-hidden />
          </IconButton>
        )}
        {onInvite && (
          <Button variant="glass" onClick={onInvite}>
            <UserPlus size={16} aria-hidden />
            Invite
          </Button>
        )}
      </div>

      {description && (
        <p className="glass-ov__about glass-clamp" style={{ '--clamp-lines': phone ? 3 : 2 } as CSSProperties}>
          {description}
        </p>
      )}
    </header>
  );
}

/**
 * The face pile and "8 online · 10 members". It opens a panel listing
 * everybody, online first.
 */
function MembersButton({
  people,
  onlinePeople,
  online,
  members,
}: {
  people: readonly PersonLight[];
  onlinePeople: readonly PersonLight[];
  online: number;
  members: number;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const line = presenceLine(online, members);
  const pile = onlinePeople.slice(0, PILE);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${line}. Show members`}
        className="glass-ov__members glass-focusable"
      >
        {pile.length > 0 && (
          <span className="glass-ov__pile" aria-hidden>
            {pile.map((person, index) => (
              <PersonFaceTooltip key={person.userId} userId={person.userId} name={person.name} fallback={person.label}>
                <span className="glass-ov__pile-face" style={index === 0 ? undefined : { marginInlineStart: -6 }}>
                  <Face face={{ userId: person.userId, name: person.name, avatar: person.avatar }} size={26} />
                </span>
              </PersonFaceTooltip>
            ))}
          </span>
        )}
        <span className="glass-ov__members-line">{line}</span>
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label="Members" className="glass-ov__popover">
        <div className="glass-ov__popover-head">
          <span className="glass-name">Members</span>
          <span className="glass-instrument glass-ov__popover-count">{line}</span>
        </div>
        <ul className="glass-ov__popover-list">
          {people.map((person) => (
            <MemberRow key={person.userId} person={person} />
          ))}
        </ul>
      </Popover>
    </>
  );
}

function MemberRow({ person }: { person: PersonLight }) {
  const statusLine = usePresenceStatusLine(person.userId);
  return (
    <PageRow
      className={cn('glass-ov__member')}
      lead={
        <PagePerson
          face={{ userId: person.userId, name: person.name, avatar: person.avatar }}
          size={32}
          status={person.level === 'off' ? 'offline' : person.dnd ? 'dnd' : person.dim ? 'idle' : 'online'}
          live={person.live}
        />
      }
      title={person.name}
      line={
        statusLine ? (
          <StatusLineText line={statusLine} />
        ) : (
          <>
            {presenceLabel(person.level === 'off' ? 'offline' : person.dnd ? 'dnd' : person.dim ? 'idle' : 'online')}
            {person.roomName ? ` · ${person.roomName}` : ''}
          </>
        )
      }
      offline={person.level === 'off'}
    />
  );
}
