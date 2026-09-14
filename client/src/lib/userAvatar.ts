import { resolveResourceUrl, resourceNeedsDownloadTicket } from './config/apiBaseUrl';
import { getDownloadTicket } from './downloadTicket';
import { safeClientResourceUrl, safeStoredImageDataUrl } from './security';
import { isTauri } from './tauriEnv';

/**
 * Resolve a stored avatar value (data URL or `/api/v1/users/{id}/avatar`) for <img src>.
 *
 * Absolute URLs are refused, not resolved. An avatar renders automatically for
 * every viewer of a message or member list, so honouring a remote URL another
 * user chose would beacon each viewer's IP, user agent and viewing time to a
 * host that user controls, with no interaction. The server rejects a remote
 * `avatar_hash` on write; this is the matching client-side floor, so a value
 * already stored (or served by a hostile server) cannot beacon either.
 */
export function resolveUserAvatarUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith('data:')) return safeStoredImageDataUrl(value);
  if (value.startsWith('blob:')) return value;
  const trimmed = value.trim();
  if (trimmed.includes('://') || trimmed.startsWith('//')) return null;
  const safe = safeClientResourceUrl(trimmed);
  if (!safe) return null;
  const ticket = getDownloadTicket();
  const resolved = resolveResourceUrl(safe, ticket);
  // In a browser, no ticket yet means this exact URL would come back 401. Say
  // "no avatar" so the caller draws its initials chip and `useDownloadTicket`
  // re-runs this once the ticket lands — a broken-image glyph that never
  // repairs is worse than the fallback the component already has.
  //
  // The desktop shell never loads this URL itself: `useAuthenticatedImage`
  // fetches it over the native bridge, with the access token and the server's
  // certificate pin. Gating it on a ticket it does not use would hold a face
  // back for no reason, and hold it back forever if the mint never succeeded.
  if (!ticket && !isTauri() && resourceNeedsDownloadTicket(resolved)) return null;
  return safeClientResourceUrl(resolved);
}
