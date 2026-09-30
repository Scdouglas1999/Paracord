/**
 * The Glass frame (WP-G7): pane geometry, the places overlay, the header's
 * places button, and the slot contract every later package fills.
 */
export { GlassFrame } from './GlassFrame';
export type { GlassFrameProps } from './GlassFrame';
export { PlacesOverlay } from './PlacesOverlay';
export { PlacesToggle } from './PlacesToggle';
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
