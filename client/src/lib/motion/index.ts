/**
 * The motion engine (docs/lantern-stage-spec.md §5).
 *
 * "Only light and the things people do animate." This module is how the app
 * obeys that: every animation in the product goes through one of these recipes,
 * every number comes from a §5 token, and every one of them asks the same
 * reduced-motion switch before it moves a pixel.
 *
 *   tokens ........ the §5 custom properties, read from the document
 *   reducedMotion . the ONE switch (OS setting + user setting + `data-motion`)
 *   spring ........ the damped spring behind `--ease-spring-settle`
 *   animate ....... bloom · dim · flicker · settleIn · stagger · press ·
 *                   flash · liftOut · relax
 *   sharedElement . "the thing you click becomes the thing you look at"
 *   marks ......... what a surface tells the engine it is holding
 *   lightsOn ...... "lights on" — the building waking up
 *   arrive ........ "someone arrives / leaves" — one path, one burst
 *   walk .......... "walk into a room / back to the pill"
 *   flip .......... the things an arrival pushed out of the way
 *   flipCounter ... `<RollingNumber>` — "numbers re-roll"
 *   presence ...... staying mounted for the exit; settling onto the street
 *   flipList ...... a reordered list travels on the spring, never snaps; a tab
 *                   indicator slides to its mark
 *   bus ........... gestures that cross a pane boundary
 *
 * There is no framework here on purpose: Web Animations plus the tokens. The
 * repo has `framer-motion` for a handful of legacy popovers; nothing new is
 * built on it.
 */

export {
  arriveIn,
  bloom,
  dim,
  fadeIn,
  flash,
  flicker,
  ghost,
  ghostOut,
  liftOut,
  press,
  recede,
  relax,
  scaleShadow,
  settleIn,
  slideOut,
  stagger,
  type SettleOptions,
  type StaggerOptions,
} from './animate';
export {
  ARRIVAL_SEQUENCE_BUDGET_MS,
  BURST_WINDOW_MS,
  RIM_AFTER_ROOM_MS,
  arrivalStep,
  captureArrival,
  facesFor,
  playArrivals,
  playDepartures,
  type RoomPersonEvent,
} from './arrive';
export { captureFlip, type FlipCapture } from './flip';
export {
  LIGHTS_ON_BUDGET_MS,
  lightsOnStep,
  playLightsOn,
  type LightsOnOptions,
  type LightsOnSequence,
} from './lightsOn';
export {
  EVENT_MARK,
  LAMP_MARK,
  LIT_MARK,
  PERSON_MARK,
  PLATE_MARK,
  RECEDE_MARK,
  RIM_MARK,
  ROOM_MARK,
  STRIP_MARK,
  WINDOW_MARK,
  lightMarks,
  markSelector,
} from './marks';
export { recedeAround, roomSharedName, walkIntoRoom, walkOutOfRoom, type WalkOptions } from './walk';
export { emitMotion, onMotion, resetMotionBusForTests, type MotionEvents } from './bus';
export { RollingNumber, type RollingNumberProps } from './flipCounter';
export {
  FLIP_KEY_ATTR,
  flipBetween,
  useFlip,
  useFlipList,
  useIndicator,
  type FlipListOptions,
  type FlipOptions,
  type IndicatorOptions,
} from './flipList';
export {
  setStreetPaintedForTests,
  streetIsPainted,
  usePresence,
  useSettleIn,
  type Presence,
} from './presence';
export {
  configureMotion,
  motionPreference,
  MOTION_PREFERENCES,
  prefersReducedMotion,
  resetMotionSwitchForTests,
  subscribeReducedMotion,
  useReducedMotion,
  type MotionPreference,
} from './reducedMotion';
export {
  sampleRunning,
  springDuration,
  springEasing,
  springLinearEasing,
  springProgress,
  springTokens,
  supportsLinearEasing,
  type SpringConfig,
} from './spring';
export {
  transitionWith,
  type SharedTransitionOptions,
  type SharedTransitionResult,
} from './sharedElement';
export { motionToken, ms, num, parseDuration, rawToken, MOTION_TOKEN_FALLBACKS } from './tokens';
