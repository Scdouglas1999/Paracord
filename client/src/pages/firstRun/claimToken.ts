/**
 * The setup code, when the owner arrived by the link their server printed
 * (moved from the retired InstanceSetupPage; docs/setup-spec.md §2.11).
 *
 * The server and the installers print `…/setup-server#claim=<code>` and open it
 * in the browser. It rides in the FRAGMENT because a fragment is never sent to
 * the server, so the code reaches no access log; and it is scrubbed from the
 * address bar the moment it is read, so it is not left in history or copied
 * along with the URL.
 */
export function takeSetupCodeFromLocation(
  location: Pick<Location, 'hash' | 'pathname' | 'search'> = window.location,
  history: Pick<History, 'replaceState'> = window.history,
): string | null {
  const match = /(?:^#|&)claim=([^&]+)/.exec(location.hash);
  if (!match) return null;
  let code: string;
  try {
    code = decodeURIComponent(match[1]).trim();
  } catch {
    return null;
  }
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  // What the server mints is long and alphanumeric. Anything else is not a code.
  return /^[A-Za-z0-9_-]{16,256}$/.test(code) ? code : null;
}
