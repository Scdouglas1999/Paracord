import { useNavigate } from 'react-router';
import { Phone, PhoneOff } from 'lucide-react';

import { useIncomingDmCall } from '../../hooks/useIncomingDmCall';
import { useVoice } from '../../hooks/useVoice';
import { usePresence } from '../../lib/motion';
import { cn } from '../../lib/utils';

/**
 * Somebody is calling you in a direct message (QA D6).
 *
 * The call itself always worked; the callee's window simply said nothing — to
 * answer you had to press the same phone button the caller had, labelled "Start
 * direct message voice call". This is the surface that was missing: who is
 * calling, Join, and Decline.
 *
 * It is a compact banner rather than a full-screen ring: §5 says only light and
 * the things people do move, so it arrives on the shared `pc-banner-in` recipe
 * (one motion, one reduced-motion switch, via `usePresence`) and leaves the same
 * way the moment the caller hangs up. Decline is a local dismissal — nothing is
 * sent, the caller is told nothing, and the next call from the same person rings
 * again.
 */
export function IncomingCallBanner() {
  const { call, decline } = useIncomingDmCall();
  const { joinChannel } = useVoice();
  const navigate = useNavigate();
  const { mounted, exiting, scenery } = usePresence(Boolean(call));

  if (!mounted || !call) return null;

  const answer = () => {
    navigate(`/app/dms/${call.channelId}`);
    void joinChannel(call.channelId, 'dm');
  };

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={cn(
        'fixed inset-x-0 top-0 z-[9999] flex flex-wrap items-center justify-center gap-x-3 gap-y-2 px-4 py-2',
        exiting ? 'pc-banner-out' : 'pc-banner-in',
      )}
      style={{
        backgroundColor: 'color-mix(in srgb, var(--accent-success) 16%, var(--bg-raised))',
        borderBottom: '1px solid color-mix(in srgb, var(--accent-success) 45%, transparent)',
        boxShadow: 'var(--shadow-lifted)',
      }}
      {...scenery}
    >
      <Phone size={15} aria-hidden style={{ color: 'var(--accent-success)' }} />
      <span className="min-w-0 truncate text-label" style={{ color: 'var(--accent-success)' }}>
        {call.participantCount > 2
          ? `${call.callerName} are in a call`
          : `${call.callerName} is calling you`}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={answer}
          className="pc-focusable inline-flex h-7 items-center gap-1.5 rounded-chip bg-accent-success px-2.5 text-meta font-semibold text-text-on-accent transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-accent-success/85"
        >
          <Phone size={12} aria-hidden />
          Join
        </button>
        <button
          type="button"
          onClick={decline}
          className="pc-focusable inline-flex h-7 items-center gap-1.5 rounded-chip border border-current/30 px-2.5 text-meta font-semibold transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-current/10"
          style={{ color: 'var(--accent-success)' }}
        >
          <PhoneOff size={12} aria-hidden />
          Decline
        </button>
      </span>
    </div>
  );
}
