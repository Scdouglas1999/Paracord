import type { ComponentPropsWithRef } from 'react';

import { cn } from '../../../lib/utils';

export interface CreamButtonProps extends ComponentPropsWithRef<'button'> {
  /**
   * `md`: 36px tall, radius 11, 14/700 (a room card's Join, Watch, Post it).
   * `sm`: padding 8 12, radius 10, 13.5/600 (an event card's primary button).
   */
  size?: 'md' | 'sm';
  /** Fill the row it sits in (a card's actions row). */
  grow?: boolean;
}

/**
 * The one action on a surface (docs/index-spec.md §1.4, §3.1): Join, Watch,
 * Post it, a Send that has text. Cream with dark ink. One per surface; a second
 * action is a `WideControl`, not a second cream.
 */
export function CreamButton({ size = 'md', grow = false, type = 'button', className, ...rest }: CreamButtonProps) {
  return <button type={type} className={cn('ix-cream', size === 'sm' && 'ix-cream--sm', grow && 'ix-cream--grow', className)} {...rest} />;
}
