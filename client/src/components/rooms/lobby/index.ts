/**
 * The Lobby (docs/lantern-stage-spec.md §7.3) — a building seen from the street.
 *
 * `Lobby` is the whole surface; everything else here is one of its parts, kept
 * separately so each can be rendered and tested in isolation. The data comes
 * from WP1's light selectors (`src/hooks/useLights.ts`) and from the endpoints
 * the app already calls — this package adds no route and no store.
 */
export { Lobby, type LobbyProps } from './Lobby';
export { LobbyHeader, type LobbyHeaderProps } from './LobbyHeader';
export { AroundNowWell, type AroundNowWellProps } from './AroundNowWell';
export { RoomCard, AddRoomTile, type RoomCardProps, type AddRoomTileProps } from './RoomCard';
export { TextRoomRow, type TextRoomRowProps } from './TextRoomRow';
export { EventCard, type EventCardProps } from './EventCard';
export { MediaStrip, type MediaStripProps } from './MediaStrip';
export { useNextEvent, nextEventOf, toLobbyEvent, type LobbyEvent } from './useNextEvent';
export {
  useRecentMedia,
  selectRecentMedia,
  isImageAttachment,
  messageTimeMs,
  type LobbyMediaItem,
  type RecentMedia,
} from './useRecentMedia';
