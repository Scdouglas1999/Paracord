import { beforeEach, describe, expect, it } from 'vitest';
import { useGlassStore } from '../../../stores/glassStore';
import {
  CHANNEL_SHEET_PAGES,
  closeSheets,
  openChannelSheet,
  openForContextMode,
  openReminders,
  openSearchWith,
  restoreSheetTrigger,
  toggleChannelSheet,
  toggleSheet,
  useSheetPages,
} from './sheetStore';

/**
 * Which sheet is open is `glassStore.sheet`; which page of it is `useSheetPages`.
 * These hold the rules between them: a sheet opens at its first page, asking for
 * the page that is showing closes it (the header's buttons are toggles), and an
 * older `contextPanelMode` request lands on the sheet that replaced its panel.
 */

beforeEach(() => {
  useGlassStore.getState().reset();
  useSheetPages.getState().reset();
  document.body.innerHTML = '';
});

describe('toggleSheet', () => {
  it('opens a sheet, and closes it when it is the one already open', () => {
    toggleSheet('search');
    expect(useGlassStore.getState().sheet).toBe('search');
    toggleSheet('search');
    expect(useGlassStore.getState().sheet).toBeNull();
  });

  it('moves straight from one sheet to another', () => {
    toggleSheet('search');
    toggleSheet('people');
    expect(useGlassStore.getState().sheet).toBe('people');
  });
});

describe('the channel sheet\'s pages', () => {
  it('opens on the page it is asked for', () => {
    openChannelSheet('threads');
    expect(useGlassStore.getState().sheet).toBe('channel');
    expect(useSheetPages.getState().channelPage).toBe('threads');
  });

  it('switches page without closing, and closes when the page showing is asked for again', () => {
    toggleChannelSheet('pins');
    toggleChannelSheet('media');
    expect(useGlassStore.getState().sheet).toBe('channel');
    expect(useSheetPages.getState().channelPage).toBe('media');
    toggleChannelSheet('media');
    expect(useGlassStore.getState().sheet).toBeNull();
  });

  it('knows every page the channel menu and the tabs name', () => {
    expect([...CHANNEL_SHEET_PAGES]).toEqual([
      'summary',
      'pins',
      'threads',
      'follows',
      'media',
      'leaderboard',
      'notifications',
    ]);
  });

  it('opens a sheet at its first page: leaving a sheet forgets where it was', () => {
    openChannelSheet('media');
    useSheetPages.getState().pushThread('t1');
    toggleSheet('search');
    expect(useSheetPages.getState().channelPage).toBeNull();
    expect(useSheetPages.getState().threadId).toBeNull();
    openChannelSheet('pins');
    expect(useSheetPages.getState().channelPage).toBe('pins');
  });

  it('pushes a thread over the list and pops it, and changing page drops it', () => {
    openChannelSheet('threads');
    useSheetPages.getState().pushThread('t1');
    expect(useSheetPages.getState().threadId).toBe('t1');
    useSheetPages.getState().popThread();
    expect(useSheetPages.getState().threadId).toBeNull();
    useSheetPages.getState().pushThread('t2');
    useSheetPages.getState().setChannelPage('pins');
    expect(useSheetPages.getState().threadId).toBeNull();
  });
});

describe('the account sheet', () => {
  it('opens reminders as a page of the account sheet', () => {
    openReminders();
    expect(useGlassStore.getState().sheet).toBe('account');
    expect(useSheetPages.getState().accountPage).toBe('reminders');
  });

  it('closing it puts the menu back for next time', () => {
    openReminders();
    closeSheets();
    expect(useSheetPages.getState().accountPage).toBeNull();
  });
});

describe('openSearchWith (the quick switcher\'s last row)', () => {
  it('opens the search sheet with the words in the seed, taken after the open resets the pages', () => {
    openSearchWith('guns');
    expect(useGlassStore.getState().sheet).toBe('search');
    expect(useSheetPages.getState().searchSeed).toBe('guns');
  });

  it('seeds nothing for empty words, and does not close a search that is already open', () => {
    toggleSheet('search');
    openSearchWith('   ');
    expect(useGlassStore.getState().sheet).toBe('search');
    expect(useSheetPages.getState().searchSeed).toBeNull();
    openSearchWith('run');
    expect(useGlassStore.getState().sheet).toBe('search');
    expect(useSheetPages.getState().searchSeed).toBe('run');
  });

  it('is forgotten when the sheet changes', () => {
    openSearchWith('guns');
    toggleSheet('people');
    expect(useSheetPages.getState().searchSeed).toBeNull();
  });
});

describe('a request made the old way (uiStore.contextPanelMode)', () => {
  it.each([
    ['search', 'search', null],
    ['recipients', 'people', null],
    ['pins', 'channel', 'pins'],
    ['threads', 'channel', 'threads'],
    ['media', 'channel', 'media'],
    ['economy', 'channel', 'leaderboard'],
  ] as const)('%s opens the %s sheet', (mode, sheet, page) => {
    openForContextMode(mode);
    expect(useGlassStore.getState().sheet).toBe(sheet);
    expect(useSheetPages.getState().channelPage).toBe(page);
  });
});

describe('restoreSheetTrigger', () => {
  it('hands focus back to the control that opened the sheet', () => {
    document.body.innerHTML = '<button id="opener">Search messages</button>';
    const opener = document.getElementById('opener') as HTMLButtonElement;
    opener.focus();
    toggleSheet('search');
    // Focus moves into the sheet, then the sheet closes and leaves it on the body.
    (document.activeElement as HTMLElement).blur();
    closeSheets();
    restoreSheetTrigger('search');
    expect(document.activeElement).toBe(opener);
  });

  it('falls back to the header control for the sheet when nothing was focused (Safari does not focus a button on click)', () => {
    document.body.innerHTML =
      '<div class="ix-toolbar"><button aria-label="Members">M</button></div>';
    toggleSheet('people');
    closeSheets();
    restoreSheetTrigger('people');
    expect(document.activeElement).toBe(document.querySelector('[aria-label="Members"]'));
  });

  it('leaves alone a focus that is already somewhere real', () => {
    document.body.innerHTML = '<button id="a">a</button><button id="b">b</button>';
    (document.getElementById('a') as HTMLButtonElement).focus();
    toggleSheet('search');
    (document.getElementById('b') as HTMLButtonElement).focus();
    restoreSheetTrigger('search');
    expect(document.activeElement).toBe(document.getElementById('b'));
  });
});
