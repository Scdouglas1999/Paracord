/**
 * The sheets slot (owner: WP-G18). Contract: `SheetsProps` in
 * components/glass/shell/slots.ts. Mounted by the shell after the conversation
 * pane; it renders whichever sheet `glassStore.sheet` names as a solid page over
 * the pane (a full-screen page on a phone), and nothing when none is open.
 *
 * To open one: `useGlassStore.getState().openSheet('search' | 'people' |
 * 'account' | 'channel' | 'server')`, or, for a page of the channel sheet,
 * `openChannelSheet('pins' | 'threads' | 'media' | 'leaderboard' |
 * 'notifications')`.
 */
export { Sheets } from './Sheets';
export type { SheetsProps } from '../shell/slots';
export { SheetFrame } from './SheetFrame';
export type { SheetFrameProps } from './SheetFrame';
export {
  CHANNEL_SHEET_PAGES,
  closeSheets,
  openChannelSheet,
  openReminders,
  toggleChannelSheet,
  toggleSheet,
  useSheetPages,
} from './sheetStore';
export type { AccountSheetPage, ChannelSheetPage } from './sheetStore';
