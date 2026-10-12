import { useState } from 'react';

import { gateway } from '../../../gateway/manager';
import { useGuildServerState } from '../../../hooks/useGuildServerState';
import { serverDisplayName } from '../session/ServerSignInDialog';
import { useServerSignInDialog } from '../session/serverSignInDialogStore';
import { CordMark } from '../../brand/CordMark';
import { IdentityChangedSheet } from '../../firstRun/IdentityChangedSheet';

/**
 * The sidebar for a server you cannot see yet (docs/index-spec.md §4.1 states of the list).
 *
 * "This server is not available" is only true once its saved server is connected and the
 * server is still not in your list (you left it). Until then the pane says where its server
 * stands: connecting, unreachable and being retried (with Try now), signed out (with Sign
 * in again), or showing a certificate other than the one pinned for it (Identity changed,
 * with Review: docs/setup-spec.md §7.4). Which saved server a place is on comes from what the client knows: the server's
 * own record when its list has arrived, else the last-place memory, else the server you were
 * last active on.
 */
export function ServerUnavailable({ guildId }: { guildId: string }) {
  const found = useGuildServerState(guildId);
  const server = found?.server;
  const phase = found?.state ?? null;
  const openSignIn = useServerSignInDialog((state) => state.open);
  const [reviewing, setReviewing] = useState(false);

  if (!server || phase?.phase === 'connected') {
    return (
      <div className="ix-sb" data-testid="ix-server-unavailable" data-state="unavailable">
        <p className="ix-sb__note">This server is not available.</p>
      </div>
    );
  }

  const name = serverDisplayName(server);
  if (phase?.phase === 'signed-out') {
    return (
      <div className="ix-sb" data-testid="ix-server-unavailable" data-state="signed-out">
        <p className="ix-sb__note">You&rsquo;re signed out of {name}.</p>
        <button type="button" className="ix-sb__retry" onClick={() => openSignIn(server.id)}>
          Sign in again
        </button>
      </div>
    );
  }
  if (phase?.phase === 'identity-changed') {
    return (
      <div className="ix-sb" data-testid="ix-server-unavailable" data-state="identity-changed">
        <p className="ix-sb__note" role="status">
          Identity changed. {name} stays disconnected until you review it.
        </p>
        <button type="button" className="ix-sb__retry" onClick={() => setReviewing(true)}>
          Review
        </button>
        <IdentityChangedSheet
          open={reviewing}
          serverName={name}
          serverUrl={server.url}
          onClose={() => setReviewing(false)}
          onTrusted={() => {
            setReviewing(false);
            void gateway.retryServer(server.id);
          }}
        />
      </div>
    );
  }
  if (phase?.phase === 'retrying') {
    return (
      <div className="ix-sb" data-testid="ix-server-unavailable" data-state="retrying">
        <p className="ix-sb__note" role="status">
          Can&rsquo;t reach {name} right now. Trying again.
        </p>
        <button type="button" className="ix-sb__retry" onClick={() => void gateway.retryServer(server.id)}>
          Try now
        </button>
      </div>
    );
  }
  // Connecting, or not asked yet (the stores are still waking up).
  return (
    <div className="ix-sb" data-testid="ix-server-unavailable" data-state="connecting">
      <CordMark size={40} motion="working" className="ix-sb__mark" />
      <p className="ix-sb__note" role="status">
        Connecting to {name}&hellip;
      </p>
    </div>
  );
}
