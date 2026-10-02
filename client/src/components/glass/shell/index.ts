/**
 * The Glass frame (WP-G7): pane geometry, the places overlay, the header's
 * places button, and the slot contract every later package fills. The phone's
 * frame and its navigation are WP-G20's (`usePhoneFrame`, `phoneNav`): the phone
 * is a layout of the same frame, not a frame of its own.
 */
export { GlassFrame } from './GlassFrame';
export type { GlassFrameProps } from './GlassFrame';
export { PlacesOverlay } from './PlacesOverlay';
export { PlacesToggle } from './PlacesToggle';
export { isConversationRoute, isPlacesRoute, usePhoneNavigation, usePhoneNavStore, usePhoneScreen } from './phoneNav';
export type { PhoneScreen } from './phoneNav';
export { useGlassLayout, PLACES_OVERLAY_MAX_WIDTH } from './useGlassLayout';
export type { GlassLayout } from './useGlassLayout';
export type {
  RoomBackdropProps,
  PlacesPanelProps,
  PlacesPresentation,
  ConversationPaneProps,
  ConversationSubject,
  CallPillProps,
  StageProps,
  SheetsProps,
} from './slots';
