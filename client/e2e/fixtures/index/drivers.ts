/**
 * Shared drivers for the Index UI, keyed to the test ids that
 * docs/design/index-plan.md §1.3 fixes before any of that UI exists. A
 * package's spec says WHAT it does ("go to Game Night, join the room card"), the
 * driver knows WHERE it is (`getByTestId('ix-dock-item')` with `data-place`).
 *
 * The ids (all `data-testid`):
 *
 *   ix-sidebar  ix-sidebar-header  ix-search-field  ix-channel-row[data-channel-id]
 *   ix-room-row  ix-room-card[data-state]  ix-card-join  ix-card-open-call  ix-card-leave
 *   ix-dock  ix-dock-item[data-place]  ix-toolbar  ix-title  ix-welcome
 *   ix-action-card[data-action]  ix-composer  ix-call  ix-call-back  ix-call-leave
 *
 * CONVENTIONS THE PLAN LEAVES OPEN, fixed here so the packages that build the
 * UI and the packages that test it agree (an owner that needs a different value
 * changes it here, once):
 *
 *   - `ix-dock-item[data-place]` is `people` for People and the server's id
 *     (the decimal string) for a server.
 *   - `ix-action-card[data-action]` is `invite`, `plan` or `hello`.
 *   - `ix-room-card[data-state]` is one of `live`, `streaming`, `listening`,
 *     `yours`, `incoming` (index-spec §4.3, §4.10). A card pinned in another
 *     server keeps the state of the call it shows (`yours`).
 *   - `ix-card-open-call` is the card's wide control in the joined states; its
 *     label is "Open call" or "Back to chat", the test id does not change.
 *   - `ix-card-join` is Join (or, with someone streaming, the Watch control
 *     next to it): the control that joins the room. `ix-card-leave` is the
 *     danger control.
 *   - `ix-title` is the large title (the folded title in the toolbar is inside
 *     `ix-toolbar`).
 *   - `ix-composer` is the message box's root; its textbox is the one
 *     `role=textbox` inside it.
 *
 * Drivers never wait on animation: a spec that screenshots calls `settle` or
 * `shoot` (which settles).
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { type IndexHarness } from './harness';
import { CH, CLOCK, GUILD, type ChannelKey, type GuildKey } from './scene';

export const TEST_IDS = [
  'ix-sidebar',
  'ix-sidebar-header',
  'ix-search-field',
  'ix-channel-row',
  'ix-room-row',
  'ix-room-card',
  'ix-card-join',
  'ix-card-open-call',
  'ix-card-leave',
  'ix-dock',
  'ix-dock-item',
  'ix-toolbar',
  'ix-title',
  'ix-welcome',
  'ix-action-card',
  'ix-composer',
  'ix-call',
  'ix-call-back',
  'ix-call-leave',
] as const;
export type TestId = (typeof TEST_IDS)[number];

export type Place = GuildKey | 'people';
export type ActionCard = 'invite' | 'plan' | 'hello';
export type RoomCardState = 'live' | 'streaming' | 'listening' | 'yours' | 'incoming';

/** `getByTestId` for a §1.3 id. */
export const ix = (page: Page | Locator, id: TestId): Locator => page.getByTestId(id);

/** The `data-place` value of a place: `people`, or the server's id. */
export const placeAttr = (place: Place): string => (place === 'people' ? 'people' : GUILD[place].id);

/* ---------------------------------------------------------------- locators */

export const sidebar = (page: Page) => ix(page, 'ix-sidebar');
export const sidebarHeader = (page: Page) => ix(page, 'ix-sidebar-header');
export const searchField = (page: Page) => ix(page, 'ix-search-field');
export const dock = (page: Page) => ix(page, 'ix-dock');
export const toolbar = (page: Page) => ix(page, 'ix-toolbar');
export const title = (page: Page) => ix(page, 'ix-title');
export const welcome = (page: Page) => ix(page, 'ix-welcome');
export const composer = (page: Page) => ix(page, 'ix-composer');
export const composerInput = (page: Page) => composer(page).getByRole('textbox');
export const callView = (page: Page) => ix(page, 'ix-call');

/** A channel row by scene key (or channel id). */
export const channelRow = (page: Page, channel: ChannelKey | string): Locator =>
  ix(page, 'ix-channel-row').and(page.locator(`[data-channel-id="${CH[channel as ChannelKey] ?? channel}"]`));

/** Every room row, or the one whose text has this name. */
export const roomRows = (page: Page): Locator => ix(page, 'ix-room-row');
export const roomRow = (page: Page, name: string): Locator => roomRows(page).filter({ hasText: name });

/** Every room card in the sidebar (a pinned call and the server's own card can both be there). */
export const roomCards = (page: Page): Locator => ix(page, 'ix-room-card');
/** The card in a state. */
export const roomCard = (page: Page, state?: RoomCardState): Locator =>
  state ? roomCards(page).and(page.locator(`[data-state="${state}"]`)) : roomCards(page).first();

export const cardJoin = (card: Locator): Locator => ix(card, 'ix-card-join');
export const cardOpenCall = (card: Locator): Locator => ix(card, 'ix-card-open-call');
export const cardLeave = (card: Locator): Locator => ix(card, 'ix-card-leave');

export const dockItem = (page: Page, place: Place): Locator =>
  ix(page, 'ix-dock-item').and(page.locator(`[data-place="${placeAttr(place)}"]`));
export const actionCard = (page: Page, action: ActionCard): Locator =>
  ix(page, 'ix-action-card').and(page.locator(`[data-action="${action}"]`));

/* ----------------------------------------------------------------- actions */

/** Click a dock item. Waits for nothing: the place slides, tints and settles on its own time. */
export async function goToPlace(page: Page, place: Place): Promise<void> {
  await dockItem(page, place).click();
}

/** Click a channel row. */
export async function openChannel(page: Page, channel: ChannelKey): Promise<void> {
  await channelRow(page, channel).click();
}

/** Click one of the welcome's three cards. */
export async function clickActionCard(page: Page, action: ActionCard): Promise<void> {
  await actionCard(page, action).click();
}

/** Type into the message box the way a person does: click it, then keys. */
export async function typeInComposer(page: Page, text: string): Promise<void> {
  await composerInput(page).click();
  await page.keyboard.type(text);
}

/** Empty the message box (a draft is kept per conversation, across reloads). */
export async function clearComposer(page: Page): Promise<void> {
  await composerInput(page).click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Escape');
}

/** The card's Join (cream) control, then wait until the card is yours. */
export async function joinFromCard(page: Page, card: Locator = roomCard(page)): Promise<void> {
  await cardJoin(card).click();
  await expect(roomCard(page, 'yours')).toBeVisible();
}

/** "Open call" on your card, then wait for the call view. */
export async function openCall(page: Page): Promise<void> {
  await cardOpenCall(roomCard(page, 'yours')).click();
  await expect(callView(page)).toBeVisible();
}

/** "Back to chat" in the call view. */
export async function backToChat(page: Page): Promise<void> {
  await ix(callView(page), 'ix-call-back').click();
  await expect(callView(page)).toBeHidden();
}

/** Leave from the card's danger control (one click, no confirm). */
export async function leaveFromCard(page: Page): Promise<void> {
  await cardLeave(roomCard(page, 'yours')).click();
  await expect(roomCard(page, 'yours')).toHaveCount(0);
}

/**
 * Scroll the conversation. `to: 'bottom'` is the scroller's end (the busy
 * channel as a person lands on it); a number is `scrollTop` from the top (120
 * is the title folded into the toolbar). The scroller is the largest scrolling
 * element in `main`, so this holds across a restyle.
 */
export async function scrollConversation(page: Page, to: 'bottom' | number): Promise<void> {
  await page.evaluate((target) => {
    let best: HTMLElement | null = null;
    let bestArea = 0;
    for (const el of document.querySelectorAll<HTMLElement>('main *')) {
      const overflow = getComputedStyle(el).overflowY;
      if ((overflow !== 'auto' && overflow !== 'scroll') || el.scrollHeight <= el.clientHeight + 1) continue;
      const area = el.clientWidth * el.clientHeight;
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
    if (!best) throw new Error('scrollConversation: nothing in <main> scrolls');
    best.scrollTop = target === 'bottom' ? best.scrollHeight : target;
    best.dispatchEvent(new Event('scroll'));
  }, to);
}

/* ------------------------------------------------------------- navigation */

/**
 * Move to a route WITHOUT reloading the page: history push + popstate, which
 * the router follows. A reload would drop the fake call and every store; this
 * keeps them, which is what a person clicking the dock does too.
 */
export async function navigate(page: Page, route: string): Promise<void> {
  await page.evaluate((to) => {
    window.history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
  }, route);
}

/* ---------------------------------------------------------------- shooting */

/** Where a package's shots go: `output/design-reference/index-build/<WP>/` (gitignored). */
export function outDir(wp: string = process.env.PARACORD_E2E_INDEX_WP || 'latest'): string {
  return path.resolve(process.cwd(), '..', 'output', 'design-reference', 'index-build', wp);
}

/** The reference folder `index-reference.mjs` writes (1280x800, exact 1x). */
export const REFERENCE_DIR = path.resolve(process.cwd(), '..', 'output', 'design-reference', 'index', 'ref');

/** How long every §5 motion has to finish (the reference shots wait the same). */
export const SETTLE_MS = 1_600;

export const SIZES = {
  /** The reference's size: shots at it are held against `ref/<state>.png`. */
  reference: { width: 1280, height: 800 },
  desktop: { width: 1440, height: 900 },
  narrow: { width: 900, height: 700 },
  phone: { width: 390, height: 844 },
} as const;
export type SizeName = keyof typeof SIZES;

export interface ShootOptions {
  /** Which size this is (`reference` by default); sets the viewport and the file name. */
  size?: SizeName;
  /** Package folder; defaults to `PARACORD_E2E_INDEX_WP`. */
  wp?: string;
  /** Wait for motion to settle first (ms). Default `SETTLE_MS`. */
  settle?: number;
}

/**
 * Screenshot the page as a state. At the reference size the file is
 * `<state>.png` (what `index-compare.mjs` pairs with `ref/<state>.png`); at any
 * other size `<state>@<w>x<h>.png`. Returns the path.
 */
export async function shoot(page: Page, state: string, options: ShootOptions = {}): Promise<string> {
  const size = SIZES[options.size ?? 'reference'];
  const dir = outDir(options.wp);
  await mkdir(dir, { recursive: true });
  await page.setViewportSize(size);
  // Park the pointer somewhere inert: a hover left over a control opens its tooltip.
  await page.mouse.move(size.width - 3, size.height - 3);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(options.settle ?? SETTLE_MS);
  const file = path.join(dir, options.size && options.size !== 'reference' ? `${state}@${size.width}x${size.height}.png` : `${state}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

/** Wait for motion to settle (the reference shots do the same before every shot). */
export const settle = (page: Page, ms = SETTLE_MS): Promise<void> => page.waitForTimeout(ms);

/* ----------------------------------------------------------- the ten states */

export const REFERENCE_STATES = [
  's0-quiet',
  's0-plan-a-night',
  's0-message-box-open',
  's1-someone-arrives',
  's2-joined',
  's3-call-open',
  's4-other-server',
  's5-busy',
  's5-busy-title-folded',
  's6-people',
] as const;
export type ReferenceState = (typeof REFERENCE_STATES)[number];

export interface WalkOptions {
  /** `route` (default): move between places with a history push, which works before the dock exists. `ui`: click the dock and rows. */
  navigate?: 'route' | 'ui';
  /** Stop after this state (the page is left in it). */
  until?: ReferenceState;
  /** Called once the page is in each state, in order. */
  visit?: (state: ReferenceState) => Promise<void>;
}

/**
 * Walk the reference story on a freshly installed scene, as
 * `output/design-reference/index/ref/` was shot (`index-reference.mjs`): the
 * quiet server, Plan a night, the open message box, then the story, each state
 * reached the way a person reaches it. The world's own changes are steps
 * (`arrive`, `join`, `crowd`, `busy`); everything a person does is a driver.
 * Opening the call needs the room card and call view (the Index UI, IX-7 and
 * IX-13) and Plan a night needs the welcome (IX-15): a package that does not
 * have them yet walks with `until` set before the state it cannot reach.
 *
 *   const h = await installIndexScene(page);
 *   await walkStates(h, { visit: (state) => shoot(page, state) });
 */
export async function walkStates(h: IndexHarness, options: WalkOptions = {}): Promise<void> {
  const { page } = h;
  const ui = options.navigate === 'ui';
  let done = false;
  const reached = async (state: ReferenceState): Promise<boolean> => {
    await options.visit?.(state);
    if (options.until === state) done = true;
    return done;
  };
  const go = async (place: Place, route: string) => {
    if (ui) await goToPlace(page, place);
    else await navigate(page, route);
    await page.waitForTimeout(SETTLE_MS);
  };

  await h.open(h.routes.channel('fuelGeneral'));
  if (await reached('s0-quiet')) return;

  await clickActionCard(page, 'plan');
  await page.waitForTimeout(SETTLE_MS);
  if (await reached('s0-plan-a-night')) return;

  await typeInComposer(page, 'testing the box');
  await page.waitForTimeout(SETTLE_MS);
  if (await reached('s0-message-box-open')) return;

  // The story starts again from a quiet Fuel, with an empty message box.
  await clearComposer(page);
  await h.reload();

  await h.step('arrive');
  await page.waitForTimeout(SETTLE_MS);
  if (await reached('s1-someone-arrives')) return;

  await h.step('join');
  await page.waitForTimeout(SETTLE_MS);
  if (await reached('s2-joined')) return;

  await h.setClock(CLOCK.call);
  await openCall(page);
  await page.waitForTimeout(SETTLE_MS);
  if (await reached('s3-call-open')) return;

  // The prototype closes the call first, then visits Game Night still in it.
  await backToChat(page);
  await h.setClock(CLOCK.visit);
  await go('gameNight', h.routes.place('gameNight'));
  if (await reached('s4-other-server')) return;

  await go('fuel', h.routes.channel('fuelGeneral'));
  await h.step('crowd');
  await h.step('busy', { pace: 0 });
  await page.waitForTimeout(SETTLE_MS);
  await scrollConversation(page, 'bottom');
  if (await reached('s5-busy')) return;

  await scrollConversation(page, 120);
  if (await reached('s5-busy-title-folded')) return;

  await go('people', h.routes.place('people'));
  await reached('s6-people');
}

/** Reach one reference state on a freshly installed scene (the page is left in it). */
export async function reachState(h: IndexHarness, state: ReferenceState, options: Omit<WalkOptions, 'until'> = {}): Promise<void> {
  await walkStates(h, { ...options, until: state });
}
