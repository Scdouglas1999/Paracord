import { resolveResourceUrl } from './config/apiBaseUrl';
import { getDownloadTicket } from './downloadTicket';
import { safeClientResourceUrl, safeStoredImageDataUrl } from './security';

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
  return safeClientResourceUrl(resolveResourceUrl(safe, getDownloadTicket()));
}
