import { useSyncExternalStore } from 'react';

import { getDownloadTicket, subscribeDownloadTicket } from '../lib/downloadTicket';

/**
 * The active server's download ticket, as reactive state.
 *
 * An `<img src>` pointed at an authenticated server route (an avatar, a custom
 * emoji, a sticker) carries `?ticket=…` because a webview image load sends no
 * Authorization header and, on the desktop shell, no cookie either — the page
 * origin is `tauri://localhost` and the server is a different origin entirely.
 *
 * The ticket is minted asynchronously, so anything that renders before it lands
 * builds a URL the server answers 401 to. The URL builders are plain functions,
 * so React has no reason to re-run them when the ticket finally arrives, and the
 * broken image stays broken for the life of the session. Call this in any
 * component that renders such an image and feed the value into the memo that
 * builds the URL: subscribing is also what starts the mint.
 */
export function useDownloadTicket(): string | null {
  return useSyncExternalStore(subscribeDownloadTicket, getDownloadTicket, () => null);
}
