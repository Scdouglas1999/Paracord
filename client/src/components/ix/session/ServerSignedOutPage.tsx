import { CreamButton } from '../primitives';
import { EmptyPage } from '../page/EmptyPage';
import type { ServerEntry } from '../../../stores/serverListStore';
import { serverDisplayName } from './ServerSignInDialog';
import { useServerSignInDialog } from './serverSignInDialogStore';

/**
 * Main, for a place on a saved server that ended your session (docs/index-spec.md §6.8
 * notice): say so, and the one way forward is to sign in again. While the server is only
 * connecting or being retried, main shows the loading page instead; nothing here says a
 * channel is gone when its server simply has not answered yet.
 */
export function ServerSignedOutPage({ server }: { server: ServerEntry }) {
  const open = useServerSignInDialog((state) => state.open);
  const name = serverDisplayName(server);
  return (
    <EmptyPage
      glyph="lock"
      aria-label="Signed out"
      data-testid="ix-server-signed-out"
      title={`You’re signed out of ${name}`}
      line="Sign in again to see its channels. Nothing here is lost."
      action={<CreamButton onClick={() => open(server.id)}>Sign in again</CreamButton>}
    />
  );
}
