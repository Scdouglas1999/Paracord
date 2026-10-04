import type { ComponentPropsWithRef } from 'react';

import { cn } from '../../../lib/utils';

export interface WideControlProps extends ComponentPropsWithRef<'button'> {
  tone?: 'default' | 'danger';
}

/**
 * A control with words in it, filling the row (docs/index-spec.md §3.1): "Open
 * call", "Back to chat", "Join" beside a Watch. Same fill and lift as `Control`,
 * 36px tall, 13.5/600 in the primary ink.
 */
export function WideControl({ tone = 'default', type = 'button', className, ...rest }: WideControlProps) {
  return <button type={type} className={cn('ix-ctl', 'ix-ctl--wide', tone === 'danger' && 'ix-ctl--danger', className)} {...rest} />;
}
