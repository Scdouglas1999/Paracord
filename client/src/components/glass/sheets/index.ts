/**
 * The sheets (docs/index-spec.md §6.1). Contract: `SheetsProps` in ./Sheets.tsx.
 * Mounted by `SheetSlot` (components/ix/sheets) inside main; it renders
 * whichever sheet `glassStore.sheet` names in the frame's sheet host (the whole
 * screen on a phone), and nothing when none is open.
 *
 * To open one: `useGlassStore.getState().openSheet('search' | 'people' |
 * 'account' | 'channel' | 'server')`, or, for a page of the channel sheet,
 * `openChannelSheet('pins' | 'threads' | 'media' | 'leaderboard' |
 * 'notifications')`.
 */
export { Sheets } from './Sheets';
export type { SheetsProps } from './Sheets';
export { SheetFrame } from './SheetFrame';
export type { SheetFrameProps } from './SheetFrame';
export {
  CHANNEL_SHEET_PAGES,
  closeSheets,
  openChannelSheet,
  openReminders,
  openSearchWith,
  toggleChannelSheet,
  toggleSheet,
  useSheetPages,
} from './sheetStore';
export type { AccountSheetPage, ChannelSheetPage } from './sheetStore';
