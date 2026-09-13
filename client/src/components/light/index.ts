/**
 * The light components (docs/lantern-stage-spec.md §8).
 *
 * Presentational only: they take a {@link import('../../lib/attention/light').RoomLight},
 * {@link import('../../lib/attention/light').PersonLight} or
 * {@link import('../../lib/attention/light').BuildingLight} and draw it. No
 * store reads, no fetching, no product decisions — the models come from
 * `src/hooks/useLights.ts` and the rules from `src/lib/attention/`.
 *
 * Every one of them renders the light's text equivalent in the DOM (§9), and
 * all motion lives in `src/styles/primitives.css`, where
 * `prefers-reduced-motion` is handled once (§5).
 */
export { LiveDot, type LiveDotProps } from './LiveDot';
export { LitAvatar, avatarInitials, type LitAvatarProps } from './LitAvatar';
export { AvatarStack, type AvatarStackProps } from './AvatarStack';
export { WindowMap, type WindowMapProps } from './WindowMap';
export { BuildingPlate, type BuildingPlateProps } from './BuildingPlate';
export { HereNowStrip, type HereNowStripProps } from './HereNowStrip';
export {
  RoomThumbnail,
  type RoomThumbnailProps,
  type RoomThumbnailHeight,
} from './RoomThumbnail';
export { OnAirPill, type OnAirPillProps } from './OnAirPill';
export {
  LightCaption,
  RoomDuration,
  roomCaptionFor,
  type LightCaptionProps,
  type RoomCaptionOptions,
} from './LightCaption';
