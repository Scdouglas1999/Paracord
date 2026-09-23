import { useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Bell, BellOff, CheckCheck, Image as ImageIcon, Settings, UserPlus } from 'lucide-react';

import { AvatarStack, LitAvatar } from '../../light';
import { Button, IconButton, Popover } from '../../ui';
import type { ContextMenuItem } from '../../ui/ContextMenu';
import { getIdentityColor } from '../../../lib/colors';
import { guildInitials } from '../../../lib/guildIcon';
import { useAuthenticatedImage } from '../../../lib/authenticatedImage';
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
 * The head of the server home page: the mark across the cover's edge, the
 * name, the server's own description, who is online, and the four things you
 * can do from here.
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
  const size = phone ? 64 : 76;

  const bellItems: ContextMenuItem[] = [
    {
      label: muted ? 'Unmute server' : 'Mute server',
      description: muted ? 'Notifications from this server come back.' : 'No notifications from this server.',
      icon: muted ? <Bell size={16} /> : <BellOff size={16} />,
      action: onToggleMute,
    },
    { label: 'Mark as read', icon: <CheckCheck size={16} />, action: onMarkRead },
  ];

  const actions = (
    <div className={cn('flex shrink-0 items-center gap-1.5', phone && 'w-full')}>
      <IconButton
        label={muted ? 'Notifications: muted' : 'Notifications'}
        active={muted}
        onClick={(event) => onNotificationMenu(event, bellItems)}
      >
        {muted ? <BellOff size={18} aria-hidden /> : <Bell size={18} aria-hidden />}
      </IconButton>
      <Button variant="ghost" onClick={onMedia}>
        <ImageIcon size={16} aria-hidden />
        Media
      </Button>
      {onSettings && phone && (
        <IconButton label="Server settings" onClick={onSettings}>
          <Settings size={18} aria-hidden />
        </IconButton>
      )}
      {onInvite && (
        <Button variant="primary" onClick={onInvite} className={cn(phone && 'ml-auto')}>
          <UserPlus size={16} aria-hidden />
          Invite
        </Button>
      )}
      {onSettings && !phone && (
        <IconButton label="Server settings" onClick={onSettings}>
          <Settings size={18} aria-hidden />
        </IconButton>
      )}
    </div>
  );

  const mark = (
    <span
      aria-hidden
      className={cn(
        'pc-home-mark pc-display flex shrink-0 items-center justify-center overflow-hidden',
        'rounded-[20px] font-bold text-text-on-light',
      )}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.36,
        background: icon ? 'var(--bg-raised)' : getIdentityColor(guildId),
      }}
    >
      {icon ? <img src={icon} alt="" className="h-full w-full object-cover" draggable={false} /> : guildInitials(name)}
    </span>
  );

  const about = (
    <>
      {description && (
        <p
          className="pc-home-clamp max-w-[64ch] text-body text-text-secondary"
          style={{ '--clamp-lines': phone ? 3 : 2 } as React.CSSProperties}
        >
          {description}
        </p>
      )}
      <MembersButton people={people} onlinePeople={onlinePeople} online={online} members={members} />
    </>
  );

  if (phone) {
    // One column: the mark across the cover, then the name, then the rest,
    // and the actions on a row of their own.
    return (
      <header className="relative z-[2] flex flex-col gap-3 px-4" style={{ marginTop: -44 }}>
        {mark}
        <h1 className="pc-home-name break-words text-text-primary">{name}</h1>
        <div className="flex flex-col gap-1.5">{about}</div>
        {actions}
      </header>
    );
  }

  // The mark crosses the cover's edge; the name sits beside it on the same
  // bottom line, just inside the fade; the actions share that line.
  return (
    <header className="relative z-[2] px-8">
      <div className="flex items-end gap-5" style={{ marginTop: -58 }}>
        {mark}
        <h1 className="pc-home-name min-w-0 flex-1 truncate pb-0.5 text-text-primary">{name}</h1>
        <div className="pb-0.5">{actions}</div>
      </div>
      <div className="mt-2 flex flex-col gap-1.5" style={{ paddingLeft: size + 20 }}>
        {about}
      </div>
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
  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${line}. Show members`}
        className={cn(
          'pc-focusable -ml-1.5 mt-1 inline-flex max-w-full items-center gap-2.5 self-start',
          'rounded-[var(--radius-control)] px-1.5 py-1 text-left',
          'transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-bg-mod-subtle',
        )}
      >
        {onlinePeople.length > 0 && <AvatarStack people={onlinePeople} size={26} max={PILE} context="online" />}
        <span className="truncate text-label text-text-secondary">{line}</span>
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label="Members" className="w-72 p-0">
        <div className="flex items-baseline justify-between gap-3 border-b border-border-subtle px-3.5 py-2.5">
          <span className="pc-display text-name text-text-primary">Members</span>
          <span className="text-meta text-text-muted">{line}</span>
        </div>
        <ul className="flex max-h-80 flex-col gap-0.5 overflow-y-auto scrollbar-thin p-1.5">
          {people.map((person) => (
            <li key={person.userId} className="flex items-center gap-2.5 rounded-[var(--radius-chip)] px-2 py-1.5">
              <LitAvatar person={person} size={26} />
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-label',
                  person.level === 'on' ? 'text-text-primary' : 'text-text-muted',
                )}
              >
                {person.name}
              </span>
              {person.roomName && (
                <span className="max-w-[45%] shrink-0 truncate text-meta text-text-muted">{person.roomName}</span>
              )}
            </li>
          ))}
        </ul>
      </Popover>
    </>
  );
}
