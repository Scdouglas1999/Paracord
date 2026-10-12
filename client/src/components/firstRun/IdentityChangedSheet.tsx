import { useEffect, useId, useState } from 'react';

import { acceptChangedIdentity, loadIdentityChange, type IdentityChange } from '../../lib/trustedHosts';
import { formatTrustWords, trustWords } from '../../lib/trustWords';
import { CreamButton, WideControl } from '../ix/primitives';
import { Modal } from '../ui/Modal';
import './identityChangedSheet.css';

export interface IdentityChangedSheetProps {
  open: boolean;
  /** What the server is called in a sentence (its name, else its address). */
  serverName: string;
  /** The saved server's URL; its host is the one whose certificate changed. */
  serverUrl: string;
  /** "Stay disconnected", Escape or the scrim: nothing changes. */
  onClose: () => void;
  /** The new identity is pinned; the caller reconnects the server. */
  onTrusted: () => void;
}

interface Words {
  old: string;
  next: string;
}

/**
 * "{server} has a new identity" (docs/setup-spec.md §7.4): the server presented
 * a certificate other than the one this app pinned for it. Shows the words it
 * used to have and the words it has now, and asks the person to check with
 * whoever runs it. **Stay disconnected** is the default; **Trust the new
 * identity** asks the shell to re-pin the host to exactly the certificate it
 * recorded (`accept_changed_identity`), which refuses if the server has moved
 * on to yet another one.
 */
export function IdentityChangedSheet({ open, serverName, serverUrl, onClose, onTrusted }: IdentityChangedSheetProps) {
  const titleId = useId();
  const bodyId = useId();
  return (
    <Modal
      open={open}
      onClose={onClose}
      role="alertdialog"
      labeledBy={titleId}
      describedBy={bodyId}
      panelClassName="ix-dialog-panel"
      zIndexClassName="z-[160]"
    >
      {open && (
        <SheetBody
          key={serverUrl}
          titleId={titleId}
          bodyId={bodyId}
          serverName={serverName}
          serverUrl={serverUrl}
          onClose={onClose}
          onTrusted={onTrusted}
        />
      )}
    </Modal>
  );
}

function SheetBody({
  titleId,
  bodyId,
  serverName,
  serverUrl,
  onClose,
  onTrusted,
}: Omit<IdentityChangedSheetProps, 'open'> & { titleId: string; bodyId: string }) {
  const [change, setChange] = useState<IdentityChange | null>(null);
  const [words, setWords] = useState<Words | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const recorded = await loadIdentityChange(serverUrl);
        if (!live) return;
        if (!recorded) {
          setError(`Paracord has no record of a new identity for ${serverName}. Close this and try connecting again.`);
          return;
        }
        const [old, next] = await Promise.all([trustWords(recorded.pinnedFp), trustWords(recorded.presentedFp)]);
        if (!live) return;
        setChange(recorded);
        setWords({ old: formatTrustWords(old), next: formatTrustWords(next) });
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [serverUrl, serverName]);

  const trust = async () => {
    if (!change || busy) return;
    setBusy(true);
    setError(null);
    try {
      await acceptChangedIdentity(change);
      onTrusted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="ix-dialog" data-testid="identity-changed-sheet">
      <h2 id={titleId} className="ix-dialog__title">
        {serverName} has a new identity
      </h2>
      <p id={bodyId} className="ix-dialog__body">
        This server&rsquo;s words used to be{' '}
        <strong className="fr-idc__words" data-testid="identity-old-words">
          {words?.old ?? '…'}
        </strong>
        . Now they&rsquo;re{' '}
        <strong className="fr-idc__words" data-testid="identity-new-words">
          {words?.next ?? '…'}
        </strong>
        . That happens when the person who runs it reinstalls Paracord or replaces its certificate. It also happens
        when someone is trying to listen in. Ask them whether they changed something before you continue.
      </p>
      {error && (
        <p role="alert" className="ix-dialog__error">
          {error}
        </p>
      )}
      <div className="ix-dialog__actions fr-idc__actions">
        <CreamButton onClick={onClose}>Stay disconnected</CreamButton>
        <WideControl
          tone="danger"
          className="fr-idc__trust"
          disabled={!change || busy}
          onClick={() => void trust()}
        >
          Trust the new identity
        </WideControl>
      </div>
    </div>
  );
}
