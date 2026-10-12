import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { CordMark, type CordMotion } from '../components/brand/CordMark';
import { PEOPLE_HUE } from '../lib/identityHue';
import { cn } from '../lib/utils';

/**
 * Shared building blocks for the unauthenticated entry surfaces (login,
 * register, connect, invite, account setup/recover/unlock, first-owner setup,
 * bot authorize), on Index (docs/index-spec.md §6.14): **the ground with the main
 * glow at hue 210 and one centered 400px column** on it: the Paracord mark, a
 * 28/700 title, fields 44 tall at radius 12, one cream primary action and text
 * secondary actions. No card, no plate, no illustration filler; the only light is
 * the window's own tint.
 */

/** The column's width (§6.14). A surface that needs more room says so with its own `max-w`. */
const COLUMN = 'max-w-[400px]';

/**
 * Full-page canvas: the ground (`--ix-main`) with the place's main glow at hue 210
 * (People's, the neutral blue every window starts with: `ix-hue-main`), and the
 * Index scope so the controls inside read the Index inks (`ix-lt--main`).
 *
 * **The fit law.** At the desktop client's window sizes — 1280×800 default,
 * 940×560 minimum (`client/src-tauri/tauri.conf.json`) — a first-run surface
 * does not scroll. A native window that scrolls its whole self reads like a
 * webpage someone wrapped in a frame, and it puts the one action below the
 * fold. So from `sm` up the canvas is exactly the window and clips nothing
 * out of it: {@link AuthCard} is bounded to the same height, and the one
 * region inside the column that may scroll is {@link AuthScroll}, which leaves
 * the heading and the action where they are.
 *
 * Below `sm` this is a browser at phone width, where a page that scrolls is
 * the normal and correct thing — that behavior is unchanged.
 */
export function AuthCanvas({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      role="region"
      aria-label="Account access"
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard users must be able to scroll this viewport with Page Up/Down and Home/End.
      tabIndex={0}
      className={cn('ix-auth ix-hue-main ix-lt--main h-dvh w-full overflow-y-auto sm:overflow-hidden', className)}
      style={{ '--ix-hue': PEOPLE_HUE } as CSSProperties}
    >
      <div className="flex min-h-full w-full items-center justify-center px-4 py-10 sm:h-full sm:min-h-0 sm:py-6">
        {children}
      </div>
    </div>
  );
}

/**
 * The column on the ground: 400 wide, with no surface of its own (the window is the
 * frame, §3). A column, and bounded by the window from `sm` up — see
 * {@link AuthCanvas}. `min-h-0` is what lets an {@link AuthScroll} inside it
 * actually shrink instead of pushing the action off the bottom of a flex parent.
 */
export function AuthCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('ix-auth__col flex w-full min-h-0 flex-col sm:max-h-full', COLUMN, className)}>
      {children}
    </div>
  );
}

/**
 * The column's rhythm: `.pc-auth-form` in primitives.css, which owns the gaps and
 * tightens them once when the window is short. Used as the className of a
 * `<form>` or a plain `<div>`, so it is a constant rather than a component.
 */
export const AUTH_FORM = 'pc-auth-form';

/**
 * The one region inside the column that is allowed to scroll, for the surface
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
 * Heading block: the app mark, a 28/700 title (`ix-auth__title`) and one
 * specific line of the tertiary ink under it.
 */
export function AuthHeading({
  title,
  subtitle,
  mark = true,
  markMotion = 'none',
  align = 'left',
  dense,
}: {
  title: string;
  subtitle?: ReactNode;
  mark?: boolean;
  /** The mark's motion: `working` while the surface waits on something long (checking an instance). */
  markMotion?: CordMotion;
  align?: 'left' | 'center';
  /**
   * Drop the subcopy when the window is short — see {@link AuthStep}'s `dense`.
   * A sentence you cannot see costs less than a field you cannot see.
   */
  dense?: boolean;
}) {
  return (
    <div className={cn(align === 'center' && 'flex flex-col items-center text-center')}>
      {mark && <CordMark size={40} motion={markMotion} label="Paracord" className="mb-4 short-window:mb-3" />}
      <h1 className="ix-auth__title">{title}</h1>
      {subtitle && <p className={cn('ix-auth__sub mt-2', dense && 'short-window:hidden')}>{subtitle}</p>}
    </div>
  );
}

/** Sentence-case label above a control (13/500 in ink-2, matching TextField). */
export function FieldLabel({
  children,
  required,
}: {
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <span className="mb-1.5 flex items-center gap-1 text-[13px] font-medium text-[var(--ix-ink-2)]">
      {children}
      {required && (
        // A required mark is a sign, not an error: ink, not the danger color.
        <span className="text-[var(--ix-ink-3)]" aria-hidden>
          *
        </span>
      )}
    </span>
  );
}

/**
 * A labeled field wrapper. The `<label>` wraps its control so the accessible
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
        <p id={descriptionId} className="mt-2 flex items-start gap-1.5 text-[13px] text-[var(--ix-danger-ink)]">
          <AlertCircle size={13} className="mt-px shrink-0" />
          <span className="leading-relaxed">{error}</span>
        </p>
      ) : (
        hint && (
          <p id={descriptionId} className="mt-2 text-[13px] leading-relaxed text-[var(--ix-ink-3)]">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

/** Success callout: a field-fill block carrying ink, never a green fill. */
export function SuccessNote({ children }: { children: ReactNode }) {
  return (
    <div className="pc-well flex items-start gap-2.5 px-4 py-3 text-[14px] text-[var(--ix-ink)]">
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
 * circle outranks the step it counts, and four of them across the top of the
 * column is the same tiling the kill-list rejects. Done and current are cream
 * (the one action's color); the rest are the quiet fill.
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
      <p id={id} className="text-[12.5px] font-medium tabular-nums text-[var(--ix-ink-3)]">
        Step {step} of {count}
      </p>
      <div className="flex items-center gap-1.5" aria-hidden="true">
        {Array.from({ length: count }, (_, index) => (
          <span
            key={index}
            className={cn(
              'h-[3px] flex-1 rounded-[var(--radius-full)] transition-colors duration-[60ms] ease-[var(--ix-ease)]',
              index < step ? 'bg-[var(--ix-cream)]' : 'bg-[var(--ix-fill-2)]',
            )}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One step of a wizard: a labeled group that announces itself when it
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
          <h2 className="ix-auth__step">{title}</h2>
          {description && (
            <p
              className={cn(
                'mt-1.5 text-[13.5px] leading-[1.45] text-[var(--ix-ink-3)]',
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
