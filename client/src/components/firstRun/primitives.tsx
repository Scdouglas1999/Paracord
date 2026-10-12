import type { ButtonHTMLAttributes, ReactNode, SVGProps } from 'react';

import { cn } from '../../lib/utils';

/**
 * The first run's small parts (docs/setup-spec.md §1.1, §9.6), drawn after the
 * approved prototype on Index tokens. Styles are in firstRun.css (`fr-*`).
 */

/** The prototype's line glyphs: 24x24, stroke 1.7, round caps and joins (as Index §2.6). */
const GLYPHS = {
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  check: <path d="M5 12l5 5 9-10" />,
  bang: <path d="M12 7v6M12 17h.01" />,
  cross: <path d="M7 7l10 10M17 7 7 17" />,
  clipboard: (
    <>
      <rect x="8" y="3" width="8" height="4" rx="1" />
      <path d="M8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.4 17.4 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.8 9.8 0 0 0 5.4-1.6" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </>
  ),
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  print: <path d="M6 9V3h12v6M6 18H4v-6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6h-2M7 14h10v7H7z" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  people: (
    <path d="M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M3 20c.8-3.5 3.2-5.5 6-5.5s5.2 2 6 5.5M16 4.5a3.5 3.5 0 0 1 0 7M21 20c-.5-2.6-1.8-4.4-3.6-5.1" />
  ),
  phone: (
    <>
      <rect x="7" y="3" width="10" height="18" rx="2" />
      <path d="M11 18h2" />
    </>
  ),
  link: (
    <>
      <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" />
      <path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" />
    </>
  ),
  warn: (
    <>
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    </>
  ),
  speaker: <path d="M11 5L6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 0 0 18" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
} as const;

export type FrGlyphName = keyof typeof GLYPHS;

export function FrGlyph({
  name,
  size = 18,
  strokeWidth = 1.7,
  className,
  ...rest
}: { name: FrGlyphName; size?: number; strokeWidth?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...rest}
    >
      {GLYPHS[name]}
    </svg>
  );
}

/** The cream primary of a step's footer: 46 tall, radius 13, 15/700, trailing arrow (§1.1). */
export function GoButton({ children, arrow = true, className, type = 'submit', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { arrow?: boolean }) {
  return (
    <button type={type} className={cn('fr-go', className)} {...rest}>
      <span>{children}</span>
      {arrow && <FrGlyph name="arrow" size={16} strokeWidth={2.1} />}
    </button>
  );
}

export function BackButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className="fr-back" {...props}>
      Back
    </button>
  );
}

export function Chip({
  variant,
  glyph,
  children,
  className,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'ghost' | 'cream'; glyph?: FrGlyphName }) {
  return (
    <button type={type} className={cn('fr-chip', variant && `fr-chip--${variant}`, className)} {...rest}>
      {glyph && <FrGlyph name={glyph} size={15} />}
      {children}
    </button>
  );
}

/** A labeled field. `error` replaces `help` and marks the field (pass the same id to the input). */
export function Field({
  label,
  htmlFor,
  help,
  error,
  errorId,
  children,
  className,
}: {
  label?: ReactNode;
  htmlFor?: string;
  help?: ReactNode;
  error?: string | null;
  errorId?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('fr-fl', className)}>
      {label && <label htmlFor={htmlFor}>{label}</label>}
      {children}
      {error ? (
        <div className="fr-err" id={errorId} role="alert">
          {error}
        </div>
      ) : (
        help
      )}
    </div>
  );
}

/** Green dot + "9 online · 41 members" (prototype `.srv small`). */
export function OnlineLine({ children }: { children: ReactNode }) {
  return (
    <small className="fr-online">
      <i aria-hidden="true" />
      {children}
    </small>
  );
}
