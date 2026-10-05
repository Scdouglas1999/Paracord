import { useEffect, useState } from 'react';

import { guildApi } from '../../../api/guilds';
import { getVersionedStorageItem, setVersionedStorageItem } from '../../../lib/versionedStorage';

/**
 * The joiner welcome's one-time flag (docs/index-spec.md §8.3: `GuildWelcomeScreen`'s
 * "first visit"). The key is the old welcome screen's, so someone who dismissed it
 * before is not welcomed twice: `guild-welcomed:<guildId>` in the versioned storage.
 *
 * Per device, as it always was. The flag is read once when a conversation opens
 * (`isWelcomed`), so marking it while the welcome is on screen never changes the
 * words under the reader.
 */
const keyOf = (guildId: string) => `guild-welcomed:${guildId}`;

export function isWelcomed(guildId: string): boolean {
  try {
    return getVersionedStorageItem(keyOf(guildId), [keyOf(guildId)]) !== null;
  } catch {
    // Storage that cannot be read (a locked-down profile) welcomes nobody: the
    // welcome is a courtesy, and saying it on every visit would be a nag.
    return true;
  }
}

export function markWelcomed(guildId: string): void {
  try {
    setVersionedStorageItem(keyOf(guildId), '1');
  } catch {
    /* the courtesy is lost, nothing else */
  }
}

/** Whether this server has roles for a new member to pick, and the member has not finished onboarding. */
export interface OnboardingRoles {
  loaded: boolean;
  hasRoles: boolean;
}

/**
 * Asks the server's onboarding once (`GET /guilds/:id/onboarding/me`), only while
 * `enabled`. The joiner welcome offers "Pick roles" when onboarding has roles and
 * is not complete (a completed onboarding does not open again, so the card would
 * do nothing). A failed request says nothing: the card is simply not offered.
 */
export function useOnboardingRoles(guildId: string | null, enabled: boolean): OnboardingRoles {
  const [state, setState] = useState<{ guildId: string; hasRoles: boolean } | null>(null);
  useEffect(() => {
    if (!enabled || !guildId) return;
    let live = true;
    guildApi
      .getMyOnboardingState(guildId)
      .then(({ data }) => {
        if (!live) return;
        const options = data?.settings?.role_options;
        const roles = Array.isArray(options) && options.length > 0;
        setState({ guildId, hasRoles: roles && !data?.member_state?.completed_at });
      })
      .catch(() => {
        if (live) setState({ guildId, hasRoles: false });
      });
    return () => {
      live = false;
    };
  }, [enabled, guildId]);
  const mine = state && state.guildId === guildId ? state : null;
  return { loaded: mine !== null, hasRoles: Boolean(mine?.hasRoles) };
}
