import { EmptyPage } from '../ix/page/EmptyPage';
import { CreamButton } from '../ix/primitives';

/**
 * A server you cannot open (docs/index-spec.md §6.8). A stale or not-for-you link
 * is the most ordinary way to arrive at a server that is not yours, and it used to
 * land on an indefinite skeleton behind two toasts reading "Failed to load members:
 * forbidden". It is the same notice the channel route uses: the empty-state layout,
 * copy that does not leak whether the server exists, and one way back.
 */
export function BuildingNotFound({ onGoHome }: { onGoHome: () => void }) {
  return (
    <EmptyPage
      glyph="lock"
      aria-label="Server not found"
      title="This server isn’t yours to open"
      line="It may have closed, or you may not have been let in. Ask whoever sent you the link for a fresh invite."
      action={<CreamButton onClick={onGoHome}>Back to your servers</CreamButton>}
    />
  );
}
