import { resolveResourceUrl } from './config/apiBaseUrl';
import { getDownloadTicket } from './downloadTicket';
import { safeClientResourceUrl, safeStoredImageDataUrl } from './security';

/** Resolve a stored avatar value (data URL or `/api/v1/users/{id}/avatar`) for <img src>. */
export function resolveUserAvatarUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith('data:')) return safeStoredImageDataUrl(value);
  if (value.startsWith('blob:')) return value;
  const safe = safeClientResourceUrl(value);
  if (!safe) return null;
  return safeClientResourceUrl(resolveResourceUrl(safe, getDownloadTicket()));
}
