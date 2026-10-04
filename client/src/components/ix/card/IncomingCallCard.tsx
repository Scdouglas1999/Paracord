import { useEffect, useLayoutEffect, useRef } from 'react';
import { useNavigate } from 'react-router';

import { sendNotification } from '../../../lib/features/notifications';
import { joinCall } from '../../glass/pill/pillActions';
import { useServerListStore } from '../../../stores/serverListStore';
import { LOCAL_SERVER_ID } from '../../../lib/serverScope';
import { Avatar } from '../identity';
import { onSettle } from '../motion';
import { CreamButton, WideControl } from '../primitives';
import { inLeavingPane, playEnter, playLeave } from './cardMotion';
import { DM_GUILD, incomingLine, type IncomingCallModel } from './model';

/**
 * Somebody is calling you (docs/index-spec.md §4.10): a card in the pinned
 * slot of whatever place you are in, with the caller's face, "Jeremy is
 * calling", Decline (wide) and Accept (cream). It enters with the room card's
 * motion and stays until you answer or decline, or the caller hangs up.
 *
 * Decline is a local dismissal (`useIncomingDmCall`): nothing is sent and the
 * caller is told nothing; the next call from them rings again. Accept opens the
 * conversation and joins its call with Settings › Join calls muted applied.
 * When the window is not focused a system notification says who is calling.
 *
 * Replaces Glass's `IncomingCallBanner`.
 */
export interface IncomingCallCardProps {
  call: IncomingCallModel;
  onDecline: () => void;
  mayAnimate: () => boolean;
  exiting?: boolean;
  onExited?: () => void;
}

export function IncomingCallCard({ call, onDecline, mayAnimate, exiting = false, onExited }: IncomingCallCardProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const navigate = useNavigate();
  const serverId = useServerListStore((state) => state.activeServerId ?? LOCAL_SERVER_ID);
  const line = incomingLine(call);

  // One entrance per call (development's StrictMode runs mount effects twice).
  const entered = useRef(false);
  useLayoutEffect(() => {
    if (entered.current) return;
    entered.current = true;
    if (mayAnimate()) playEnter(rootRef.current, 'card');
    // Mount only: one entrance per call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    if (!exiting) return undefined;
    const animation = mayAnimate() && !inLeavingPane(rootRef.current) ? playLeave(rootRef.current, 'card') : null;
    return onSettle([animation], () => onExited?.());
  }, [exiting, mayAnimate, onExited]);

  // The window is elsewhere: say it where the person is.
  const told = useRef<string | null>(null);
  useEffect(() => {
    if (told.current === call.channelId) return;
    told.current = call.channelId;
    if (typeof document !== 'undefined' && !document.hasFocus()) void sendNotification(line, 'Direct call');
  }, [call.channelId, line]);

  const accept = () => {
    navigate(`/app/dms/${call.channelId}`);
    void joinCall({ serverId, guildId: DM_GUILD, channelId: call.channelId, title: call.callerName });
  };

  return (
    <section
      ref={rootRef}
      className="ix-room-card ix-room-card--incoming"
      data-testid="ix-room-card"
      data-state="incoming"
      data-position="pinned"
      data-card-key={call.key}
      data-exiting={exiting ? 'true' : undefined}
      role="alert"
      aria-label={`${line}, direct call`}
      inert={exiting || undefined}
    >
      <span className="ix-room-card__layer ix-room-card__layer--live" aria-hidden="true" />
      <div className="ix-room-card__head ix-room-card__head--incoming">
        {call.caller && <Avatar userId={call.caller.userId} name={call.caller.name} avatar={call.caller.avatar} size={24} />}
        <span className="ix-room-card__title">{line}</span>
        <span className="ix-room-card__when">Direct call</span>
      </div>
      <div className="ix-card-actions">
        <WideControl data-testid="ix-card-decline" onClick={onDecline}>
          Decline
        </WideControl>
        <CreamButton grow data-testid="ix-card-accept" onClick={accept}>
          Accept
        </CreamButton>
      </div>
    </section>
  );
}
