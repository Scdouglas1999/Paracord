import type { Activity } from '../../types';
import { currentItem, type TogetherSession } from './model';

/**
 * The presence activity for a Watch/Listen together session: "Watching <title>"
 * (type 3) or "Listening to <title>" (type 2). Null when nothing is current.
 *
 * Presence is sent by the shared activity composer from the Now playing
 * workstream (`lib/presenceActivities.ts`, `setActivitySource('together', …)`),
 * where the Together activity wins over the OS media session while it lasts.
 */
export function togetherActivity(session: TogetherSession | null | undefined): Activity | null {
  const title = currentItem(session)?.title;
  if (!session || !title) return null;
  return {
    name: 'Paracord',
    type: session.kind === 'watch' ? 3 : 2,
    details: title,
  };
}
