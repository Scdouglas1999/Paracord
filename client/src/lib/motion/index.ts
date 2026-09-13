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
 *   flipCounter ... `<RollingNumber>` — "numbers re-roll"
 *   bus ........... gestures that cross a pane boundary
 *
 * There is no framework here on purpose: Web Animations plus the tokens. The
 * repo has `framer-motion` for a handful of legacy popovers; nothing new is
 * built on it.
 */

export {
  bloom,
  dim,
  fadeIn,
  flash,
  flicker,
  liftOut,
  press,
  relax,
  scaleShadow,
  settleIn,
  stagger,
  type SettleOptions,
  type StaggerOptions,
} from './animate';
export { emitMotion, onMotion, resetMotionBusForTests, type MotionEvents } from './bus';
export { RollingNumber, type RollingNumberProps } from './flipCounter';
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
export { motionToken, ms, num, parseDuration, MOTION_TOKEN_FALLBACKS } from './tokens';
