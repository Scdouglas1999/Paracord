/**
 * The call pill slot (owner: WP-G12). Contract: `CallPillProps` in
 * components/glass/shell/slots.ts. Mounted in the conversation header, right
 * aligned to the column (and above the header on the phone, `layout="stacked"`).
 * A sheet draws one of its own while it covers the header (`placement="sheet"`).
 */
export { CallPill } from './CallPill';
export type { CallPillProps } from '../shell/slots';
export { useRegisterSheetCover, useSheetCover } from './sheetCover';
