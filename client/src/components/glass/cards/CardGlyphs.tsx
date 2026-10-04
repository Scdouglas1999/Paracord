import * as React from 'react';

/**
 * The few small marks the timeline cards draw that are not in the Index glyph
 * set (`../../ix/glyphs`): a calendar, a check, a heart, a file, a download and
 * a trash can, on the same 24 grid and the same 1.7 stroke (the check at 2,
 * because it is drawn at 15px and has to read on a button). Decorative: the
 * words beside them say what they mean.
 */
interface MarkProps extends Omit<React.SVGProps<SVGSVGElement>, 'children' | 'stroke'> {
  size?: number;
  /** Stroke width in the 24 grid. */
  weight?: number;
}

function Mark({ size = 13, weight = 1.7, children, ...rest }: MarkProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={weight}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      style={{ flexShrink: 0 }}
      {...rest}
    >
      {children}
    </svg>
  );
}

export const CalendarMark = (props: MarkProps) => (
  <Mark weight={1.7} {...props}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </Mark>
);

export const CheckMark = (props: MarkProps) => (
  <Mark size={15} weight={2} {...props}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Mark>
);

export const HeartMark = (props: MarkProps) => (
  <Mark weight={1.7} {...props}>
    <path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z" />
  </Mark>
);

export const FileMark = (props: MarkProps) => (
  <Mark size={18} weight={1.7} {...props}>
    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
    <path d="M14 2v6h6" />
  </Mark>
);

export const DownloadMark = (props: MarkProps) => (
  <Mark size={15} weight={1.7} {...props}>
    <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 20h14" />
  </Mark>
);

export const TrashMark = (props: MarkProps) => (
  <Mark size={15} weight={1.7} {...props}>
    <path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l.8 12.5h9.4L17.5 7M10 11v5M14 11v5" />
  </Mark>
);
