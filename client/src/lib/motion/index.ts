/**
 * The motion engine (docs/lantern-stage-spec.md §5; the Index moments are
 * `components/ix/motion`).
 *
 * "Only light and the things people do animate." This module is how the app
 * obeys that: every animation in the product goes through one of these recipes,
 * every number comes from a §5 token, and every one of them asks the same
 * reduced-motion switch before it moves a pixel.
 *
 *   tokens ........ the §5 custom properties, read from the document
 *   reducedMotion . the ONE switch (OS setting + user setting + `data-motion`)
 *   spring ........ the critically damped spring a retarget carries velocity on
 *   cubicBezier ... a CSS curve as a function of time
 *   animate ....... bloom · dim · flicker · settleIn · stagger · press ·
 *                   flash · relax
 *   marks ......... what a surface tells the engine it is holding
 *   lights ........ the theme changing
 *   flip .......... the things an arrival pushed out of the way
 *   voiceLevel .... "speaking is a breath" — the ring takes the voice
 *   visibility .... a hidden window pauses every animation that loops
 *   flipCounter ... `<RollingNumber>` — "numbers re-roll"
 *   presence ...... staying mounted for the exit
 *   flipList ...... a reordered list travels on the spring, never snaps; a tab
 *                   indicator slides to its mark
 *   sendFlight .... the message floating out of the composer into the
 *                   conversation (a protected signature gesture, glass §9)
 *   bus ........... gestures that cross a pane boundary
 *
 * There is no framework here on purpose: Web Animations plus the tokens.
 * framer-motion was removed in WP9c; every popover, drawer and banner runs on
 * `usePresence` and the shared CSS recipes.
 */

export {
  arriveIn,
  bloom,
  contentIn,
  dim,
  fadeIn,
  flash,
  flicker,
  ghost,
  ghostOut,
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
export { captureFlip, type FlipCapture } from './flip';
export {
  changeLights,
  type LightsChangeEngine,
  type LightsChangeOptions,
  type LightsChangeResult,
} from './lights';
export { PERSON_MARK, SPEAKING_MARK } from './marks';
export { emitMotion, onMotion, resetMotionBusForTests, type MotionEvents } from './bus';
export {
  RELAX_MS,
  SEND_FLIGHT,
  captureRoom,
  flySend,
  makeRoom,
  pressComposer,
  readSendOrigin,
  releaseSend,
  type Flight,
  type FlightOptions,
  type SendOrigin,
} from './sendFlight';
export { RollingNumber, type RollingNumberProps } from './flipCounter';
export {
  FLIP_GLYPH_ATTR,
  FLIP_KEY_ATTR,
  FLIP_OWN_ATTR,
  flipBetween,
  useFlip,
  useFlipList,
  useIndicator,
  type FlipListOptions,
  type FlipOptions,
  type IndicatorOptions,
} from './flipList';
export {
  anchorOrigin,
  setStreetPaintedForTests,
  streetIsPainted,
  useContentSwap,
  useLingering,
  usePresence,
  useSettleIn,
  type AnchorAlign,
  type AnchorSide,
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
export { cubicBezier } from './cubicBezier';
export { motionToken, ms, num, parseDuration, rawToken, MOTION_TOKEN_FALLBACKS } from './tokens';
export { installVisibilityPause, resetVisibilityPauseForTests } from './visibility';
export {
  clearVoiceLevels,
  levelFromAnalyzer,
  levelFromDbov,
  publishVoiceLevels,
  stepVoiceLevelsForTests,
  voiceLevelsForTests,
  VOICE_ATTACK_MS,
  VOICE_LEVEL_VAR,
  VOICE_RELEASE_MS,
  type VoiceLevelSource,
} from './voiceLevel';
