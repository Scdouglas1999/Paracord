import { useId, useState, type ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Switch } from '../ui/Switch';
import { usePrivacySettings } from '../../hooks/usePrivacySettings';

/**
 * What the owner of a server sees about the machine itself. Absent for a
 * person who is only joining or using another host's server: those rows are
 * about this computer, so they are not shown (setup spec §1.10).
 */
export interface ProtectedHostRows {
  /** The copy for the stored-data row, by key source (§4.6). */
  storageCopy: string;
  /** "On" when stored data is encrypted. */
  storageOn: boolean;
  /** Registration is by invite link only. */
  inviteOnly: boolean;
  backups: {
    enabled: boolean;
    days: number;
    /** Rejects with an Error whose message is shown inline; the switch reverts. */
    onChange: (next: boolean) => Promise<void>;
  };
}

export interface ProtectedSheetProps {
  open: boolean;
  onClose: () => void;
  host?: ProtectedHostRows;
}

/**
 * "What's protected" (docs/setup-spec.md §1.10): the plain list of what is on
 * for everyone from the start, shared by the first run's "See what's
 * protected" and Settings › Privacy. Static rows say so; the rows with a
 * switch apply the moment they are flipped and revert with an inline reason if
 * the server refuses. The sheet only opens once the account exists, so every
 * switch has somewhere to write.
 */
export function ProtectedSheet({ open, onClose, host }: ProtectedSheetProps) {
  const titleId = useId();
  const descId = useId();
  const privacy = usePrivacySettings();
  const [backupBusy, backupError, setBackup] = useBackupToggle(host?.backups.onChange);

  const linkPreviewsDisabled =
    !privacy.loaded || !privacy.linkPreviewsSupported || privacy.linkPreviewsServerOff;
  const linkPreviewsNote = privacy.linkPreviewsServerOff
    ? 'Turned off on this server.'
    : !privacy.linkPreviewsSupported && privacy.loaded
      ? 'This server has not been updated to support it yet.'
      : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      labeledBy={titleId}
      describedBy={descId}
      panelClassName="!bg-[var(--ix-pop-solid)] w-[560px] rounded-[24px] px-[26px] pb-5 pt-6"
    >
      <h2 id={titleId} className="m-0 text-[22px] font-[620] leading-tight tracking-[-0.02em] text-[var(--ix-ink)]">
        What&rsquo;s protected
      </h2>
      <p id={descId} className="mb-3.5 mt-1.5 text-[14px] leading-normal text-[var(--ix-ink-3)]">
        These are on for everyone from the start. You can change the ones with a switch later in Settings.
      </p>

      <div data-testid="protected-rows">
        <Row
          title="Private messages"
          detail="End-to-end encrypted. Only the people in the chat can read them."
          right={<Locked>Always on</Locked>}
        />
        <Row
          title="Voice, video and screen share"
          detail="End-to-end encrypted on every call."
          right={<Locked>Always on</Locked>}
        />
        {host && (
          <>
            <Row
              title="Stored messages and files"
              detail={host.storageCopy}
              right={host.storageOn ? <Locked>On</Locked> : <Plain>Off</Plain>}
            />
            <Row
              title="Who can join"
              detail={
                host.inviteOnly
                  ? 'Only people with an invite link you made.'
                  : 'Anyone with the address can make an account.'
              }
              right={<Plain>{host.inviteOnly ? 'Invite only' : 'Open'}</Plain>}
            />
          </>
        )}
        <Row
          title="Link previews"
          detail="The server fetches them, so websites never see your address."
          note={linkPreviewsNote}
          error={privacy.errors.linkPreviews}
          right={
            <Switch
              checked={privacy.linkPreviews && !privacy.linkPreviewsServerOff}
              onChange={(next) => void privacy.setLinkPreviews(next)}
              disabled={linkPreviewsDisabled || privacy.busy.linkPreviews !== undefined}
              label="Link previews"
            />
          }
        />
        <Row
          title="Show what I'm playing"
          detail="Off until you turn it on."
          error={privacy.errors.activity}
          right={
            <Switch
              checked={privacy.activity}
              onChange={(next) => void privacy.setActivity(next)}
              disabled={!privacy.loaded || privacy.busy.activity !== undefined}
              label="Show what I'm playing"
            />
          }
        />
        {host && (
          <Row
            title="Daily backups"
            detail={`Kept on this computer for ${host.backups.days} days.`}
            error={backupError}
            right={
              <Switch
                checked={host.backups.enabled}
                onChange={(next) => void setBackup(next)}
                disabled={backupBusy}
                label="Daily backups"
              />
            }
          />
        )}
      </div>

      <Button className="mt-3.5 w-full justify-center" onClick={onClose} autoFocus>
        Done
      </Button>
    </Modal>
  );
}

function Row({
  title,
  detail,
  note,
  error,
  right,
}: {
  title: string;
  detail: string;
  note?: string | null;
  error?: string;
  right: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-x-4 border-t border-[var(--ix-line)] py-2.5">
      <div className="min-w-0">
        <div className="text-[14.5px] font-semibold text-[var(--ix-ink)]">{title}</div>
        <div className="text-[12.5px] leading-[1.45] text-[var(--ix-ink-3)]">{detail}</div>
        {note && <div className="text-[12.5px] leading-[1.45] text-[var(--ix-ink-2)]">{note}</div>}
        {error && (
          <div role="alert" className="text-[12.5px] leading-[1.45] text-[var(--ix-danger-ink)]">
            {error}
          </div>
        )}
      </div>
      <div className="flex items-center justify-end">{right}</div>
    </div>
  );
}

function Locked({ children }: { children: ReactNode }) {
  return (
    <span className="flex items-center gap-[5px] text-[12px] font-semibold text-accent-success">
      <Lock size={14} aria-hidden />
      {children}
    </span>
  );
}

function Plain({ children }: { children: ReactNode }) {
  return <span className="text-[12px] font-semibold text-accent-success">{children}</span>;
}


/** Busy and error state around a host-supplied async toggle. */
function useBackupToggle(onChange: ((next: boolean) => Promise<void>) | undefined) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const run = async (next: boolean) => {
    if (!onChange) return;
    setBusy(true);
    setError(undefined);
    try {
      await onChange(next);
    } catch (err) {
      setError(`Couldn't save that. ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };
  return [busy, error, run] as const;
}
