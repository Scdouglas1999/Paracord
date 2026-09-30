import { create } from 'zustand';
import { useGlassStore, type GlassSheet } from '../../../stores/glassStore';
import { registerSessionReset } from '../../../stores/sessionReset';
import type { ContextPanelMode } from '../../../stores/uiStore';

/**
 * Which page of a sheet is showing (docs/glass-spec.md §3; WP-G18).
 *
 * `glassStore.sheet` says WHICH sheet is open (`search`, `people`, `channel`,
 * `account`, `server`). Two of them have pages, and the store contract in
 * `glassStore.ts` has no room for those, so they live here:
 *
 *   channel  the channel menu's pages: the catch-up summary, pins, threads,
 *            follows (announcement channels), media, the leaderboard and this
 *            channel's notifications. Each is a tab; the menu opens one.
 *   account  the account menu is a popover; its one page is Reminders, a sheet.
 *
 * A thread is pushed on top of the Threads page (`threadId`): it takes over
 * the column with a back affordance and a Back press pops it. That is a stack
 * of two, so a field is enough.
 *
 * The pages are reset whenever the sheet changes, so a sheet always opens at
 * its first page and a stale page never survives its sheet.
 */

export type ChannelSheetPage =
  | 'summary'
  | 'pins'
  | 'threads'
  | 'follows'
  | 'media'
  | 'leaderboard'
  | 'notifications';
export type AccountSheetPage = 'reminders';

/** In the order of the channel menu and of the sheet's tabs. */
export const CHANNEL_SHEET_PAGES: readonly ChannelSheetPage[] = [
  'summary',
  'pins',
  'threads',
  'follows',
  'media',
  'leaderboard',
  'notifications',
];

interface SheetPageState {
  /** The channel sheet's page; null is its index. */
  channelPage: ChannelSheetPage | null;
  /** A thread pushed over the Threads page. */
  threadId: string | null;
  /** The account sheet's page; null is the menu. */
  accountPage: AccountSheetPage | null;
  setChannelPage: (page: ChannelSheetPage | null) => void;
  pushThread: (threadId: string) => void;
  popThread: () => void;
  setAccountPage: (page: AccountSheetPage | null) => void;
  reset: () => void;
}

const EMPTY = { channelPage: null, threadId: null, accountPage: null } as const;

export const useSheetPages = create<SheetPageState>()((set) => ({
  ...EMPTY,
  setChannelPage: (channelPage) => set({ channelPage, threadId: null }),
  pushThread: (threadId) => set({ threadId }),
  popThread: () => set({ threadId: null }),
  setAccountPage: (accountPage) => set({ accountPage }),
  reset: () => set({ ...EMPTY }),
}));

// A sheet always opens at its first page: when `glassStore.sheet` changes, the
// pages go with it. (Callers that open a page set it AFTER opening the sheet.)
useGlassStore.subscribe((state, previous) => {
  if (state.sheet !== previous.sheet) useSheetPages.getState().reset();
});
registerSessionReset('glass-sheets', () => useSheetPages.getState().reset());

/** The element that had focus when a sheet opened, so Escape can hand it back. */
let trigger: HTMLElement | null = null;

function rememberTrigger(): void {
  const active = typeof document === 'undefined' ? null : document.activeElement;
  trigger = active instanceof HTMLElement && active !== document.body ? active : null;
}

/**
 * Where focus goes when a sheet closes and the control that opened it is gone
 * or never took focus (Safari does not focus a button on click).
 */
const TRIGGER_FALLBACK: Record<GlassSheet, string> = {
  search: '.glass-header__tools [aria-label="Search messages"]',
  people: '.glass-header__tools [aria-label="Members"], .glass-header__tools [aria-label="People in this message"]',
  account: '.glass-header__avatar',
  channel: '.glass-header__title',
  server: '.glass-server-title',
};

/** Hand focus back to what opened the sheet; falls back to the header control that does. */
export function restoreSheetTrigger(sheet: GlassSheet | null): void {
  if (typeof document === 'undefined') return;
  const remembered = trigger;
  trigger = null;
  const current = document.activeElement;
  // Something real already has focus (the focus trap put it back, or a dialog
  // the choice opened took it): leave it. A control inside what is leaving (a
  // sheet, a menu that is `inert` for the beat its exit plays) is not real.
  const lost = !(current instanceof HTMLElement)
    || current === document.body
    || current.closest('[data-sheet], [inert], [aria-hidden="true"]') !== null;
  if (!lost) return;
  if (remembered && document.contains(remembered)) {
    remembered.focus({ preventScroll: true });
    return;
  }
  const fallback = sheet ? document.querySelector<HTMLElement>(TRIGGER_FALLBACK[sheet]) : null;
  fallback?.focus({ preventScroll: true });
}

/** Open a sheet, or close it when it is the one already open. */
export function toggleSheet(sheet: GlassSheet): void {
  const glass = useGlassStore.getState();
  if (glass.sheet === sheet) {
    glass.closeSheet();
    return;
  }
  rememberTrigger();
  glass.openSheet(sheet);
}

/** Close whatever sheet is open. */
export function closeSheets(): void {
  useGlassStore.getState().closeSheet();
}

/**
 * Open the channel sheet on a page (pins, threads, media, leaderboard,
 * notifications), or on its index with `null`. Asking for the page that is
 * already showing closes the sheet, as the header's toggles do.
 */
export function toggleChannelSheet(page: ChannelSheetPage | null): void {
  const glass = useGlassStore.getState();
  const pages = useSheetPages.getState();
  if (glass.sheet === 'channel' && pages.channelPage === page) {
    glass.closeSheet();
    return;
  }
  if (glass.sheet !== 'channel') {
    rememberTrigger();
    glass.openSheet('channel');
  }
  useSheetPages.getState().setChannelPage(page);
}

/** Open the channel sheet on a page and leave it open if it already is. */
export function openChannelSheet(page: ChannelSheetPage | null): void {
  const glass = useGlassStore.getState();
  if (glass.sheet !== 'channel') {
    rememberTrigger();
    glass.openSheet('channel');
  }
  useSheetPages.getState().setChannelPage(page);
}

/** Open the reminders page of the account sheet (the account menu's row). */
export function openReminders(): void {
  const glass = useGlassStore.getState();
  if (glass.sheet !== 'account') glass.openSheet('account');
  useSheetPages.getState().setAccountPage('reminders');
}

/**
 * The sheet for a legacy `uiStore.contextPanelMode` request. The command
 * palette, Mod+F, the server home's Media and Leaderboard buttons and the DM
 * page still ask for a panel that way; the Sheets slot translates each request
 * into a sheet and clears the mode.
 */
export function openForContextMode(mode: Exclude<ContextPanelMode, null>): void {
  switch (mode) {
    case 'search':
      if (useGlassStore.getState().sheet !== 'search') {
        rememberTrigger();
        useGlassStore.getState().openSheet('search');
      }
      return;
    case 'recipients':
      if (useGlassStore.getState().sheet !== 'people') {
        rememberTrigger();
        useGlassStore.getState().openSheet('people');
      }
      return;
    case 'economy':
      openChannelSheet('leaderboard');
      return;
    case 'pins':
    case 'threads':
    case 'media':
      openChannelSheet(mode);
  }
}
