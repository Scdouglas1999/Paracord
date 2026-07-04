import type { ReactNode } from 'react';
import { AlertCircle, CheckCircle2, ShieldCheck, Server, Radio } from 'lucide-react';
import { cn } from '../lib/utils';

/**
 * Shared building blocks for the unauthenticated entry surfaces (login, register,
 * connect, invite, account setup/recover/unlock, bot authorize). These consume
 * the Emerald Commons tokens directly — solid `--bg-primary` canvas, a single
 * raised `--bg-secondary` panel, Fraunces headings, emerald focus — so the first
 * screens a new user sees read as one intentional system, never marketing slop.
 */

/**
 * The one rationed brand moment: the app mark carries the teal→emerald duotone
 * (see design-spec §1.2). Two interlocking links nod to Paracord's federated,
 * server-to-server nature. Used nowhere as a decorative fill.
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
      <defs>
        <linearGradient id="paracord-mark" x1="4" y1="4" x2="40" y2="40" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--accent-secondary)" />
          <stop offset="1" stopColor="var(--accent-primary)" />
        </linearGradient>
      </defs>
      <rect width="44" height="44" rx="12" fill="url(#paracord-mark)" />
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
        opacity="0.62"
      />
    </svg>
  );
}

/** Full-page canvas: a solid, warm-neutral `--bg-primary` field — no gradient hero. */
export function AuthCanvas({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex min-h-screen w-full items-center justify-center bg-bg-primary px-4 py-10',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A single raised panel: `--bg-secondary`, radius-lg, hairline border, shadow-md. */
export function AuthCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'w-full rounded-lg border border-border-subtle bg-bg-secondary shadow-md',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Heading block: optional brand mark, a Fraunces title, and `--text-secondary`
 * subcopy. Establishes the Display/Title → body hierarchy the spec demands.
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
      <h1 className="font-display text-title text-text-primary">{title}</h1>
      {subtitle && (
        <p className="mt-2 max-w-sm text-body text-text-secondary">{subtitle}</p>
      )}
    </div>
  );
}

/** Uppercase section label above a control (design-spec Section step). */
export function FieldLabel({
  children,
  required,
}: {
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <span className="mb-2 flex items-center gap-1 text-section uppercase text-text-secondary">
      {children}
      {required && <span className="text-accent-danger">*</span>}
    </span>
  );
}

/**
 * A labelled field wrapper. The `<label>` wraps its control so the accessible
 * name comes from the label text; hint/error render outside the label so they
 * never pollute that name. Errors use specific, warm copy in `--accent-danger`.
 */
export function Field({
  label,
  required,
  hint,
  error,
  children,
}: {
  label: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="block">
        <FieldLabel required={required}>{label}</FieldLabel>
        {children}
      </label>
      {error ? (
        <p className="mt-2 flex items-start gap-1.5 text-meta text-accent-danger">
          <AlertCircle size={13} className="mt-px shrink-0" />
          <span>{error}</span>
        </p>
      ) : (
        hint && <p className="mt-2 text-meta text-text-muted">{hint}</p>
      )}
    </div>
  );
}

/** Success callout — `--success-tint` background with solid success text. */
export function SuccessNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-md border border-accent-success/30 bg-success-tint px-4 py-3 text-label text-accent-success">
      <CheckCircle2 size={16} className="mt-px shrink-0" />
      <span className="[&_strong]:font-semibold">{children}</span>
    </div>
  );
}

/**
 * Brand rail shown beside the login/register forms on wide screens. Gives the
 * first impression real content and hierarchy instead of dead-centered
 * whitespace — the value props are specific, not placeholder copy.
 */
const BRAND_POINTS = [
  {
    icon: ShieldCheck,
    title: 'Sealed to your keys, not ours',
    body: 'Messages and calls are end-to-end encrypted by default — the server relays ciphertext it can never read.',
  },
  {
    icon: Server,
    title: 'Self-hosted and federated',
    body: 'Run your own server or join a friend’s. Identities travel across servers, so there’s no lock-in.',
  },
  {
    icon: Radio,
    title: 'Voice and video that keep up',
    body: 'A native QUIC media engine built in-house for low-latency rooms, screen share, and live video.',
  },
];

export function BrandAside() {
  return (
    <aside className="hidden w-[22rem] shrink-0 flex-col border-r border-border-subtle bg-bg-tertiary/40 p-9 lg:flex">
      <div>
        <div className="flex items-center gap-3">
          <AppMark size={40} />
          <span className="font-display text-heading text-text-primary">Paracord</span>
        </div>
        <p className="mt-5 font-display text-title leading-tight text-text-primary">
          A home for your people, on your terms.
        </p>
      </div>

      <ul className="mt-10 space-y-6">
        {BRAND_POINTS.map(({ icon: Icon, title, body }) => (
          <li key={title} className="flex gap-3.5">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent-tint text-accent-primary">
              <Icon size={18} />
            </span>
            <div>
              <p className="text-label font-semibold text-text-primary">{title}</p>
              <p className="mt-1 text-meta leading-relaxed text-text-secondary">{body}</p>
            </div>
          </li>
        ))}
      </ul>

      <p className="mt-auto pt-10 text-meta text-text-muted">
        Decentralized, self-hostable, private by design.
      </p>
    </aside>
  );
}
