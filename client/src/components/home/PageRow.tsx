import type { ReactNode } from 'react';

import { cn } from '../../lib/utils';
import { GlassChip, InstrumentText } from '../glass/primitives';
import { Face } from '../glass/places/Lead';
import { badgeWords, type Badge, type FaceModel } from '../glass/places/model';

/**
 * A row on a page in the conversation pane: the places panel's row (docs/glass-spec.md
 * §3.1) at page width. A 44px lead, a name (15/600) over one line (13, ink-2), the
 * time in the instrument cut, and one badge or decision at the end. Rows are
 * content, so they carry no outline; hover is a wash, and a selected row keeps
 * its own fill.
 *
 * The row's body is one control (a link or a button) and the decisions beside it
 * are siblings, never children of it: a button inside a button is not a control.
 */

export interface PageRowProps {
  lead: ReactNode;
  title: ReactNode;
  /** One line under the name. */
  line?: ReactNode;
  /** Let the line run to two lines instead of one. */
  wrap?: boolean;
  /** A time and a badge at the end of the body, right-aligned. */
  aside?: ReactNode;
  /** Decisions beside the body: text buttons. */
  actions?: ReactNode;
  /** Makes the body a button. It is handed the body, for a card that anchors to it. */
  onOpen?: (anchor: HTMLElement) => void;
  /** Makes the body a link (a real address); `onOpen` still runs on a plain click. */
  href?: string;
  /** The body's accessible name when the visible text is not it. */
  label?: string;
  /** Ids of the text that describes the body (the reason and the context). */
  describedBy?: string;
  /** Ids for the name and the line, so `describedBy` can point at them. */
  titleId?: string;
  lineId?: string;
  selected?: boolean;
  /** Nothing new for a long time: the ink steps down. */
  quiet?: boolean;
  /** They are not here: the face steps down. */
  offline?: boolean;
  as?: 'li' | 'div';
  dataKey?: string;
  className?: string;
}

export function PageRow({
  lead,
  title,
  line,
  wrap,
  aside,
  actions,
  onOpen,
  href,
  label,
  describedBy,
  titleId,
  lineId,
  selected,
  quiet,
  offline,
  as: Tag = 'li',
  dataKey,
  className,
}: PageRowProps) {
  const body = (
    <>
      {lead}
      <span className="glass-prow__body">
        <span id={titleId} className="glass-name glass-prow__name">{title}</span>
        {line ? (
          <span id={lineId} className="glass-prow__line" data-wrap={wrap ? '' : undefined}>
            {line}
          </span>
        ) : null}
      </span>
      {aside ? <span className="glass-prow__aside">{aside}</span> : null}
    </>
  );
  const shared = {
    className: 'glass-prow__main glass-focusable',
    'aria-label': label,
    'aria-describedby': describedBy,
  } as const;

  let main: ReactNode;
  if (href && onOpen) {
    main = (
      <a
        href={href}
        {...shared}
        aria-current={selected ? 'page' : undefined}
        onClick={(event) => {
          // A modifier click or a middle click is the browser's; a plain one opens.
          if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          onOpen(event.currentTarget);
        }}
      >
        {body}
      </a>
    );
  } else if (onOpen) {
    main = (
      <button type="button" {...shared} onClick={(event) => onOpen(event.currentTarget)}>
        {body}
      </button>
    );
  } else {
    main = <div className="glass-prow__main">{body}</div>;
  }

  return (
    <Tag
      data-conversation-key={dataKey}
      data-pressable={onOpen ? '' : undefined}
      data-selected={selected ? '' : undefined}
      data-quiet={quiet ? '' : undefined}
      data-offline={offline ? '' : undefined}
      className={cn('glass-prow', className)}
    >
      {main}
      {actions ? <span className="glass-prow__actions">{actions}</span> : null}
    </Tag>
  );
}

/** The time at the end of a row: the instrument cut, ink-3. */
export function RowTime({ children, dateTime }: { children: ReactNode; dateTime?: string }) {
  return (
    <InstrumentText dateTime={dateTime} className="glass-prow__time">
      {children}
    </InstrumentText>
  );
}

export interface PagePersonProps {
  face: FaceModel;
  size?: number;
  /** `online`, `idle`, `dnd`, `offline`, `invisible`; nothing draws no mark. */
  status?: string | null;
  /** They are in a voice room right now: the mark is amber. */
  live?: boolean;
}

/** A face with the mark that says whether they are here. The mark is ink, not color. */
export function PagePerson({ face, size = 44, status, live }: PagePersonProps) {
  return (
    <span className="glass-person" style={{ width: size, height: size }}>
      <Face face={face} size={size} />
      {status ? <span className="glass-presence" data-status={live ? 'online' : status} data-live={live ? '' : undefined} aria-hidden="true" /> : null}
    </span>
  );
}

/**
 * The badge at the end of a row, as the places panel draws it: a white chip for a
 * mention (it is for you), a gray one for a count, a dot for unread with no count
 * to back. The words are for assistive tech.
 */
export function RowBadge({ badge }: { badge: Badge | null }) {
  if (!badge) return null;
  const words = badgeWords(badge);
  return (
    <>
      {badge.kind === 'dot' ? (
        <span className="glass-place-dot" aria-hidden="true" />
      ) : (
        <GlassChip tone={badge.kind === 'mention' ? 'mention' : 'count'} aria-hidden="true">
          {badge.label}
        </GlassChip>
      )}
      {words ? <span className="sr-only">{words}</span> : null}
    </>
  );
}
