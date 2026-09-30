import type * as React from 'react';
import type { ReactNode } from 'react';

import { cn } from '../../lib/utils';
import { HeaderAvatar } from '../glass/conversation/HeaderAvatar';
import { Kicker } from '../glass/primitives';

/**
 * The scaffold every page inside the conversation pane shares (docs/glass-spec.md
 * §3, §3.2): a 76px bar with the title on the column's left edge and what you
 * can do on its right edge, your face at the pane's own right edge, and a
 * scroller under it whose content sits in the 720px column. Styles:
 * `styles/glass-pages.css`.
 *
 * A conversation has its own header (`glass/conversation`); this is the header
 * of everything that is not one, so a page and a conversation put their title
 * in the same place and the switch between them does not jump.
 */

export interface GlassPageProps {
  /** The region's name, for assistive tech. */
  label: string;
  children: ReactNode;
  className?: string;
}

export function GlassPage({ label, children, className }: GlassPageProps) {
  return (
    <section aria-label={label} className={cn('glass-page', className)}>
      {children}
    </section>
  );
}

export interface PageBarProps {
  /** The page's one `<h1>`. */
  title: ReactNode;
  /** The line under it: a count, a place, what needs you. */
  line?: ReactNode;
  /** Decisions for this page, right-aligned to the column. */
  actions?: ReactNode;
  /** Your face at the pane's right edge, as the conversation header has it. Default true. */
  avatar?: boolean;
}

export function PageBar({ title, line, actions, avatar = true }: PageBarProps) {
  return (
    <header className="glass-page__bar">
      <div className="glass-page__heading">
        <h1 className="glass-page__title">{title}</h1>
        {line ? <p className="glass-page__sub">{line}</p> : null}
      </div>
      {actions ? <div className="glass-page__actions">{actions}</div> : null}
      {avatar ? (
        <div className="glass-page__tools">
          <HeaderAvatar />
        </div>
      ) : null}
    </header>
  );
}

/** The scroller: its content is the 720px column. */
export function PageScroll({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('glass-page__scroll', className)}>{children}</div>;
}

export interface PageSectionProps extends Omit<React.HTMLAttributes<HTMLElement>, 'children' | 'className' | 'title'> {
  /** The kicker over the group. */
  kicker: string;
  /** Amber for what is live; ink for everything else. */
  tone?: 'ink' | 'amber';
  /** A count, in the instrument cut. */
  count?: number | string | null;
  /** A decision for the whole group, at the right: a text button. */
  aside?: ReactNode;
  /** Names the region when the kicker alone is not enough. */
  label?: string;
  /** Rows are a list when true (default). Set false to place your own children. */
  list?: boolean;
  /** After the rows: "Show more". */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function PageSection({ kicker, tone = 'ink', count, aside, label, list = true, footer, children, className, ...rest }: PageSectionProps) {
  return (
    <section aria-label={label ?? kicker} className={cn('glass-sec', className)} {...rest}>
      <div className="glass-sec__head">
        <Kicker as="h2" tone={tone === 'amber' ? 'amber' : 'ink'} className="glass-sec__kicker">
          {kicker}
        </Kicker>
        {count !== null && count !== undefined && count !== '' ? (
          <span className="glass-instrument glass-sec__count">{count}</span>
        ) : null}
        {aside ? <span className="glass-sec__aside">{aside}</span> : null}
      </div>
      {list ? <ul className="glass-sec__rows">{children}</ul> : children}
      {footer ? <div className="glass-sec__footer">{footer}</div> : null}
    </section>
  );
}

/** A quiet sentence in a section: nothing here, or why. 13px, ink-3. */
export function PageNote({ children, role }: { children: ReactNode; role?: 'status' | 'alert' }) {
  return (
    <p role={role} className="glass-sec__note">
      {children}
    </p>
  );
}
