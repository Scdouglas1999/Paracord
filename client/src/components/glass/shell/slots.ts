import type { ReactNode } from 'react';
import type { OpenStageMode, StageTarget } from '../../../stores/glassStore';
import type { GlassLayout } from './useGlassLayout';

/**
 * The Glass frame's slot contract (WP-G7; docs/design/glass-g7-checkpoint.md).
 *
 * The shell owns geometry: where each pane sits, its size, gutters, radius and
 * surface. Each slot owns only what is inside its pane. A slot component is
 * exported from `components/glass/<slot>/index.ts`; today every one of those
 * files re-exports a stub from `shell/stubs/` that renders the existing
 * (Lantern) component, and the package that owns the directory replaces the
 * export with its own implementation of the SAME props. Changing a props type
 * here is a change to the contract: every consumer listed beside it has to
 * agree.
 *
 *   slot              exported from                 owner   mounted by
 *   RoomBackdrop      components/glass/room         G8      GlassFrame (behind everything)
 *   PlacesPanel       components/glass/places       G9      GlassFrame (pane, browse) + PlacesOverlay
 *   ConversationPane  components/glass/conversation G11     GuildPage, TextChannelView, DMPage
 *   CallPill          components/glass/pill         G12     ConversationPane's header
 *   Stage             components/glass/stage        G14     GlassFrame (while glassStore.stage is open)
 *   Sheets            components/glass/sheets       G18     GlassFrame (after the conversation pane)
 */

/* ---- RoomBackdrop (G8) ------------------------------------------------------ */

export interface RoomBackdropProps {
  /**
   * The server whose room lights the window: the route's guild, or null on
   * Home, DMs and other routes with no server (the room then rests on the
   * neutral base). The backdrop picks its own source inside that server
   * (busiest live channel, else banner, else icon).
   */
  guildId: string | null;
}

/* ---- PlacesPanel (G9) ------------------------------------------------------- */

/**
 * How the places panel is being shown. The shell paints the pane surface
 * (radius, fill, shadow) and sizes it at 316px; the panel fills it.
 *
 *   pane     the permanent left pane, window >= 860px, nothing on stage
 *   overlay  below 860px, opened from the header (glassStore.placesOverlayOpen)
 *   browse   slid back in over or beside the stage (glassStore.browseOpen)
 */
export type PlacesPresentation = 'pane' | 'overlay' | 'browse';

export interface PlacesPanelProps {
  presentation: PlacesPresentation;
  /**
   * Closes the overlay or browse presentation. Absent for `pane`. The shell
   * already closes both when the route changes, so a row only has to navigate.
   */
  onClose?: () => void;
}

/* ---- ConversationPane (G11; G10 restyles the timeline in place) --------------- */

/**
 * What the conversation is: the header renders from this, so the pages never
 * build a header themselves. G11 replaces the header without touching pages.
 */
export type ConversationSubject =
  | {
      kind: 'channel';
      guildId: string;
      guildName?: string;
      channelId: string;
      channelName: string;
      topic?: string | null;
      /** Forum channels keep their own body but share the header. */
      isForum?: boolean;
    }
  | {
      kind: 'dm';
      channelId: string;
      /** The person's name, or the group's title. */
      title: string;
      isGroup: boolean;
    };

export interface ConversationPaneProps {
  subject: ConversationSubject;
  /**
   * Strips between the header and the timeline: a thread's origin line, the
   * welcome and onboarding gates, a pinned score, a DM call's stream. Rendered
   * in the column.
   */
  notices?: ReactNode;
  /** The timeline (MessageList). Full pane width; its rows sit in the column. */
  timeline: ReactNode;
  /** The message box (MessageInput), column width. */
  composer?: ReactNode;
  /**
   * Controls docked under the composer (a DM call's control bar) until the call
   * pill (G12) carries them.
   */
  dock?: ReactNode;
}

/* ---- CallPill (G12) --------------------------------------------------------- */

export interface CallPillProps {
  /**
   * The server the conversation belongs to, or null in a DM. The pill decides
   * which call it shows (the one you are in, else this server's busiest live
   * channel, else a live channel elsewhere named with its server).
   */
  guildId: string | null;
  /** `row` is the desktop header capsule; `stacked` the phone's two rows (§8). */
  layout: 'row' | 'stacked';
}

/* ---- Stage (G14, G15) -------------------------------------------------------- */

export interface StageProps {
  target: StageTarget;
  mode: OpenStageMode;
}

/* ---- Sheets (G18) ----------------------------------------------------------- */

export interface SheetsProps {
  /** The route's server and channel (either may be null: Home, DMs). */
  guildId: string | null;
  channelId: string | null;
  /**
   * `wide` and `compact` mount the slot as the frame's last flex child (after
   * the conversation pane); `phone` mounts it over the whole window. The slot
   * decides whether anything is open and renders nothing when not.
   */
  layout: GlassLayout;
}
