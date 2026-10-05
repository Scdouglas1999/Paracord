import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '../../../lib/utils';
import { IxGlyph } from '../glyphs';

export interface BannerStripProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'role' | 'className'> {
  /** What is true ("Connection lost, retrying automatically"). */
  children: ReactNode;
  /** The one text action ("Retry now", "Restart to update"). */
  action?: { label: string; onPress: () => void; disabled?: boolean };
  /** A way to put the strip away (an update you will do later). */
  onDismiss?: () => void;
  dismissLabel?: string;
  /** `danger` is the one danger ink for an error; there is no amber, green or blue strip (§6.8). */
  tone?: 'plain' | 'danger';
  role?: 'status' | 'alert';
  /** The presence recipe's classes (`pc-banner-in` / `pc-banner-out`) and attributes. */
  className?: string;
  'data-testid'?: string;
}

/**
 * The banner strip (docs/index-spec.md §6.8): connection lost or coming back, the
 * instance restarting, an update ready. 36px across the top, `--ix-card` with a
 * bottom hairline, 13/600 ink, one text action. Never amber. `BannerStack` stacks
 * these in one column and the shell reserves exactly their height
 * (`--pc-banner-inset`), so a banner arriving moves the app down instead of
 * covering its toolbar.
 */
export function BannerStrip({
  children,
  action,
  onDismiss,
  dismissLabel = 'Dismiss',
  tone = 'plain',
  role = 'status',
  className,
  'data-testid': testId,
  ...rest
}: BannerStripProps) {
  return (
    <div
      className={cn('ix-banner-strip', className)}
      role={role}
      aria-live={role === 'alert' ? 'assertive' : 'polite'}
      aria-atomic="true"
      data-tone={tone}
      data-testid={testId ?? 'ix-banner'}
      {...rest}
    >
      <span className="ix-banner-strip__text">{children}</span>
      {action && (
        <button type="button" className="ix-banner-strip__action" disabled={action.disabled} onClick={action.onPress}>
          {action.label}
        </button>
      )}
      {onDismiss && (
        <button type="button" className="ix-banner-strip__dismiss" aria-label={dismissLabel} title={dismissLabel} onClick={onDismiss}>
          <IxGlyph name="x" size={14} />
        </button>
      )}
    </div>
  );
}
