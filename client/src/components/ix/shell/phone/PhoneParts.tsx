import { useCurrentUser } from '../../../../hooks/useCurrentUser';
import { Avatar } from '../../identity';
import { openAccountMenu } from '../../menus/accountMenuOpener';
import { useOptionalIxShell } from '../IxShellContext';

/**
 * The dim layer inside each phone screen (docs/index-spec.md §9; IX-16): when
 * a page is pushed over a screen, that screen moves 30% left and darkens
 * beneath it. The darkening is this layer's opacity (phoneMotion.ts), so the
 * screen itself never takes a filter. Scenery: no pointer, no name.
 */
export function PhoneShade() {
  return <div className="ix-phone-shade" aria-hidden="true" />;
}

/**
 * Your face at the right of the root screen's header (docs/index-spec.md §9:
 * "Your avatar sits at the header's right (account menu), with '…' left of
 * it"). The toolbar's avatar is the account menu's door everywhere else; a
 * phone's toolbar belongs to the pushed page and has none. Renders nothing
 * off a phone.
 */
export function PhoneAccountButton() {
  const shell = useOptionalIxShell();
  const user = useCurrentUser();
  if (shell?.layout !== 'phone' || !user) return null;
  const name = user.display_name || user.username || '';
  return (
    <button
      type="button"
      className="ix-sh__me"
      aria-label="Your account"
      title="Your account"
      aria-haspopup="menu"
      data-ix-account-anchor=""
      data-testid="ix-phone-account"
      onClick={openAccountMenu}
    >
      <Avatar userId={user.id} name={name} avatar={user.avatar_hash ?? null} size={32} />
    </button>
  );
}
