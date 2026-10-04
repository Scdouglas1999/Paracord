import type { ComponentPropsWithRef } from 'react';

import { cn } from '../../../lib/utils';

export type ToolChipProps = ComponentPropsWithRef<'button'>;

/**
 * A tool chip under the open message box (docs/index-spec.md §3.1): Attach, GIF,
 * Poll, Event. Padding 6 10, radius 8, a quiet fill, 12.5 in the secondary ink;
 * an `IxGlyph` child is drawn at 14px.
 */
export function ToolChip({ type = 'button', className, ...rest }: ToolChipProps) {
  return <button type={type} className={cn('ix-chip', className)} {...rest} />;
}
