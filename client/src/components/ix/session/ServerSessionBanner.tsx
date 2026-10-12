import { useState } from 'react';

import { gateway } from '../../../gateway/manager';
import { useAuthStore } from '../../../stores/authStore';
import { useServerConnectionStore } from '../../../stores/serverConnectionStore';
import { useServerListStore } from '../../../stores/serverListStore';
import { BannerStrip } from '../conversation/BannerStrip';
import { IdentityChangedSheet } from '../../firstRun/IdentityChangedSheet';
import { serverDisplayName } from './ServerSignInDialog';
import { useServerSignInDialog } from './serverSignInDialogStore';

/**
 * A saved server ended your session while you were using the app (docs/index-spec.md
 * §6.8 strip): say which one, and offer to sign in to it again. One strip per
 * server, plain tone, in the banner stack; it goes when the server connects.
 *
 * Only while some session is still live: with none left the app is on the sign-in
 * screen, which says it for the home server itself.
 *
 * A saved server whose certificate changed while you were using it (docs/setup-spec.md
 * §7.4) gets a strip too, with Review: its places are still on screen from before, so
 * the sidebar's "Identity changed" state may not be showing.
 */
export function ServerSessionBanner() {
  const phases = useServerConnectionStore((state) => state.servers);
  const servers = useServerListStore((state) => state.servers);
  const homeToken = useAuthStore((state) => state.token);
  const open = useServerSignInDialog((state) => state.open);
  const [reviewing, setReviewing] = useState<string | null>(null);

  const live = !!homeToken || servers.some((server) => !!server.token);
  if (!live) return null;
  const ended = servers.filter((server) => {
    const phase = phases[server.id];
    return phase?.phase === 'signed-out' && phase.endedHere;
  });
  const changed = servers.filter((server) => phases[server.id]?.phase === 'identity-changed');
  const review = changed.find((server) => server.id === reviewing) ?? null;
  if (ended.length === 0 && changed.length === 0) return null;

  return (
    <>
      {changed.map((server) => (
        <BannerStrip
          key={`identity-${server.id}`}
          data-testid="ix-banner-identity-changed"
          className="pc-banner-in"
          action={{ label: 'Review', onPress: () => setReviewing(server.id) }}
        >
          {`${serverDisplayName(server)} has a new identity. It stays disconnected until you review it.`}
        </BannerStrip>
      ))}
      <IdentityChangedSheet
        open={!!review}
        serverName={review ? serverDisplayName(review) : ''}
        serverUrl={review?.url ?? ''}
        onClose={() => setReviewing(null)}
        onTrusted={() => {
          const id = review?.id;
          setReviewing(null);
          if (id) void gateway.retryServer(id);
        }}
      />
      {ended.map((server) => (
        <BannerStrip
          key={server.id}
          data-testid="ix-banner-signed-out"
          className="pc-banner-in"
          action={{ label: 'Sign in again', onPress: () => open(server.id) }}
        >
          {`You’re signed out of ${serverDisplayName(server)}.`}
        </BannerStrip>
      ))}
    </>
  );
}
