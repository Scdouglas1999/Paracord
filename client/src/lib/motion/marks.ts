/**
 * The marks — how a surface tells the engine what it is holding
 * (docs/lantern-stage-spec.md §5.1).
 *
 * WP9a's shared element already worked this way (`data-motion-shared`,
 * `data-motion-chrome`): the component says *what* an element is, and the
 * engine decides *how* it moves. The three signature moments in WP9b need the
 * same seam for light — a window, a lamp, a plate, a person's rim, the face in
 * a here-now strip, the inline room event.
 *
 * Two rules make this safe to sweep the DOM for:
 *
 *   1. **A mark is an identity, never a style.** `data-motion-window="2001"`
 *      says "this cell is room 2001's window". It carries no appearance and no
 *      state a component has to keep in sync — the engine reads the resting
 *      glow off the element itself (`scaleShadow`), exactly as WP9a does.
 *   2. **A mark says whether the light is on, because the engine must not
 *      invent one.** `data-motion-lit` is present only while the element is
 *      actually lit, so "lights on" blooms the windows that are on and leaves
 *      the dark ones dark (§0: every glow has a source).
 */

/** One room's window — the cell in a `WindowMap`, or the 8px dot on a row. */
export const WINDOW_MARK = 'data-motion-window';
/** The single permitted radial on a lit plate. */
export const LAMP_MARK = 'data-motion-lamp';
/** A building plate on the street. */
export const PLATE_MARK = 'data-motion-plate';
/** One person — the `LitAvatar` root, the thing that moves. */
export const PERSON_MARK = 'data-motion-person';
/** The element inside a `LitAvatar` that actually carries the rim glow. */
export const RIM_MARK = 'data-motion-rim';
/** The room a marked element belongs to, when the surface knows it. */
export const ROOM_MARK = 'data-motion-room';
/** A here-now strip / avatar stack: the place a face springs into. */
export const STRIP_MARK = 'data-motion-strip';
/** The inline room event in a text timeline ("Shop floor is live · …"). */
export const EVENT_MARK = 'data-motion-event';
/** A region that steps back while you walk through it. */
export const RECEDE_MARK = 'data-motion-recede';
/** Present only while the light is actually on. */
export const LIT_MARK = 'data-motion-lit';
/**
 * One person's speaking ring, where the ring is not a face.
 *
 * A `LitAvatar` already says who it is with `PERSON_MARK`, and the level
 * inherits from its root down to the rim inside it. A `StageTile` is a 12px
 * well that carries the same ring around a whole video surface and has no face
 * in it at all, so it says whose voice is driving it here. Both are read by
 * `voiceLevel.ts`, and by nothing else.
 */
export const SPEAKING_MARK = 'data-motion-speaking';

/** `data-motion-*` props for a light element, spread straight onto the DOM. */
export function lightMarks(
  mark: typeof WINDOW_MARK | typeof PERSON_MARK | typeof RIM_MARK,
  id: string,
  lit: boolean,
): Record<string, string> {
  return lit ? { [mark]: id, [LIT_MARK]: '' } : { [mark]: id };
}

/** `[data-motion-window="2001"]`, with the value escaped. */
export function markSelector(mark: string, value?: string | null): string {
  if (value == null || value === '') return `[${mark}]`;
  const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(value) : value;
  return `[${mark}="${escaped}"]`;
}
