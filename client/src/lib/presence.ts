/**
 * Presence as light (docs/lantern-stage-spec.md §1.5).
 *
 * People who have the app open are **online**: their avatar carries a rim of
 * warm light. The light is the styling; the label says "Online", plainly. Away or offline avatars are matte. There are no
 * status-color dots anywhere in the product — the old `--color-status-*`
 * tokens are deleted.
 *
 *   online   → lit rim
 *   idle     → dim, no rim
 *   dnd      → dim, no rim, plus a small danger slash across the rim
 *   offline  → dim, no rim
 *   streaming→ lit rim (they are live in a room)
 *
 * §9: light is never the only cue, so every call site must render `label`
 * somewhere a screen reader can reach it (visible text, `aria-label`, or a
 * tooltip). This module is the single source of truth for that mapping; a
 * component must not re-derive it.
 */

export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline' | 'streaming' | (string & {});

export interface PresenceLight {
  /** Their lights are on: draw the lit rim. */
  lit: boolean;
  /** Matte: away, do-not-disturb or offline. */
  dim: boolean;
  /** Do not disturb: dim, plus the danger slash. */
  dnd: boolean;
  /** They are live in a room right now. */
  live: boolean;
  /** Class for the avatar element — pair with `pc-dimming` for the §5 fade. */
  avatarClass: string;
  /** The DOM text equivalent. Never let light be the only cue. */
  label: string;
}

const LIT: Omit<PresenceLight, 'label'> = {
  lit: true,
  dim: false,
  dnd: false,
  live: false,
  avatarClass: 'pc-lit',
};

const MATTE: Omit<PresenceLight, 'label'> = {
  lit: false,
  dim: true,
  dnd: false,
  live: false,
  avatarClass: 'pc-dim',
};

/** Maps a presence status onto the light vocabulary. */
export function presenceLight(status: PresenceStatus | null | undefined): PresenceLight {
  switch (status) {
    case 'online':
      return { ...LIT, label: 'Online' };
    case 'streaming':
      return { ...LIT, live: true, label: 'Live in a voice channel' };
    case 'idle':
      return { ...MATTE, label: 'Away' };
    case 'dnd':
      return { ...MATTE, dnd: true, label: 'Do not disturb' };
    default:
      return { ...MATTE, label: 'Offline' };
  }
}

/** Convenience: just the avatar class for a status. */
export function presenceClass(status: PresenceStatus | null | undefined): string {
  return presenceLight(status).avatarClass;
}

/** Convenience: just the text equivalent for a status. */
export function presenceLabel(status: PresenceStatus | null | undefined): string {
  return presenceLight(status).label;
}
