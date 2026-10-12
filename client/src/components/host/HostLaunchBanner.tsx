import { useState } from 'react';

import { useHostStore } from '../../stores/hostStore';
import { BannerStrip } from '../ix/conversation/BannerStrip';
import { Modal, ModalBody, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '../ui/Modal';
import { Button } from '../ui/Button';
import './hostLaunch.css';
import { hostLaunchView, type HostLaunchAction, type RollbackState } from './hostLaunchView';

/**
 * The strip the app shows when "Paracord on this computer" didn't come back
 * after an update, or can't start (docs/setup-spec.md §2.8), from the result
 * of `useHostStore.onLaunch()`, which `App` runs once on the desktop. An
 * Index banner strip (index-spec §6.8) in the app's banner stack; **Show
 * details** opens the last 200 lines of the server's log.
 */
export function HostLaunchBanner() {
  const launch = useHostStore((s) => s.launch);
  const [rollback, setRollback] = useState<RollbackState>({ kind: 'idle' });
  const [starting, setStarting] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [details, setDetails] = useState<string | null>(null);

  const view = hostLaunchView(launch, rollback, starting);
  if (!view && details === null) return null;

  const act = async (action: HostLaunchAction) => {
    const host = useHostStore.getState();
    switch (action) {
      case 'details':
        setDetails(await host.logsTail(200).catch((error: unknown) => (error instanceof Error ? error.message : String(error))));
        return;
      case 'rollback': {
        setRollback({ kind: 'running' });
        const ok = await host.rollbackUpdate();
        setRollback(ok ? { kind: 'done' } : { kind: 'failed', error: useHostStore.getState().error ?? 'it stopped without saying why' });
        return;
      }
      case 'start': {
        setStarting(true);
        const ok = await host.start();
        setStarting(false);
        // Started: read the launch state again, so the strip goes away (or says what is still wrong).
        if (ok) await host.onLaunch();
        return;
      }
      case 'dismiss':
        if (view) setDismissed(view.id);
    }
  };

  return (
    <>
      {view && dismissed !== view.id && (
        <BannerStrip
          key={view.id}
          className="pc-banner-in"
          tone={view.tone}
          role={view.role}
          data-testid="ix-banner-launch"
          data-state={view.id}
          action={view.primary ? { label: view.primary.label, disabled: view.primary.disabled, onPress: () => void act(view.primary!.action) } : undefined}
          onDismiss={view.dismissable ? () => void act('dismiss') : undefined}
        >
          {view.text}
          {view.details && (
            <>
              {' '}
              <button type="button" className="ix-banner-strip__action" onClick={() => void act('details')} data-testid="ix-banner-launch-details">
                Show details
              </button>
            </>
          )}
        </BannerStrip>
      )}
      <Modal open={details !== null} onClose={() => setDetails(null)} size="lg" labeledBy="ix-host-log-title" describedBy="ix-host-log-desc">
        <ModalHeader>
          <ModalTitle id="ix-host-log-title">What happened</ModalTitle>
          <ModalDescription id="ix-host-log-desc">The last lines Paracord on this computer wrote. Passwords and keys are never in it.</ModalDescription>
        </ModalHeader>
        <ModalBody>
          <pre className="ix-host-log" data-testid="ix-host-log">
            {details || 'Nothing was written.'}
          </pre>
        </ModalBody>
        <ModalFooter>
          <Button variant="primary" onClick={() => setDetails(null)} autoFocus>
            Close
          </Button>
        </ModalFooter>
      </Modal>
    </>
  );
}
