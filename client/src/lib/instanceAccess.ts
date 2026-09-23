import type { RegistrationMode } from '../api/auth';

/**
 * The words for who can get into a Paracord server, shared by first-run setup,
 * the admin settings and the Invite dialog so all three say the same thing.
 */

export interface RegistrationChoice {
  id: RegistrationMode;
  label: string;
  hint: string;
}

export const REGISTRATION_CHOICES: ReadonlyArray<RegistrationChoice> = [
  {
    id: 'invite_only',
    label: 'People with an invite link',
    hint: 'Someone here has to send them an invite to one of your servers first. Recommended.',
  },
  {
    id: 'open',
    label: 'Anyone who can reach this server',
    hint: 'Anybody who finds the address can make an account.',
  },
];

/** What a person without an invite is told on an invite-only server. */
export const INVITE_ONLY_MESSAGE =
  'This server is invite-only. Ask the person who runs it for an invite link.';

/** The name of the admin switch, wherever another screen points at it. */
export const ROUTER_SETTING_LABEL = 'Let friends outside your home network connect';

/** The two ways a server can be reached. */
export function reachLabel(asksRouter: boolean): string {
  return asksRouter
    ? 'Reachable from the internet through your router'
    : 'Only reachable on your home network';
}

/** The key the invite page leaves the code under for the register page. */
export const PENDING_INVITE_KEY = 'paracord:pending-invite';

/** The invite a signed-out person arrived with, if any. Never throws. */
export function readPendingInvite(): string | null {
  try {
    const code = sessionStorage.getItem(PENDING_INVITE_KEY)?.trim();
    return code ? code : null;
  } catch {
    return null;
  }
}
