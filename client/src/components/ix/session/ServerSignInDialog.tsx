import { useEffect, useId, useState, type FormEvent } from 'react';

import { Button } from '../../ui/Button';
import { Modal, ModalBody, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '../../ui/Modal';
import { TextField } from '../../ui/TextField';
import { completeServerSecondFactor, serverSignInError, signInToServer } from '../../../lib/serverSignIn';
import { useServerListStore, type ServerEntry } from '../../../stores/serverListStore';
import { useServerConnectionPhase } from '../../../stores/serverConnectionStore';
import { useServerSignInDialog } from './serverSignInDialogStore';

/** What a server is called in a sentence: its name, else its address. */
export function serverDisplayName(server: Pick<ServerEntry, 'name' | 'url'> | null | undefined): string {
  const name = server?.name?.trim();
  if (name) return name;
  try {
    return server ? new URL(server.url).host : 'this server';
  } catch {
    return server?.url ?? 'this server';
  }
}

/**
 * "Sign in again" for one saved server (docs/index-spec.md §6.12 dialog): the
 * account's email or username and password, then its second factor when it has
 * one. On success the session lands on that server's entry and the server
 * connects; the dialog closes and the sidebar takes it from there.
 */
export function ServerSignInDialog() {
  const serverId = useServerSignInDialog((state) => state.serverId);
  const close = useServerSignInDialog((state) => state.close);
  const server = useServerListStore((state) => (serverId ? state.servers.find((entry) => entry.id === serverId) : undefined));
  const open = !!serverId && !!server;

  // A server removed while its dialog was open takes the dialog with it.
  useEffect(() => {
    if (serverId && !server) close();
  }, [serverId, server, close]);

  return (
    <Modal open={open} onClose={close} size="sm" labeledBy="ix-signin-title" describedBy="ix-signin-desc" zIndexClassName="z-[160]">
      {open && <SignInForm key={server.id} server={server} onDone={close} />}
    </Modal>
  );
}

function SignInForm({ server, onDone }: { server: ServerEntry; onDone: () => void }) {
  const name = serverDisplayName(server);
  const endedHere = useServerConnectionPhase(server.id)?.endedHere ?? false;
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const formId = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const step = ticket
        ? await completeServerSecondFactor(server.id, ticket, code)
        : await signInToServer(server.id, identifier, password);
      if (step.kind === 'second-factor') {
        setTicket(step.ticket);
        setCode('');
        return;
      }
      onDone();
    } catch (err) {
      setError(ticket ? 'That code did not work. Try the current one.' : serverSignInError(err, name));
    } finally {
      setBusy(false);
    }
  };

  const ready = ticket ? code.trim().length > 0 : identifier.trim().length > 0 && password.length > 0;

  return (
    <form id={formId} onSubmit={submit} data-testid="ix-signin-dialog" noValidate>
      <ModalHeader>
        <ModalTitle id="ix-signin-title">Sign in to {name}</ModalTitle>
        <ModalDescription id="ix-signin-desc">
          {ticket
            ? 'Enter the code from your authenticator app, or a backup code.'
            : endedHere
              ? `${name} ended your session. Sign in to connect again.`
              : `Sign in to connect to ${name}.`}
        </ModalDescription>
      </ModalHeader>
      <ModalBody className="flex flex-col gap-3">
        {ticket ? (
          <TextField
            label="Code"
            name="code"
            autoComplete="one-time-code"
            inputMode="numeric"
            autoFocus
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
        ) : (
          <>
            <TextField
              label="Email or username"
              name="identifier"
              autoComplete="username"
              autoFocus
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
            />
            <TextField
              label="Password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </>
        )}
        {error && (
          <p role="alert" className="text-[13px] leading-[1.4] text-[var(--ix-danger-ink)]">
            {error}
          </p>
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy} disabled={!ready || busy}>
          {ticket ? 'Verify' : 'Sign in'}
        </Button>
      </ModalFooter>
    </form>
  );
}
