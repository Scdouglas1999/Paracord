import { useId, type ReactNode } from 'react';

import { Modal } from '../ui/Modal';
import { GoButton } from './primitives';

/** `zIndexClassName`: "z-[160]" when the sheet opens over Settings (a windowed overlay at z-[150]). */
function FrSheet({ open, onClose, title, sub, children, done = 'Got it', testId, zIndexClassName }: { open: boolean; onClose: () => void; title: string; sub: ReactNode; children?: ReactNode; done?: string; testId: string; zIndexClassName?: string }) {
  const titleId = useId();
  const subId = useId();
  return (
    <Modal open={open} onClose={onClose} labeledBy={titleId} describedBy={subId} panelClassName="fr-sheet" size="auto" zIndexClassName={zIndexClassName}>
      <div data-testid={testId}>
        <h3 id={titleId}>{title}</h3>
        <p id={subId} className="fr-sheet__sub">
          {sub}
        </p>
        {children}
        <GoButton type="button" arrow={false} className="fr-go--full" onClick={onClose} autoFocus>
          {done}
        </GoButton>
      </div>
    </Modal>
  );
}

/**
 * "Let friends in" (docs/setup-spec.md §1.11): the router refused or did not
 * answer; three plain steps with this network's own numbers.
 */
export function RouterSheet({
  open,
  onClose,
  variant,
  gatewayIp,
  lanIp,
  port,
  zIndexClassName,
}: {
  open: boolean;
  onClose: () => void;
  variant: 'refused' | 'no_answer';
  gatewayIp: string | null;
  lanIp: string | null;
  port: number;
  zIndexClassName?: string;
}) {
  return (
    <FrSheet
      open={open}
      onClose={onClose}
      zIndexClassName={zIndexClassName}
      testId="fr-router-sheet"
      title="Let friends in"
      sub={`${variant === 'no_answer' ? "Your router didn't answer the automatic setup." : 'Your router blocked the automatic setup.'} You can open the way yourself in about two minutes.`}
    >
      <div className="fr-howto">
        <ol>
          <li>
            {gatewayIp ? (
              <>
                Open your router&rsquo;s page at <code>{gatewayIp}</code> and sign in.
              </>
            ) : (
              <>
                Open your router&rsquo;s page (usually <code>192.168.0.1</code> or <code>192.168.1.1</code>) and sign in.
              </>
            )}{' '}
            The password is often on a sticker on the router.
          </li>
          <li>
            Find <b>Port forwarding</b>. It is sometimes under Advanced or NAT.
          </li>
          <li>
            Forward port <code>{port}</code>, both TCP and UDP, to this computer{lanIp ? (
              <>
                : <code>{lanIp}</code>
              </>
            ) : null}
            .
          </li>
        </ol>
      </div>
      <p className="fr-sheet__after">Paracord checks again every minute and tells you when friends can get in. Until then, people on your home network can still join.</p>
    </FrSheet>
  );
}

/**
 * The shared-address sheet (§5.4 "What can I do?"): the internet connection
 * has no public address of its own, so no port on this router helps alone.
 */
export function SharedAddressSheet({ open, onClose, port, zIndexClassName }: { open: boolean; onClose: () => void; port: number; zIndexClassName?: string }) {
  return (
    <FrSheet
      open={open}
      onClose={onClose}
      zIndexClassName={zIndexClassName}
      testId="fr-shared-sheet"
      title="Friends outside can't reach you yet"
      sub="Your internet connection shares its public address with other customers, or another router sits in front of yours. Paracord can't open a way through that on its own."
    >
      <div className="fr-howto">
        <ul>
          <li>
            Ask your internet provider for a <b>public IPv4 address</b>. Some give one on request, sometimes for a small fee.
          </li>
          <li>
            If there is a second router in front of yours (a provider&rsquo;s box and your own), forward port <code>{port}</code>, TCP and UDP, on that one too, to your router.
          </li>
        </ul>
      </div>
      <p className="fr-sheet__after">Until then, people on your home network can join. Paracord checks again every minute.</p>
    </FrSheet>
  );
}

/** "Show details" on a failed row: the end of the server's log (§2.8). */
export function DetailsSheet({ open, onClose, text }: { open: boolean; onClose: () => void; text: string }) {
  return (
    <FrSheet open={open} onClose={onClose} testId="fr-details-sheet" title="What happened" sub="The last lines Paracord on this computer wrote. Passwords and keys are never in it." done="Close">
      <pre className="fr-details">{text || 'Nothing was written.'}</pre>
    </FrSheet>
  );
}
