import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { AppMark } from '../components/brand/AppMark';
import { cn } from '../lib/utils';

/**
 * Shared building blocks for the unauthenticated entry surfaces (login,
 * register, connect, invite, account setup/recover/unlock, first-owner setup,
 * bot authorize).
 *
 * These are the first screens anyone sees, so they are held to the same law as
 * the rest of the app (docs/lantern-stage-spec.md §4): **one plate, centred on
 * the street.** Gabarito for the title, Onest for the body, the emerald for the
 * one action. No gradient hero, no marketing rail, no illustration filler —
 * the building is dark until somebody is in it.
 */

/** The app mark, re-exported for the entry surfaces that import it from here. */
export { AppMark };

/**
 * Full-page canvas: the street (`--bg-base`), flat and matte.
 *
 * **The fit law.** At the desktop client's window sizes — 1280×800 default,
 * 940×560 minimum (`client/src-tauri/tauri.conf.json`) — a first-run surface
 * does not scroll. A native window that scrolls its whole self reads like a
 * webpage someone wrapped in a frame, and it puts the one action below the
 * fold. So from `sm` up the canvas is exactly the window and clips nothing
 * out of it: {@link AuthCard} is bounded to the same height, and the one
 * region inside a plate that may scroll is {@link AuthScroll}, which leaves
 * the heading and the action where they are.
 *
 * Below `sm` this is a browser at phone width, where a page that scrolls is
 * the normal and correct thing — that behaviour is unchanged.
 */
export function AuthCanvas({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      role="region"
      aria-label="Account access"
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard users must be able to scroll this viewport with Page Up/Down and Home/End.
      tabIndex={0}
      className={cn('h-dvh w-full overflow-y-auto bg-bg-base sm:overflow-hidden', className)}
    >
      <div className="flex min-h-full w-full items-center justify-center px-4 py-10 sm:h-full sm:min-h-0 sm:py-6">
        {children}
      </div>
    </div>
  );
}

/**
 * One plate on the street: `--bg-plate`, the plate radius and the plate shadow.
 *
 * A column, and bounded by the window from `sm` up — see {@link AuthCanvas}.
 * `min-h-0` is what lets an {@link AuthScroll} inside it actually shrink
 * instead of pushing the action off the bottom of a flex parent.
 */
export function AuthCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('pc-plate flex w-full min-h-0 flex-col p-0 sm:max-h-full', className)}>
      {children}
    </div>
  );
}

/**
 * The padded column inside a plate: `.pc-auth-form` in primitives.css, which
 * owns the rhythm and tightens it once when the window is short. Used as the
 * className of a `<form>` or a plain `<div>`, so it is a constant rather than a
 * component.
 */
export const AUTH_FORM = 'pc-auth-form';

/**
 * The one region inside a plate that is allowed to scroll, for the surface
 * that genuinely cannot fit 940×500 (a 24-word phrase, a list of servers).
 * Everything above and below it — the heading, the error, the action — stays
 * put, so "Continue" is never below a fold.
 */
export function AuthScroll({
  children,
  className,
  paired,
}: {
  children: ReactNode;
  className?: string;
  /** Lay the fields out in two columns when the window is short and wide. */
  paired?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Which way there is more. A bounded region that gives no sign it is bounded
  // is worse than a page that scrolls: the fields below the cut simply look
  // missing. The cue is a hairline (§1.6) drawn as an inset shadow so it costs
  // no layout — a 1px border here could flip the very overflow it reports.
  const [edges, setEdges] = useState<'top' | 'bottom' | 'both' | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => {
      const above = node.scrollTop > 1;
      const below = node.scrollTop + node.clientHeight < node.scrollHeight - 1;
      setEdges(above && below ? 'both' : above ? 'top' : below ? 'bottom' : null);
    };
    update();
    node.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(node);
    for (const child of Array.from(node.children)) observer.observe(child);
    return () => {
      node.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, [children]);

  return (
    <div
      ref={ref}
      data-overflow={edges ?? undefined}
      className={cn('pc-auth-fields', paired && 'is-paired', className)}
    >
      {children}
    </div>
  );
}

/**
 * Move focus to the control a rejection names, so fixing it is one keystroke
 * away rather than a hunt. Runs after the step's own "focus my first field",
 * because a parent effect runs after its children's.
 */
export function useFocusRejectedField(
  formRef: RefObject<HTMLFormElement | null>,
  rejection: unknown,
) {
  useEffect(() => {
    if (!rejection) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [formRef, rejection]);
}

/**
 * Heading block: optional app mark, a Gabarito title, and one specific line of
 * `--text-secondary` subcopy.
 */
export function AuthHeading({
  title,
  subtitle,
  mark = true,
  align = 'left',
  dense,
}: {
  title: string;
  subtitle?: ReactNode;
  mark?: boolean;
  align?: 'left' | 'center';
  /**
   * Drop the subcopy when the window is short — see {@link AuthStep}'s `dense`.
   * A sentence you cannot see costs less than a field you cannot see.
   */
  dense?: boolean;
}) {
  return (
    <div className={cn(align === 'center' && 'flex flex-col items-center text-center')}>
      {mark && <AppMark size={48} className="mb-3" />}
      <h1 className="pc-display text-title text-text-primary">{title}</h1>
      {subtitle && (
        <p
          className={cn(
            'mt-2 max-w-prose text-body text-text-secondary',
            dense && 'short-window:hidden',
          )}
        >
          {subtitle}
        </p>
      )}
    </div>
  );
}

/** Sentence-case label above a control (spec §2 Label step, §6.8). */
export function FieldLabel({
  children,
  required,
}: {
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <span className="mb-1.5 flex items-center gap-1 text-label font-medium text-text-secondary">
      {children}
      {required && (
        <span className="text-accent-danger" aria-hidden>
          *
        </span>
      )}
    </span>
  );
}

/**
 * A labelled field wrapper. The `<label>` wraps its control so the accessible
 * name comes from the label text; hint/error render outside the label so they
 * never pollute that name.
 */
export function Field({
  label,
  required,
  hint,
  error,
  descriptionId,
  className,
  children,
}: {
  label: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  error?: string | null;
  /** Reference this from the control's aria-describedby. */
  descriptionId?: string;
  /** `pc-auth-span` to keep the full measure inside a paired region. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <label className="block">
        <FieldLabel required={required}>{label}</FieldLabel>
        {children}
      </label>
      {error ? (
        <p id={descriptionId} className="mt-2 flex items-start gap-1.5 text-meta text-accent-danger">
          <AlertCircle size={13} className="mt-px shrink-0" />
          <span className="leading-relaxed">{error}</span>
        </p>
      ) : (
        hint && (
          <p id={descriptionId} className="mt-2 text-meta leading-relaxed text-text-faint">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

/** Success callout — a well carrying the emerald ink, never a green fill. */
export function SuccessNote({ children }: { children: ReactNode }) {
  return (
    <div className="pc-well flex items-start gap-2.5 px-4 py-3 text-label text-accent-success">
      <CheckCircle2 size={16} className="mt-px shrink-0" />
      <span className="leading-relaxed [&_strong]:font-semibold">{children}</span>
    </div>
  );
}

/**
 * A wizard's progress, in the two forms it has to take: a counted line a
 * screen reader can read out, and a row of segments the eye reads at a glance.
 *
 * The segments are 3px bars, not numbered circles: a badge loud enough to be a
 * circle outranks the step it counts (§6.8), and four of them across the top
 * of a plate is the same tiling the kill-list rejects. Done and current carry
 * the emerald; the rest carry the plate's own wash.
 */
export function AuthSteps({
  step,
  count,
  id,
}: {
  /** 1-based. */
  step: number;
  count: number;
  id?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p id={id} className="pc-mono text-meta tabular-nums text-text-faint">
        Step {step} of {count}
      </p>
      <div className="flex items-center gap-1.5" aria-hidden="true">
        {Array.from({ length: count }, (_, index) => (
          <span
            key={index}
            className={cn(
              'h-[3px] flex-1 rounded-[var(--radius-full)] transition-colors duration-[var(--duration-normal)] ease-[var(--ease-out)]',
              index < step ? 'bg-accent-primary' : 'bg-bg-mod-strong',
            )}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One step of a wizard: a labelled group that announces itself when it
 * arrives, and puts the cursor in its first field so the flow is completable
 * from the keyboard alone.
 *
 * The whole header is the live region rather than a separate announcement, so
 * the step is read once — "Step 2 of 4, create the owner account, this account
 * administers the server" — instead of twice in two different voices. Moving
 * between steps is a thing the user did, so it gets the §5 arrival: 220 ms of
 * fade and 6px of rise, stilled centrally by `data-motion="reduced"`.
 */
export function AuthStep({
  title,
  description,
  progress,
  dense,
  children,
}: {
  title: string;
  description?: ReactNode;
  /** Rendered above the title, inside the same announcement. */
  progress?: ReactNode;
  /**
   * This step carries enough fields that a short window has to choose. When it
   * does, the explanatory line goes and the fields stay: a sentence you cannot
   * see costs less than a field you cannot see, and the line is back the moment
   * the window has the height for it.
   */
  dense?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // The first field, not the group: a wizard that parks focus on a heading
    // makes every step cost an extra Tab, and a wizard that traps focus is a
    // §9 failure. Nothing here removes anything from the tab order.
    // A step that asks a choice rather than for text starts on the chosen
    // option, which is the radio group's one tab stop.
    const first = ref.current?.querySelector<HTMLElement>(
      'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), [role="radio"][tabindex="0"]:not([disabled])',
    );
    first?.focus();
  }, [title]);

  return (
    <div
      ref={ref}
      className="pc-enter flex min-h-0 flex-1 flex-col gap-[var(--auth-gap,20px)]"
    >
      <div aria-live="polite" aria-atomic="true" className="flex flex-col gap-3">
        {progress}
        <div>
          <h2 className="pc-display text-heading text-text-primary">{title}</h2>
          {description && (
            <p
              className={cn(
                'mt-1.5 text-meta leading-relaxed text-text-secondary',
                dense && 'short-window:hidden',
              )}
            >
              {description}
            </p>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}
