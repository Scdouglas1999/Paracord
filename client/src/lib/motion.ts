import type { Variants, Transition } from 'framer-motion';

// ─── Shared Transitions ───────────────────────────────────────────

/** Snappy spring for panel slides and layout shifts */
export const springSnappy: Transition = {
  type: 'spring',
  stiffness: 400,
  damping: 30,
};

/** Gentle spring for overlays and modals */
export const springGentle: Transition = {
  type: 'spring',
  stiffness: 280,
  damping: 26,
};

/** Quick tween for micro-interactions (hover states, button presses) */
export const tweenFast: Transition = {
  type: 'tween',
  duration: 0.12,
  ease: [0.22, 1, 0.36, 1],
};

/** Normal tween for content transitions */
export const tweenNormal: Transition = {
  type: 'tween',
  duration: 0.18,
  ease: [0.22, 1, 0.36, 1],
};

/** Slow tween for page-level transitions */
export const tweenSlow: Transition = {
  type: 'tween',
  duration: 0.28,
  ease: [0.45, 0, 0.55, 1],
};

// ─── Shared Variants ──────────────────────────────────────────────

/** Fade in/out — use for overlays, tooltips */
export const fadeVariants: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  exit: { opacity: 0 },
};

/** Scale + fade — use for modals, dialogs, popups */
export const scaleInVariants: Variants = {
  hidden: { opacity: 0, scale: 0.95, y: 8 },
  visible: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.95, y: 8 },
};

/** Slide up + fade — use for message rows entering */
export const slideUpVariants: Variants = {
  hidden: { opacity: 0, y: 4 },
  visible: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
};

/** Slide from left — use for sidebars, channel panels */
export const slideFromLeftVariants: Variants = {
  hidden: { opacity: 0, x: -24 },
  visible: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -24 },
};

/** Slide from right — use for member list, search panels */
export const slideFromRightVariants: Variants = {
  hidden: { opacity: 0, x: 24 },
  visible: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: 24 },
};

/** Collapse height — use for expandable sections, mini bars */
export const collapseVariants: Variants = {
  hidden: { height: 0, opacity: 0 },
  visible: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
};

/** Toast slide in from right */
export const toastVariants: Variants = {
  hidden: { opacity: 0, x: '100%' },
  visible: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: '100%' },
};

// ─── Micro-interaction Helpers ────────────────────────────────────

/** Button press: scale down on tap */
export const tapScale = { scale: 0.97 };

/** Hover lift: subtle upward shift */
export const hoverLift = { y: -1 };

/** Hover with brightness increase */
export const hoverBrighten = { y: -1, filter: 'brightness(1.05)' };
