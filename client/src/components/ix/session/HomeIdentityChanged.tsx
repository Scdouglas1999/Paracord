import { useState } from 'react';

import { gateway } from '../../../gateway/manager';
import { configuredHomeServerUrl } from '../../../lib/serverIdentity';
import { pinHostFromUrl, resyncTrust, useIdentityChangeStore, type IdentityChange } from '../../../lib/trustedHosts';
import { useAuthStore } from '../../../stores/authStore';
import { useServerConnectionStore } from '../../../stores/serverConnectionStore';
import { LOCAL_SERVER_ID } from '../../../lib/serverScope';
import { CordMark } from '../../brand/CordMark';
import { IdentityChangedSheet } from '../../firstRun/IdentityChangedSheet';
import { Button } from '../../ui/Button';
import { serverDisplayName } from './ServerSignInDialog';

/**
 * The identity change recorded for the home server (the one the first run joined
 * or set up, `__local__`), or null. The home server has no entry in the server
 * list, so this is how the banner and the launch screen find it.
 */
export function useHomeIdentityChange(): { url: string; change: IdentityChange } | null {
  const changes = useIdentityChangeStore((state) => state.changes);
  const url = configuredHomeServerUrl();
  const host = url ? pinHostFromUrl(url) : null;
  const change = host ? changes[host] ?? null : null;
  return url && change ? { url, change } : null;
}

/** What the home server is called in a sentence: its address (it has no saved name). */
export function homeServerName(url: string): string {
  return serverDisplayName({ name: '', url });
}

/**
 * The home server presented a certificate other than the one pinned for it, and
 * there is no session to open the app with (docs/setup-spec.md §7.4): at launch
 * the refresh is refused by the pin, so the app used to fall through to the
 * sign-in screen, where every attempt failed with "Could not reach". This says
 * what happened and holds: **Review** opens the identity-changed sheet, **Stay
 * disconnected** leaves this screen up, and **Trust the new identity** re-pins
 * the host and restores the session.
 */
export function HomeIdentityChanged({ url }: { url: string }) {
  const [reviewing, setReviewing] = useState(false);
  const name = homeServerName(url);
  return (
    <div
      className="flex min-h-screen w-full flex-col items-center justify-center gap-5 bg-bg-base px-6"
      data-testid="home-identity-changed"
    >
      <div className="flex w-full max-w-md flex-col items-start gap-4">
        <CordMark size={40} label="Paracord" />
        <div className="flex flex-col gap-1.5">
          <h1 className="font-display text-heading text-text-primary">{name} has a new identity</h1>
          <p className="text-label leading-relaxed text-text-secondary" role="status">
            It stays disconnected until you review it.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setReviewing(true)}>Review</Button>
        </div>
      </div>
      <IdentityChangedSheet
        open={reviewing}
        serverName={name}
        serverUrl={url}
        onClose={() => setReviewing(false)}
        onTrusted={() => {
          setReviewing(false);
          void restoreHomeSession();
        }}
      />
    </div>
  );
}

/**
 * After **Trust the new identity** on the launch screen: run session bootstrap
 * again (the refresh the pin refused at launch), behind the "Restoring session"
 * splash, once the shell has verified the server with its new pin, then connect.
 */
async function restoreHomeSession(): Promise<void> {
  useServerConnectionStore.getState().forget(LOCAL_SERVER_ID);
  useAuthStore.setState({ sessionBootstrapComplete: false });
  await resyncTrust().catch(() => undefined);
  await useAuthStore.getState().initializeSession();
  await gateway.connectAll().catch(() => undefined);
}
