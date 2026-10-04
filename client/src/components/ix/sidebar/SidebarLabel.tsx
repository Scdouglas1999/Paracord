import type { ReactNode } from 'react';

import { FLIP_ATTRIBUTE } from './useCollapse';

/**
 * A section label ("Channels", "Voice channels", "Add-ons", "Coming up", a category's
 * name): the primitive's recipe (`.ix-section-label`, 12.5/600 in the tertiary ink,
 * padding 16 8 6) around a real heading, and one unit the collapse FLIP moves.
 * `action` is a control that belongs beside the label, not in its name (the "+").
 */
export function SidebarLabel({ id, children, action }: { id: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="ix-section-label" {...{ [FLIP_ATTRIBUTE]: '' }}>
      <h2 id={id} className="ix-sb__heading">
        {children}
      </h2>
      {action}
    </div>
  );
}
