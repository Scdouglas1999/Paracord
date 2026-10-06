import { useAuthStore } from '../../../stores/authStore';
import { useServerConnectionStore } from '../../../stores/serverConnectionStore';
import { useServerListStore } from '../../../stores/serverListStore';
import { BannerStrip } from '../conversation/BannerStrip';
import { serverDisplayName } from './ServerSignInDialog';
import { useServerSignInDialog } from './serverSignInDialogStore';

/**
 * A saved server ended your session while you were using the app (docs/index-spec.md
 * §6.8 strip): say which one, and offer to sign in to it again. One strip per
 * server, plain tone, in the banner stack; it goes when the server connects.
 *
 * Only while some session is still live: with none left the app is on the sign-in
 * screen, which says it for the home server itself.
 */
export function ServerSessionBanner() {
  const phases = useServerConnectionStore((state) => state.servers);
  const servers = useServerListStore((state) => state.servers);
  const homeToken = useAuthStore((state) => state.token);
  const open = useServerSignInDialog((state) => state.open);

  const live = !!homeToken || servers.some((server) => !!server.token);
  if (!live) return null;
  const ended = servers.filter((server) => {
    const phase = phases[server.id];
    return phase?.phase === 'signed-out' && phase.endedHere;
  });
  if (ended.length === 0) return null;

  return (
    <>
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
