import type { Place } from './place';

/**
 * The Index frame's slot contract (docs/design/index-plan.md §1.3; checkpoint
 * docs/design/index-checkpoints/IX-4.md).
 *
 * The shell (`IxFrame`) owns GEOMETRY: the two flush columns, where each slot's
 * host sits, its size, inset and radius, what is `inert`, the window tint, the
 * place slide and the toolbar. A slot owns only what is inside its host. Each
 * slot is a component exported from `components/ix/<dir>/index.ts`; IX-4 wrote a
 * stub there and the package named below replaces it with its own implementation
 * of the SAME props. Changing a props type here is a change to the contract.
 *
 *   slot         exported from            owner  mounted by IxFrame in
 *   SidebarSlot  components/ix/sidebar    IX-5   each sidebar pane (.ix-pane), one
 *                                                per place; two at once while the
 *                                                place slides (§5.1)
 *   DockSlot     components/ix/dock       IX-6   .ix-side__dock, under the panes
 *                                                (desktop: the sidebar's foot;
 *                                                phone: the root screen's foot)
 *   CardSlot     components/ix/card       IX-7   position="pinned": .ix-side__pinned,
 *                                                above the panes, outside the slide
 *                                                (it never slides, §5.4);
 *                                                position="inline": rendered BY
 *                                                SidebarSlot under its search field
 *                                                (IX-5 places it, IX-7 fills it)
 *   CallSlot     components/ix/call       IX-13  .ix-call-host, over main at inset 10
 *                                                (theater: over the window)
 *   SheetSlot    components/ix/sheets     IX-9   inside main, after the page; the
 *                                                sheet host (#ix-sheet-host) is
 *                                                the geometry it fills
 *
 * People: `SidebarSlot` gets `{ kind: 'people' }` and hands it to IX-14's
 * `PeopleSidebar` (components/ix/people). That dispatch line belongs to IX-5.
 */

/* ---- SidebarSlot (IX-5) ---------------------------------------------------- */

export interface SidebarSlotProps {
  /**
   * The place this pane shows. NOT necessarily the route's: while the place
   * slides, the leaving pane keeps rendering the old place for 205ms. Read the
   * place from here, never from the route, and key per-place state on it.
   * The pane (`.ix-pane`) is the scroller, padding 16 12 8, flex column with
   * children that never shrink; the slot renders its sections as children.
   */
  place: Place;
  /** True for the pane that is sliding out: it is `inert` and `aria-hidden`; skip side effects (focus, scroll-into-view, pings). */
  leaving?: boolean;
}

/* ---- DockSlot (IX-6) ------------------------------------------------------- */

/**
 * No props: the dock reads the current place from `useIxShell().place` and the
 * order from `usePlaceOrder()` (both from components/ix/shell). It renders the
 * whole `toolbar` named "Servers" (test id `ix-dock`, items `ix-dock-item` with
 * `data-place` = `placeKey(place)`), and switches place by navigating; the shell
 * follows the route.
 */
export type DockSlotProps = Record<string, never>;

/* ---- CardSlot (IX-7) ------------------------------------------------------- */

export type CardPosition = 'pinned' | 'inline';

export interface CardSlotProps {
  /** The place the sidebar shows (for a pinned card: the CURRENT place; for inline: the pane's place). */
  place: Place;
  /**
   * `pinned`: above the sidebar header, outside the panes; shows your call when
   * it belongs to ANOTHER place (with its server line), or an incoming call;
   * renders null otherwise (the host collapses when empty).
   * `inline`: under the search field in the pane; the place's own card (your
   * call here, else the busiest room, §4.3); null when there is none.
   */
  position: CardPosition;
}

/* ---- CallSlot (IX-13) ------------------------------------------------------ */

/**
 * No props: the call view reads `glassStore.stage` (mode, target, `chat`). It is
 * ALWAYS mounted, so it can play its own open and close (§5.8) and decide when
 * to render nothing. Its host (`.ix-call-host`) is geometry only, pointer-events
 * none (the slot's root takes them back): over main at inset 10 while
 * `stage.mode` is 'main', over the whole window at inset 10 in
 * 'theater'. The surface itself (radius 24, `--ix-call`, the call shadow) is the
 * slot's: `.ix-inset-surface` gives it.
 */
export type CallSlotProps = Record<string, never>;

/* ---- SheetSlot (IX-9) ------------------------------------------------------ */

/**
 * No props: the route's ids are `useIxShell()`'s. Sheets open inside main on its
 * right. The host `#ix-sheet-host` (`.ix-sheet-host`, `data-sheet` = the open
 * `glassStore.sheet`) is the geometry: inset 10, width 400 (480 for search),
 * radius 24, full inset when main is narrower than 760px; pointer-events none
 * so an empty host never blocks the conversation. Render (or portal) the sheet
 * into it and let it fill the host (`position: absolute; inset: 0`).
 */
export type SheetSlotProps = Record<string, never>;

/** The sheet host's element id (portal target for `SheetFrame`). */
export const IX_SHEET_HOST_ID = 'ix-sheet-host';
/** The call host's element id. */
export const IX_CALL_HOST_ID = 'ix-call-host';
