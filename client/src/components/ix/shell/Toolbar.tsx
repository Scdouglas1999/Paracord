import { useCurrentUser } from '../../../hooks/useCurrentUser';
import { toggleSheet } from '../../glass/sheets';
import { usePhoneNavStore } from '../../glass/shell/phoneNav';
import { IxGlyph } from '../glyphs';
import { Avatar } from '../identity';
import { openAccountMenu } from '../menus';
import { useOptionalIxShell } from './IxShellContext';
import { useToolbarStore } from './toolbarStore';

/**
 * The main toolbar (docs/index-spec.md §4.9, §3.1): 58px, absolute over the
 * page's scroller, padding 0 20 0 40, gap 10.
 *
 *   [back] [folded title]  ·····  [call] [search] [members] [your avatar]
 *
 * Transparent until the page's large title has scrolled 40px away; then the
 * near-solid fill and a bottom hairline (a color transition and an opacity
 * fade, 135ms; no blur). The folded title enters from translateY(6px) + fade
 * (115ms opacity, 160ms spring), §5.14. What it says is the page's
 * (`useToolbar`); the buttons it always has are the frame's.
 *
 * Test id `ix-toolbar`; the folded title is inside it.
 */
export function Toolbar() {
  const shell = useOptionalIxShell();
  const page = useToolbarStore((state) => state.page);
  const user = useCurrentUser();
  const showPlaces = usePhoneNavStore((state) => state.showPlaces);

  const phone = shell?.layout === 'phone';
  const guildId = shell?.guildId ?? null;
  const channelId = shell?.channelId ?? null;
  const hasSubject = Boolean(guildId || channelId);
  const inDm = !guildId && Boolean(channelId);
  const folded = Boolean(page?.folded);
  const title = page?.title ?? null;
  const showSearch = page?.search ?? hasSubject;
  const showMembers = page?.members ?? hasSubject;
  // A pushed page's own back; on a phone, the way back to the root screen.
  const onBack = page?.onBack ?? (phone ? showPlaces : null);
  const backLabel = page?.onBack ? (page.backLabel ?? 'Back') : 'Back to the sidebar';
  const name = user?.display_name || user?.username || '';

  return (
    <div className="ix-toolbar" data-testid="ix-toolbar" data-folded={folded ? 'true' : 'false'}>
      {onBack && (
        <button type="button" className="ix-tool ix-toolbar__back" aria-label={backLabel} title={backLabel} onClick={onBack}>
          <IxGlyph name="chevron" size={18} />
        </button>
      )}
      {title !== null && title !== '' && (
        page?.onTitleClick ? (
          <button
            type="button"
            className="ix-toolbar__title"
            aria-hidden={folded ? undefined : true}
            tabIndex={folded ? 0 : -1}
            aria-haspopup={page.titleHasPopup ?? undefined}
            onClick={page.onTitleClick}
          >
            {title}
          </button>
        ) : (
          <span className="ix-toolbar__title" aria-hidden={folded ? undefined : true}>
            {title}
          </span>
        )
      )}
      <span className="ix-toolbar__spacer" />
      {page?.call}
      {showSearch && (
        <button
          type="button"
          className="ix-tool"
          aria-label="Search messages"
          title="Search messages"
          onClick={() => toggleSheet('search')}
        >
          <IxGlyph name="search" size={18} />
        </button>
      )}
      {showMembers && (
        <button
          type="button"
          className="ix-tool"
          aria-label={inDm ? 'People in this message' : 'Members'}
          title={inDm ? 'People in this message' : 'Members'}
          onClick={() => toggleSheet('people')}
        >
          <IxGlyph name="people" size={18} />
        </button>
      )}
      {user && (
        <button
          type="button"
          className="ix-toolbar__me"
          aria-label="Your account"
          title="Your account"
          aria-haspopup="menu"
          data-ix-account-anchor=""
          onClick={openAccountMenu}
        >
          <Avatar userId={user.id} name={name} avatar={user.avatar_hash ?? null} size={32} />
        </button>
      )}
    </div>
  );
}
