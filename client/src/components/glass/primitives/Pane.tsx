import * as React from 'react';
import { cn } from '../../../lib/utils';

/**
 * A floating panel (docs/glass-spec.md §1.1, §2.4): radius 28, the room-tinted
 * `--pane` fill (near-solid: no backdrop blur, WebKitGTK cannot afford it), the
 * pane shadow with its 1px top highlight. Sibling panes share geometry, so this
 * sets only the surface; size and position belong to the shell (WP-G7).
 *
 *   tone="pane"   panels (default)
 *   tone="deep"   the stage surface and the theater chat column
 *   tone="solid"  opaque; also what reduced transparency resolves to
 *   glow          the faint radial of the room in the far corner
 */
export interface PaneProps extends React.HTMLAttributes<HTMLElement> {
  as?: 'div' | 'section' | 'aside' | 'nav' | 'main';
  tone?: 'pane' | 'deep' | 'solid';
  glow?: boolean;
}

export const Pane = React.forwardRef<HTMLElement, PaneProps>(function Pane(
  { as: Tag = 'div', tone = 'pane', glow = false, className, ...rest },
  ref,
) {
  return (
    <Tag
      ref={ref as React.Ref<never>}
      data-tone={tone}
      className={cn(
        'glass-pane',
        tone === 'deep' && 'glass-pane--deep',
        tone === 'solid' && 'glass-pane--solid',
        glow && 'glass-pane--glow',
        className,
      )}
      {...rest}
    />
  );
});
