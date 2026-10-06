import { gateway } from '../../../gateway/manager';
import type { ServerReadiness } from '../../../hooks/useServerReady';
import { serverDisplayName } from './ServerSignInDialog';
import { useServerSignInDialog } from './serverSignInDialogStore';

/**
 * What a section says while the server it would ask is not connected (docs/index-spec.md
 * §6.8: a quiet note, never an error toast and never a crashed page).
 *
 * Connecting is the section's own loading state, so it renders nothing: the skeleton
 * the section already draws says "wait". A server that is unreachable (and being
 * retried) or that refused the session says so, with the one thing to do about it.
 * The sidebar says the same in its own words (`ServerUnavailable`).
 */
export function ServerWaitNote({ readiness }: { readiness: ServerReadiness }) {
  const openSignIn = useServerSignInDialog((state) => state.open);
  const { server, phase } = readiness;
  if (!server || (phase !== 'retrying' && phase !== 'signed-out')) return null;
  const name = serverDisplayName(server);
  if (phase === 'signed-out') {
    return (
      <div className="ix-note" data-testid="ix-section-waiting" data-state="signed-out" role="status">
        <span>You&rsquo;re signed out of {name}.</span>
        <button type="button" className="ix-link" onClick={() => openSignIn(server.id)}>
          Sign in again
        </button>
      </div>
    );
  }
  return (
    <div className="ix-note" data-testid="ix-section-waiting" data-state="retrying" role="status">
      <span>Can&rsquo;t reach {name} right now. Trying again.</span>
      <button type="button" className="ix-link" onClick={() => void gateway.retryServer(server.id)}>
        Try now
      </button>
    </div>
  );
}
