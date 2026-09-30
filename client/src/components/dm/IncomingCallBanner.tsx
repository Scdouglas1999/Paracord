import { useMemo } from 'react';
import { useNavigate } from 'react-router';

import { GlassButton, Kicker } from '../glass/primitives';
import { FaceStack } from '../glass/places/Lead';
import { useIncomingDmCall } from '../../hooks/useIncomingDmCall';
import { useVoice } from '../../hooks/useVoice';
import { displayName } from '../../lib/displayName';
import { usePresence } from '../../lib/motion';
import { cn } from '../../lib/utils';
import { useAuthStore } from '../../stores/authStore';
import { useVoiceStore } from '../../stores/voiceStore';

/**
 * Somebody is calling you in a direct message (QA D6).
 *
 * The call itself always worked; the callee's window simply said nothing — to
 * answer you had to press the same phone button the caller had, labeled "Start
 * direct message voice call". This is the surface that was missing: who is
 * calling, Join, and Decline.
 *
 * In Glass a call is live, so it is the call pill's own kind of object
 * (docs/glass-spec.md §5): a near-black capsule with the faint amber glow, the
 * caller's face, the words, Decline as text and Join as the one cream button.
 * It arrives on the shared `pc-banner-in` recipe (one motion, one reduced-motion
 * switch, via `usePresence`) and leaves the same way the moment the caller
 * hangs up. Decline is a local dismissal — nothing is sent, the caller is told
 * nothing, and the next call from the same person rings again.
 *
 * It does not position itself. `BannerStack` stacks it under the connection bar
 * and reserves its height at the top of the app shell, because when it fixed
 * itself to `top: 0` it covered the search field and the entire conversation
 * header for as long as the call rang. The capsule carries its own air (see
 * `.glass-callbanner`), so the reserved height is the capsule and its margin.
 */
export function IncomingCallBanner() {
  const { call, decline } = useIncomingDmCall();
  const { joinChannel } = useVoice();
  const navigate = useNavigate();
  const { mounted, exiting, scenery } = usePresence(Boolean(call));
  const selfUserId = useAuthStore((state) => state.user?.id ?? null);
  const participants = useVoiceStore((state) => (call ? state.channelParticipants.get(call.channelId) : undefined));

  // The people on the other end, as faces. A DM voice state carries no guild.
  const faces = useMemo(
    () =>
      (participants ?? [])
        .filter((state) => !state.guild_id && state.user_id !== selfUserId)
        .slice(0, 3)
        .map((state) => ({ userId: state.user_id, name: displayName(state), avatar: state.avatar_hash ?? null })),
    [participants, selfUserId],
  );

  if (!mounted || !call) return null;

  const answer = () => {
    navigate(`/app/dms/${call.channelId}`);
    void joinChannel(call.channelId, 'dm');
  };

  const words =
    call.participantCount > 2 ? `${call.callerName} are in a call` : `${call.callerName} is calling you`;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={cn('glass-callbanner', exiting ? 'pc-banner-out' : 'pc-banner-in')}
      {...scenery}
    >
      <div className="glass-callbanner__pill">
        {faces.length > 0 && <FaceStack faces={faces} size={36} overlap={10} />}
        <span className="glass-callbanner__text">
          <Kicker as="span" tone="amber" className="glass-callbanner__kicker">
            Live call
          </Kicker>
          <span className="glass-callbanner__who">{words}</span>
        </span>
        <span className="glass-callbanner__actions">
          <GlassButton variant="text" onClick={decline}>
            Decline
          </GlassButton>
          <GlassButton variant="primary" onClick={answer}>
            Join
          </GlassButton>
        </span>
      </div>
    </div>
  );
}
