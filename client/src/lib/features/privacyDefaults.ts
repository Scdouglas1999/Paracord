/**
 * Privacy defaults (setup spec §8.2, §8.4).
 *
 * "Show what I'm playing" is off until someone turns it on: the stored value is
 * read as `=== true`, so a person who never chose (no key, or a stale `false`)
 * shares nothing, and a person who turned it on explicitly (stored `true`)
 * keeps it. Never read this setting as `!== false`.
 */
export const ACTIVITY_DETECTION_KEY = 'activityDetectionEnabled';

export function isActivityDetectionOn(
  notifications: Record<string, unknown> | null | undefined,
): boolean {
  return notifications?.[ACTIVITY_DETECTION_KEY] === true;
}

/**
 * The `notifications` object to store when a new account is created: the
 * choice written down as `false` rather than left to the default, so it is a
 * decision the account made and not an absence. Merges over what exists.
 */
export function withExplicitActivityOff(
  notifications: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  return { ...(notifications ?? {}), [ACTIVITY_DETECTION_KEY]: false };
}

/**
 * A reader with link previews off sees none (setup spec §8.3): the server's
 * unfurled cards (type `link`) are dropped. Embeds a webhook or feed posted on
 * purpose are not previews and stay.
 */
export function visibleEmbeds<T extends { type?: string }>(
  embeds: readonly T[] | null | undefined,
  linkPreviewsOn: boolean,
): T[] {
  return (embeds ?? []).filter((embed) => linkPreviewsOn || embed.type !== 'link');
}
