/**
 * The marks the speaking ring reads (`voiceLevel.ts`): a surface tells the
 * engine whose voice drives it, and the engine decides how it moves. A mark is
 * an identity, never a style: `data-motion-speaking="2001"` says "this element
 * is person 2001's ring". It carries no appearance and no state a component has
 * to keep in sync.
 */

/** One person — the element that carries their ring (and inherits the level down). */
export const PERSON_MARK = 'data-motion-person';

/**
 * One person's speaking ring, where the ring is not a face.
 *
 * A call tile is a well that carries the same ring around a whole video surface
 * and has no face in it at all, so it says whose voice is driving it here. Read
 * by `voiceLevel.ts`, and by nothing else.
 */
export const SPEAKING_MARK = 'data-motion-speaking';
