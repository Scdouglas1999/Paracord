import { Sheets } from '../../glass/sheets';
import { MenuHost } from '../menus/MenuHost';
import { useIxShell } from '../shell/IxShellContext';
import type { SheetSlotProps } from '../shell/slots';

/**
 * The sheets slot (docs/index-spec.md §6.1; owner IX-9). IxFrame mounts it inside
 * main, after the page. It renders whichever sheet `glassStore.sheet` names (the
 * message search, the people sheet, the channel sheet and its pages, reminders)
 * into the sheet host (`#ix-sheet-host`, the frame's geometry: inset 10, width 400,
 * 480 for search, radius 24), and everything else that opens over the frame and
 * is not a sheet: the account, server, channel and People menus, the Help
 * dialog, the profile card and the small dialogs they open (`MenuHost`).
 *
 * To open a sheet: `glassStore.openSheet('search' | 'people' | 'channel')`, or
 * `toggleSheet` / `openChannelSheet(page)` / `openReminders()` from
 * `components/glass/sheets`.
 */
export function SheetSlot(_props: SheetSlotProps) {
  const { layout, guildId, channelId } = useIxShell();
  return (
    <>
      <Sheets guildId={guildId} channelId={channelId} layout={layout === 'phone' ? 'phone' : 'wide'} />
      <MenuHost />
    </>
  );
}
