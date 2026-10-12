import { create } from 'zustand';

import { openAddServer } from '../components/ix/dock/addServerStore';
import { useAuthStore } from '../stores/authStore';
import { useServerListStore } from '../stores/serverListStore';
import { toast } from '../stores/toastStore';
import { getStoredServerUrl } from './config/apiBaseUrl';
import { parseInviteLink, type InviteLink } from './inviteLinks';
import { sameServerUrl } from './serverScope';
import { isTauri } from './tauriEnv';

/**
 * `paracord://` links, from the operating system (setup-spec §6.4).
 *
 * The desktop shell queues every link it receives until the webview asks
 * (`take_pending_deep_links`, so a link that launched the app is not lost) and
 * emits a `deep-link` event for links that arrive afterwards. `installDeepLinks`
 * attaches the listener first and then drains the queue, so a link cannot fall
 * between the two.
 *
 * Where a link goes:
 *   invite, first run active or no servers  -> first-run join step
 *       (`FIRST_RUN_JOIN_PATH`), with the invite left in `useDeepLinkIntake`
 *   invite, otherwise                        -> Add a server sheet, Join tab,
 *       with the link filled in
 *   server (`paracord://server/<host>`)      -> sign-in with the server left in
 *       `useDeepLinkIntake` (`FIRST_RUN_SIGN_IN_PATH`)
 *   anything else                            -> toast, nothing else happens
 *
 * ENTRY POINT FOR THE FIRST-RUN SCREENS (S13): the join step reads
 * `useDeepLinkIntake.getState().takeInvite()` when it mounts (and subscribes
 * for one that arrives while it is open); the sign-in step does the same with
 * `takeServer()`. Both are the only handoff, so the screens work the same
 * whether the link arrived before they mounted or after. The two path
 * constants below are the routes to repoint if the route table changes. The
 * first-run test itself can be widened with `setFirstRunProbe`.
 */

export const FIRST_RUN_JOIN_PATH = '/welcome/join/invite';
/** Until the first-run sign-in step exists this is the server screen that already takes a server. */
export const FIRST_RUN_SIGN_IN_PATH = '/connect';

const DEEP_LINK_EVENT = 'deep-link';
export const UNKNOWN_LINK_MESSAGE = "That link isn't a Paracord invite.";

interface DeepLinkIntakeState {
  invite: InviteLink | null;
  /** A server base URL from `paracord://server/<host>`. */
  server: string | null;
  setInvite: (invite: InviteLink) => void;
  setServer: (serverUrl: string) => void;
  /** Read and clear the waiting invite. */
  takeInvite: () => InviteLink | null;
  /** Read and clear the waiting server. */
  takeServer: () => string | null;
}

export const useDeepLinkIntake = create<DeepLinkIntakeState>()((set, get) => ({
  invite: null,
  server: null,
  setInvite: (invite) => set({ invite }),
  setServer: (server) => set({ server }),
  takeInvite: () => {
    const { invite } = get();
    if (invite) set({ invite: null });
    return invite;
  },
  takeServer: () => {
    const { server } = get();
    if (server) set({ server: null });
    return server;
  },
}));

let firstRunProbe: (() => boolean) | null = null;

/** The first-run screens say when they are showing, in addition to the default test. */
export function setFirstRunProbe(probe: (() => boolean) | null): void {
  firstRunProbe = probe;
}

/** First run is active, or there is nothing yet to add a server to. */
export function isFirstRunForLinks(): boolean {
  if (firstRunProbe?.()) return true;
  return (
    useServerListStore.getState().servers.length === 0 &&
    !useAuthStore.getState().token &&
    !getStoredServerUrl()
  );
}

/** Move the router without a reference to it (this runs before the router mounts). */
function navigateTo(path: string): void {
  const idx = ((window.history.state as { idx?: number } | null)?.idx ?? 0) + 1;
  window.history.pushState({ usr: null, key: `deep-link-${idx}`, idx }, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** `paracord://server/<host>` to a checked server base URL, or null. */
export function parseServerLink(link: string): string | null {
  const match = /^paracord:\/\/server\/([^?#]+)/i.exec(link.trim());
  if (!match) return null;
  let host: string;
  try {
    host = decodeURIComponent(match[1]).replace(/\/+$/, '');
  } catch {
    return null;
  }
  // The invite parser owns what a server address may look like (scheme, loopback
  // rule, no credentials); borrow its check instead of keeping a second one.
  return parseInviteLink(`${host}/invite/x`)?.serverUrl ?? null;
}

/** Wait for the saved servers and their sessions to load, so "no servers" is true. */
function whenHydrated(): Promise<void> {
  if (useServerListStore.getState().tokensHydrated) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = useServerListStore.subscribe((state) => {
      if (!state.tokensHydrated) return;
      unsubscribe();
      resolve();
    });
  });
}

/** Act on one link. Never throws for a link it cannot read: it says so. */
export async function routeDeepLink(url: string): Promise<void> {
  const serverUrl = parseServerLink(url);
  if (serverUrl) {
    await whenHydrated();
    const saved = useServerListStore.getState().servers.find((s) => sameServerUrl(s.url, serverUrl));
    if (saved) {
      toast.info(`${saved.name || new URL(serverUrl).host} is already in your servers.`);
      return;
    }
    useDeepLinkIntake.getState().setServer(serverUrl);
    navigateTo(FIRST_RUN_SIGN_IN_PATH);
    return;
  }

  const invite = parseInviteLink(url);
  if (!invite) {
    toast.info(UNKNOWN_LINK_MESSAGE);
    return;
  }
  await whenHydrated();
  if (isFirstRunForLinks()) {
    useDeepLinkIntake.getState().setInvite(invite);
    navigateTo(FIRST_RUN_JOIN_PATH);
    return;
  }
  openAddServer('join', `${invite.serverUrl}/invite/${invite.code}`);
}

let installed: Promise<void> | null = null;

/**
 * Install once, in `main.tsx`. Desktop only. Listener first, then the drain:
 * a link the shell receives from here on is emitted, one it received earlier
 * is in the queue. Failures are thrown to the caller (the entry file), which
 * lets the global handler record them; a link is never dropped silently.
 */
export function installDeepLinks(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  installed ??= (async () => {
    const [{ listen }, { invoke }] = await Promise.all([
      import('@tauri-apps/api/event'),
      import('@tauri-apps/api/core'),
    ]);
    await listen<string>(DEEP_LINK_EVENT, (event) => {
      void routeDeepLink(event.payload);
    });
    const waiting = await invoke<string[]>('take_pending_deep_links');
    for (const url of waiting) void routeDeepLink(url);
  })();
  return installed;
}
