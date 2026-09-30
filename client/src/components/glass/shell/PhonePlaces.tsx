import { useEffect, useRef } from 'react';

import { CallPill } from '../pill';
import { PlacesPanel } from '../places';
import { HeaderAvatar } from '../conversation/HeaderAvatar';
import { usePhoneNavStore } from './phoneNav';

/**
 * The places screen of a phone (docs/glass-spec.md §8: "the places panel is its
 * own screen"; WP-G20): the same panel the wide frame floats at 316px, filling
 * the window, under your face (the account menu: status, reminders, settings,
 * sign out; the phone has no other door to them now that the bottom bar is
 * gone).
 *
 * While you hold a call the call pill rides above it, so the microphone and
 * Leave are one tap away from anywhere, the job the on-air dock did.
 *
 * What a tap means is decided here, because the panel only navigates:
 *
 *   a row in the list (a channel, a message, Friends, an add-on, an event, the
 *   live channel)           open it: the conversation slides in (a row that
 *                           opens a popover, like Game servers, does not)
 *   a circle in the server row   look at that server's channels: stay here,
 *   except the one you are already in, which goes back to its conversation
 */
export function PhonePlaces({ guildId, holdsCall }: { guildId: string | null; holdsCall: boolean }) {
  const showConversation = usePhoneNavStore((state) => state.showConversation);
  const paneRef = useRef<HTMLDivElement | null>(null);

  // One listener for every row, instead of a handler in each (the rows are the
  // panel's, and it only navigates): a click that reaches the pane is a tap on
  // one of its controls.
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const onClick = (event: MouseEvent) => {
      // A modified click or a middle click is the browser's (a new tab), not a pick.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (!(event.target instanceof Element)) return;
      const row = event.target.closest<HTMLElement>('[data-place-row]');
      if (!row) return;
      // A row that opens a popover (Game servers) is not a place you go to.
      if (row.hasAttribute('aria-haspopup')) return;
      if (row.closest('.glass-places-servers')) {
        if (row.getAttribute('aria-current')) showConversation();
        return;
      }
      showConversation();
    };
    pane.addEventListener('click', onClick);
    return () => pane.removeEventListener('click', onClick);
  }, [showConversation]);

  return (
    <>
      {holdsCall && (
        <div className="glass-phone__call">
          <CallPill guildId={guildId} layout="stacked" />
        </div>
      )}
      <div
        ref={paneRef}
        className="glass-pane glass-pane--glow glass-frame__places glass-phone__places"
        data-presentation="pane"
      >
        <div className="glass-phone__places-bar">
          <HeaderAvatar />
        </div>
        <PlacesPanel presentation="pane" />
      </div>
    </>
  );
}
