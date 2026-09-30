import type { RoomBackdropProps } from '../slots';

/**
 * STUB (WP-G7) for `components/glass/room` — WP-G8 replaces it with the one
 * canvas backdrop (spec §4).
 *
 * Paints the room from `--room-rgb` alone: the street, a soft pool of the room
 * color toward the upper right and a fainter one low on the left, as the
 * reference renders light it. No canvas, no blur, no sampling; `--room-rgb`
 * keeps its token default until G8 writes it.
 *
 * `data-native-underlay-clear`: on the Linux native-video route the backdrop
 * must go transparent with the rest of the ancestor chain, or it would cover
 * the hole the video shows through (styles/layout.css). G8 keeps that.
 */
export function RoomBackdrop({ guildId }: RoomBackdropProps) {
  return (
    <div
      aria-hidden
      className="glass-room-backdrop"
      data-native-underlay-clear=""
      data-room-guild={guildId ?? undefined}
    />
  );
}
