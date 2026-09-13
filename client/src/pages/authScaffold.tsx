import type { ReactNode } from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
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

/**
 * The app mark: a solid emerald tile with two interlocking links, a nod to the
 * server-to-server nature of the thing. Solid, because a gradient across a
 * surface is a kill-list item (§6.2) and the emerald already means "Paracord".
 */
export function AppMark({ size = 44, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 44 44"
      fill="none"
      role="img"
      aria-label="Paracord"
      className={cn('shrink-0', className)}
    >
      <rect width="44" height="44" rx="12" fill="var(--accent-primary)" />
      <rect
        x="9.5"
        y="15"
        width="16"
        height="14"
        rx="7"
        stroke="var(--text-on-accent)"
        strokeWidth="3"
        opacity="0.92"
      />
      <rect
        x="18.5"
        y="15"
        width="16"
        height="14"
        rx="7"
        stroke="var(--text-on-accent)"
        strokeWidth="3"
        opacity="0.55"
      />
    </svg>
  );
}

/** Full-page canvas: the street (`--bg-base`), flat and matte. */
export function AuthCanvas({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      role="region"
      aria-label="Account access"
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard users must be able to scroll this viewport with Page Up/Down and Home/End.
      tabIndex={0}
      className={cn('h-dvh w-full overflow-y-auto bg-bg-base', className)}
    >
      <div className="flex min-h-full w-full items-center justify-center px-4 py-10">
        {children}
      </div>
    </div>
  );
}

/** One plate on the street: `--bg-plate`, the plate radius and the plate shadow. */
export function AuthCard({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('pc-plate w-full p-0', className)}>{children}</div>;
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
}: {
  title: string;
  subtitle?: ReactNode;
  mark?: boolean;
  align?: 'left' | 'center';
}) {
  return (
    <div className={cn(align === 'center' && 'flex flex-col items-center text-center')}>
      {mark && <AppMark size={40} className="mb-4" />}
      <h1 className="pc-display text-title text-text-primary">{title}</h1>
      {subtitle && <p className="mt-2 max-w-prose text-body text-text-secondary">{subtitle}</p>}
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
  children,
}: {
  label: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  error?: string | null;
  /** Reference this from the control's aria-describedby. */
  descriptionId?: string;
  children: ReactNode;
}) {
  return (
    <div>
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
