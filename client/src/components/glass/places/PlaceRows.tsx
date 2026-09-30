import { activityLine } from '../../../lib/together/model';
import { useTogetherActivity } from '../../../stores/togetherStore';
import type { MouseEvent, ReactNode } from 'react';

import { InstrumentText } from '../primitives/InstrumentText';
import { GlassChip } from '../primitives/Chip';
import { Waveform } from '../primitives/Waveform';
import { FaceStack, GlyphTile, LeadFaces, MediaLead, PlaceGlyph, type PlaceGlyphName } from './Lead';
import type { Badge, EventTile } from './model';
import type { LiveRowModel, QuietRowModel, RowLead, TextRowModel } from './rows';
import { cn } from '../../../lib/utils';

/**
 * The rows of the places panel (docs/glass-spec.md §3.1; reference screens 01,
 * 02, 06). A row is a link: it has an address, opens with Enter, and a modifier
 * click is left to the browser. Every row is one tab stop of the panel's roving
 * list (`RowFocus`).
 */

/** What every focusable row of the panel needs from the roving list. */
export interface RowFocus {
  /** Roving tabindex: 0 for the one stop, -1 for the rest. */
  tabIndex: 0 | -1;
  onFocus: () => void;
}

interface RowLinkProps extends RowFocus {
  id: string;
  href?: string;
  selected?: boolean;
  onOpen: () => void;
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void;
  className: string;
  children: ReactNode;
  label?: string;
  hasPopup?: 'menu' | 'dialog';
  expanded?: boolean;
}

/** An anchor with an address, or a button when the row has none (a popover trigger). */
function RowLink({
  id,
  href,
  selected,
  onOpen,
  onContextMenu,
  tabIndex,
  onFocus,
  className,
  children,
  label,
  hasPopup,
  expanded,
}: RowLinkProps) {
  const shared = {
    className: cn('glass-focusable', className),
    'data-place-row': '',
    'data-row-id': id,
    'data-selected': selected ? '' : undefined,
    'aria-label': label,
    'aria-haspopup': hasPopup,
    'aria-expanded': expanded,
    tabIndex,
    onFocus,
    onContextMenu,
  } as const;
  if (!href) {
    return (
      <button type="button" {...shared} onClick={onOpen}>
        {children}
      </button>
    );
  }
  return (
    <a
      href={href}
      {...shared}
      aria-current={selected ? 'page' : undefined}
      onClick={(event) => {
        // A modifier click or a middle click is the browser's; a plain one opens.
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onOpen();
      }}
    >
      {children}
    </a>
  );
}

function LeadOf({ lead }: { lead: RowLead }) {
  switch (lead.kind) {
    case 'faces':
      return <LeadFaces faces={lead.faces} variant={lead.variant} online={lead.online} />;
    case 'media':
      return <MediaLead attachmentId={lead.attachmentId} />;
    default:
      return <GlyphTile glyph={lead.glyph} />;
  }
}

function BadgeChip({ badge }: { badge: Badge }) {
  if (badge.kind === 'dot') return <span className="glass-place-dot" aria-hidden="true" />;
  return (
    <GlassChip tone={badge.kind === 'mention' ? 'mention' : 'count'} aria-hidden="true">
      {badge.label}
    </GlassChip>
  );
}

/* ---- Text row: 64px ---------------------------------------------------------- */

export interface TextRowProps extends RowFocus {
  row: TextRowModel;
  href: string | undefined;
  onOpen: () => void;
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void;
}

export function TextRow({ row, href, onOpen, onContextMenu, tabIndex, onFocus }: TextRowProps) {
  const line = row.line ?? row.lineNote;
  return (
    <RowLink
      id={row.id}
      href={href}
      selected={row.selected}
      onOpen={onOpen}
      onContextMenu={onContextMenu}
      tabIndex={tabIndex}
      onFocus={onFocus}
      className="glass-place-row"
    >
      <LeadOf lead={row.lead} />
      <span className="glass-place-row__body">
        <span className="glass-name glass-place-row__name">{row.name}</span>
        {line ? <span className="glass-place-row__line">{line}</span> : null}
      </span>
      {(row.time || row.badge) && (
        <span className="glass-place-row__aside">
          {row.time && (
            <InstrumentText dateTime={row.timeIso ?? undefined} className="glass-place-row__time">
              {row.time}
            </InstrumentText>
          )}
          {row.badge && <BadgeChip badge={row.badge} />}
          {row.badgeWords && <span className="sr-only">{row.badgeWords}</span>}
        </span>
      )}
    </RowLink>
  );
}

/* ---- Quiet row: 44px ---------------------------------------------------------- */

export interface QuietRowProps extends RowFocus {
  row: QuietRowModel;
  href: string | undefined;
  onOpen: () => void;
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void;
}

export function QuietRow({ row, href, onOpen, onContextMenu, tabIndex, onFocus }: QuietRowProps) {
  return (
    <RowLink
      id={row.id}
      href={href}
      selected={row.selected}
      onOpen={onOpen}
      onContextMenu={onContextMenu}
      tabIndex={tabIndex}
      onFocus={onFocus}
      className="glass-place-row glass-place-row--quiet"
    >
      <span className="glass-place-row__glyph" aria-hidden="true">
        <PlaceGlyph name={row.glyph} size={17} />
      </span>
      <span className="glass-place-row__name glass-place-row__name--quiet">{row.name}</span>
      {row.time && (
        <InstrumentText dateTime={row.timeIso ?? undefined} className="glass-place-row__time">
          {row.time}
        </InstrumentText>
      )}
    </RowLink>
  );
}

/* ---- Live row: 92px ----------------------------------------------------------- */

export interface LiveRowProps extends RowFocus {
  row: LiveRowModel;
  href: string | undefined;
  onOpen: () => void;
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void;
}

/**
 * A voice channel with somebody in it. Today it carries the room's own tint; a
 * live thumbnail of the stream replaces the tint when the room and stage
 * packages land (docs/glass-spec.md §3.1). Watch opens the stage when somebody is
 * streaming; with nobody streaming there is nothing to watch, so the row opens
 * the channel itself.
 */
export function LiveRow({ row, href, onOpen, onContextMenu, tabIndex, onFocus }: LiveRowProps) {
  // What the room watches or listens to together, when it does: that is what
  // the room is doing, so it is the row's line.
  const together = useTogetherActivity(row.channelId);
  const line = together ? activityLine(together.kind, together.title) : row.line;
  return (
    <RowLink
      id={row.id}
      href={href}
      selected={row.selected}
      onOpen={onOpen}
      onContextMenu={onContextMenu}
      tabIndex={tabIndex}
      onFocus={onFocus}
      className="glass-place-live"
    >
      <span className="glass-place-live__scene" aria-hidden="true" />
      <span className="glass-place-live__shade" aria-hidden="true" />
      <span className="glass-place-live__body">
        <span className="glass-place-live__head">
          <span className="glass-name">{row.name}</span>
          <InstrumentText className="glass-place-live__kicker">{row.kicker}</InstrumentText>
        </span>
        <span className="glass-place-live__meta">
          <FaceStack faces={row.occupants} size={22} overlap={7} className="glass-place-live__faces" />
          {row.more > 0 && <InstrumentText className="glass-place-live__more">+{row.more}</InstrumentText>}
          {row.talking && <Waveform />}
          <span className="glass-place-live__line" data-together={together ? together.kind : undefined}>{line}</span>
        </span>
        <span className="sr-only">In the room: {row.people.join(', ')}</span>
      </span>
    </RowLink>
  );
}

/* ---- Rows with a glyph tile: add-ons ------------------------------------------ */

export interface GlyphRowProps extends RowFocus {
  id: string;
  href?: string;
  glyph: PlaceGlyphName;
  name: string;
  line: string | null;
  selected?: boolean;
  badge?: Badge | null;
  badgeWords?: string | null;
  onOpen: () => void;
  hasPopup?: 'menu' | 'dialog';
  expanded?: boolean;
}

/** An add-on (Sports, Daily word, Game servers) drawn as a channel row. */
export function GlyphRow({
  id,
  href,
  glyph,
  name,
  line,
  selected,
  badge,
  badgeWords,
  onOpen,
  hasPopup,
  expanded,
  tabIndex,
  onFocus,
}: GlyphRowProps) {
  return (
    <RowLink
      id={id}
      href={href}
      selected={selected}
      onOpen={onOpen}
      tabIndex={tabIndex}
      onFocus={onFocus}
      className="glass-place-row"
      hasPopup={hasPopup}
      expanded={expanded}
    >
      <GlyphTile glyph={glyph} />
      <span className="glass-place-row__body">
        <span className="glass-name glass-place-row__name">{name}</span>
        {line ? <span className="glass-place-row__line">{line}</span> : null}
      </span>
      {badge && (
        <span className="glass-place-row__aside">
          <BadgeChip badge={badge} />
          {badgeWords && <span className="sr-only">{badgeWords}</span>}
        </span>
      )}
    </RowLink>
  );
}

/* ---- Coming up ----------------------------------------------------------------- */

export interface EventRowProps extends RowFocus {
  id: string;
  title: string;
  line: string;
  tile: EventTile;
  href: string | undefined;
  onOpen: () => void;
}

/** An event: a 44px date tile in the instrument cut, its title, and one line. */
export function EventRow({ id, title, line, tile, href, onOpen, tabIndex, onFocus }: EventRowProps) {
  return (
    <RowLink id={id} href={href} onOpen={onOpen} tabIndex={tabIndex} onFocus={onFocus} className="glass-place-row">
      <span className="glass-lead glass-lead--date">
        <InstrumentText className="glass-lead__date-top">{tile.top}</InstrumentText>
        <InstrumentText className="glass-lead__date-bottom">{tile.bottom}</InstrumentText>
      </span>
      <span className="glass-place-row__body">
        <span className="glass-name glass-place-row__name">{title}</span>
        <span className="glass-place-row__line">{line}</span>
      </span>
    </RowLink>
  );
}
