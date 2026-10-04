import type { MouseEvent } from 'react';

import type { SidebarRoom } from '../../glass/places/rows';
import { IxGlyph } from '../glyphs';
import { AvatarStack } from '../identity';
import { SidebarLabel } from './SidebarLabel';
import { FLIP_ATTRIBUTE } from './useCollapse';
import { pointEvent, useLongPress } from './useLongPress';
import type { RowFocus } from './useRovingList';

export interface RoomListProps {
  rooms: readonly SidebarRoom[];
  focusOf: (id: string) => RowFocus;
  /** Click joins the room (the prototype's behavior; Listen is the right-click). */
  onJoin: (room: SidebarRoom) => void;
  onMenu: (event: MouseEvent<HTMLElement>, room: SidebarRoom) => void;
}

/** The words a screen reader gets for a room: who is in it, then what a click does. */
export function roomLabel(room: SidebarRoom): string {
  const who =
    room.count === 0
      ? 'empty'
      : `${room.count} here${room.people.length > 0 ? `: ${room.people.join(', ')}` : ''}${room.streaming ? ', someone is sharing their screen' : ''}`;
  return `${room.name}, ${who}. ${room.stage ? 'Join the audience' : 'Join'}`;
}

/**
 * Voice channels (docs/index-spec.md §4.6; the code and the card say "room", the screen never does): every voice and stage channel the live card is
 * not showing, in the server's order. A slim row: the speaker (a podium for a
 * stage), the name, and "Empty" or "3 here". A room with people in it reads
 * brighter, with an amber glyph and up to three small faces before the count.
 * Click joins; right-click is the room menu (Listen in, Open chat, ...).
 *
 * Renders nothing, not even its label, when the server has no rooms.
 */
export function RoomList({ rooms, focusOf, onJoin, onMenu }: RoomListProps) {
  if (rooms.length === 0) return null;
  return (
    <section aria-labelledby="ix-sb-rooms">
      <SidebarLabel id="ix-sb-rooms">Voice channels</SidebarLabel>
      <ul className="ix-sb__rooms">
        {rooms.map((room) => (
          <RoomRow key={room.id} room={room} focus={focusOf(room.id)} onJoin={onJoin} onMenu={onMenu} />
        ))}
      </ul>
    </section>
  );
}

function RoomRow({
  room,
  focus,
  onJoin,
  onMenu,
}: {
  room: SidebarRoom;
  focus: RowFocus;
  onJoin: RoomListProps['onJoin'];
  onMenu: RoomListProps['onMenu'];
}) {
  const press = useLongPress((point) => onMenu(pointEvent(point), room));
  return (
    <li>
      <button
        type="button"
        className="ix-rm"
        data-testid="ix-room-row"
        data-channel-id={room.channelId}
        data-place-row=""
        data-row-id={room.id}
        data-busy={room.busy || undefined}
        {...{ [FLIP_ATTRIBUTE]: '' }}
        aria-label={roomLabel(room)}
        {...focus}
        {...press}
        onClick={() => onJoin(room)}
        onContextMenu={(event) => onMenu(event, room)}
      >
        <IxGlyph name={room.stage ? 'stage' : 'speaker'} size={16} />
        <span className="ix-rm__name">{room.name}</span>
        <span className="ix-rm__tail">
          {room.faces.length > 0 && (
            <AvatarStack
              people={room.faces.map((face) => ({ userId: face.userId, name: face.name, avatar: face.avatar }))}
              size={16}
              overlap={5}
              ring="var(--ix-side-end)"
            />
          )}
          {room.tail}
        </span>
      </button>
    </li>
  );
}
