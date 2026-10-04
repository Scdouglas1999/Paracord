import { useCallback, useState } from 'react';

import { useAuthenticatedImage } from '../../../lib/authenticatedImage';

/**
 * The picture an avatar or a server mark shows, or null when it has none to
 * show. `resolved` is an already-resolved URL (a data URL, a blob, or a server
 * path with its ticket); on the desktop shell the bytes come over the native
 * bridge, so the result is null while they are in flight and the monogram
 * stands in for that moment.
 *
 * A picture that fails to load is not left as a broken glyph: `onError` marks
 * that exact URL as failed and the monogram takes over, until the URL changes.
 */
export function useMarkImage(resolved: string | null): { src: string | null; onError: () => void } {
  const loaded = useAuthenticatedImage(resolved);
  const [failed, setFailed] = useState<string | null>(null);
  const onError = useCallback(() => setFailed(loaded), [loaded]);
  return { src: loaded && loaded !== failed ? loaded : null, onError };
}
