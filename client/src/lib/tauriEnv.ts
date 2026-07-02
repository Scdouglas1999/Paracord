export function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  if ('__TAURI_INTERNALS__' in window || '__TAURI__' in window) return true;
  if (typeof navigator !== 'undefined' && /tauri/i.test(navigator.userAgent)) return true;
  return false;
}
