import { useId, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

import { removeConfirmed } from '../../lib/host/settingsView';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Modal, ModalBody, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '../ui/Modal';

/** What "delete" asks to be typed when the server's name isn't known (no owned server is loaded). */
const FALLBACK_WORD = 'delete';

/**
 * **Remove from this computer** (docs/setup-spec.md §2.9): removes the
 * background service; the data is kept unless "Also delete the server's data"
 * is checked, and that needs the server's name typed. The dialog says exactly
 * what each choice keeps and deletes (`paracord-hostctl` `Host::remove`:
 * keeping leaves the whole folder and the keychain entry, so setting it up
 * again here brings it back as it was; deleting removes the folder with its
 * backups and the storage key from the keychain).
 *
 * The parent gives it a new `key` each time it opens, so every opening starts
 * with the data kept and nothing typed.
 */
export function RemoveHostDialog({
  open,
  serverName,
  onClose,
  onRemove,
}: {
  open: boolean;
  /** The hosted server's name, or null when it isn't known. */
  serverName: string | null;
  onClose: () => void;
  /** Rejects with the reason it couldn't be removed. */
  onRemove: (deleteData: boolean) => Promise<void>;
}) {
  const titleId = useId();
  const descId = useId();
  const typedId = useId();
  const [deleteData, setDeleteData] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const name = serverName ?? 'your server';
  const word = serverName ?? FALLBACK_WORD;
  const ready = removeConfirmed(deleteData, typed, word);

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onRemove(deleteData);
      onClose();
    } catch (err) {
      setError(`It wasn't removed: ${err instanceof Error ? err.message : String(err)}`);
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      role="alertdialog"
      size="md"
      zIndexClassName="z-[160]"
      labeledBy={titleId}
      describedBy={descId}
    >
      <div data-testid="host-remove-dialog">
        <ModalHeader
          icon={
            <div className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-[var(--ix-danger-fill)] text-[var(--ix-danger-ink)]">
              <AlertTriangle size={20} aria-hidden />
            </div>
          }
        >
          <ModalTitle id={titleId}>Remove Paracord from this computer?</ModalTitle>
          <ModalDescription id={descId}>
            This stops {name} and takes it out of what starts when you sign in. Until it is set up again, nobody can reach it, you included, and
            invite links to it stop working.
          </ModalDescription>
        </ModalHeader>
        <ModalBody>
          {!deleteData && (
            <div className="ix-host-remove__kept" data-testid="host-remove-kept">
              <b>Kept on this computer:</b> its messages, files and accounts, the backups of the last 14 days, and the key that unlocks them in your
              system keychain. Set it up again from this app and it comes back as it was.
            </div>
          )}

          <label className="ix-host-remove__check" data-first={deleteData || undefined}>
            <input
              type="checkbox"
              className="pc-checkbox"
              checked={deleteData}
              onChange={(e) => {
                setDeleteData(e.target.checked);
                setTyped('');
              }}
              disabled={busy}
              data-testid="host-remove-delete"
            />
            <span>Also delete the server&rsquo;s data</span>
          </label>

          {deleteData && (
            <div className="ix-host-remove__danger" data-testid="host-remove-danger">
              <p>
                This deletes {name}&rsquo;s messages, files and everyone&rsquo;s accounts on it, the backups kept on this computer, and its storage key.
                It can&rsquo;t be undone. A backup you copied somewhere else can still be restored with your recovery phrase.
              </p>
              <label htmlFor={typedId} className="ix-host-remove__label">
                Type <b>{word}</b> to confirm
              </label>
              <Input
                id={typedId}
                className="mt-1.5"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                data-testid="host-remove-typed"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submit();
                }}
              />
            </div>
          )}

          {error && (
            <p className="ix-host-note" data-tone="fail" role="alert">
              {error}
            </p>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy} autoFocus>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void submit()} disabled={!ready} loading={busy} data-testid="host-remove-confirm">
            {deleteData ? 'Remove and delete its data' : 'Remove'}
          </Button>
        </ModalFooter>
      </div>
    </Modal>
  );
}
