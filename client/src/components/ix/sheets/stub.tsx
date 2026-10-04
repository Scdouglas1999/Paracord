import { Sheets } from '../../glass/sheets';
import { useIxShell } from '../shell/IxShellContext';
import type { SheetSlotProps } from '../shell/slots';

/**
 * STUB (IX-4). Owner: IX-9, which replaces this file with the Index sheets
 * (index-spec §6.1): inside main on its right, in `#ix-sheet-host`.
 *
 * Until then it mounts the Glass sheets, which portal into `main#main-content`
 * and fill all of main (`SheetFrame`). IX-9: portal into `IX_SHEET_HOST_ID`
 * (components/ix/shell/slots.ts) instead and fill the host.
 */
export function SheetSlot(_props: SheetSlotProps) {
  const { layout, guildId, channelId } = useIxShell();
  return <Sheets guildId={guildId} channelId={channelId} layout={layout === 'phone' ? 'phone' : 'wide'} />;
}
