import { useEffect } from 'react';

import { useGlassStore } from '../../../stores/glassStore';
import { HelpOverlay } from '../../layout/overlays/HelpOverlay';
import { InviteModal } from '../../guild/InviteModal';
import { DmPickerModal } from '../../message/DmPickerModal';
import { UserProfilePopup } from '../../user/UserProfile';
import { useSheetPages } from '../../glass/sheets/sheetStore';
import { AccountMenu } from './AccountMenu';
import { ChannelMenuView } from './ChannelMenu';
import { CreateChannelDialog } from './CreateChannelDialog';
import {
  closeDmPicker,
  closeHelp,
  closeInvite,
  closeProfileCard,
  openHelp,
  useMenuHostStore,
} from './hostStore';
import { PeopleMenuView } from './PeopleMenu';
import { ServerMenuView } from './ServerMenu';

/**
 * Everything that opens over the frame and is not a sheet, mounted once by the
 * sheet slot (components/ix/sheets): the account menu, the server, channel and
 * People menus, the Help dialog (Ctrl /), the profile card, the Create channel
 * dialog, the invite dialog and the New message picker. Callers open them with
 * the functions in `hostStore.ts` (re-exported from `components/ix/menus`); none
 * of them renders a menu of its own.
 *
 * One menu is open at a time: `menu` in the host store is a single slot, and the
 * account menu (driven by `glassStore.sheet`) closes when another menu opens.
 */
export function MenuHost() {
  const menu = useMenuHostStore((state) => state.menu);
  const help = useMenuHostStore((state) => state.help);
  const profile = useMenuHostStore((state) => state.profile);
  const createChannel = useMenuHostStore((state) => state.createChannel);
  const invite = useMenuHostStore((state) => state.invite);
  const dmPicker = useMenuHostStore((state) => state.dmPicker);
  const dmPickerMode = useMenuHostStore((state) => state.dmPickerMode);
  const sheet = useGlassStore((state) => state.sheet);
  const accountPage = useSheetPages((state) => state.accountPage);

  // Ctrl / (Cmd /) opens Help from anywhere that is not typing.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.shiftKey || event.altKey) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      if (useMenuHostStore.getState().help) closeHelp();
      else openHelp();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Opening another menu puts the account menu away.
  useEffect(() => {
    if (menu !== null && useGlassStore.getState().sheet === 'account') useGlassStore.getState().closeSheet();
  }, [menu]);

  return (
    <>
      <AccountMenu open={sheet === 'account' && accountPage === null && menu === null} />
      {menu?.kind === 'server' && <ServerMenuView key={menu.server.guildId} server={menu.server} anchor={menu.anchor} />}
      {menu?.kind === 'channel' && <ChannelMenuView key={menu.request.subject.channelId} request={menu.request} anchor={menu.anchor} />}
      {menu?.kind === 'people' && <PeopleMenuView anchor={menu.anchor} />}
      <HelpOverlay open={help} onClose={closeHelp} />
      <UserProfilePopup
        user={profile?.user ?? null}
        position={profile?.position ?? null}
        onClose={closeProfileCard}
      />
      {createChannel && <CreateChannelDialog key={`${createChannel.guildId}:${createChannel.kind}`} request={createChannel} />}
      {invite && <InviteModal guildName={invite.guildName} channelId={invite.channelId} onClose={closeInvite} />}
      {dmPicker && <DmPickerModal open onClose={closeDmPicker} initialMode={dmPickerMode} />}
    </>
  );
}
