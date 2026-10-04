import { createContext, useContext } from 'react';

import type { Place } from './place';
import type { IxLayout } from './useIxLayout';

/**
 * What the frame knows that its slots may ask (`useIxShell()`): the layout, the
 * current place, and the route's server and channel. Provided by `IxFrame`
 * around everything it mounts (and around the routed page).
 */
export interface IxShellValue {
  layout: IxLayout;
  /** The place the sidebar shows now (a leaving pane gets its own `place` prop instead). */
  place: Place;
  /** The route's server, or null (People, admin, ...). */
  guildId: string | null;
  /** The route's channel or DM, or null. */
  channelId: string | null;
}

const IxShellContext = createContext<IxShellValue | null>(null);

export const IxShellProvider = IxShellContext.Provider;

/** The frame's values. Throws outside `IxFrame`: a slot rendered elsewhere is a bug. */
export function useIxShell(): IxShellValue {
  const value = useContext(IxShellContext);
  if (!value) throw new Error('useIxShell() is only available inside IxFrame.');
  return value;
}

/** The frame's values, or null outside it (for components also rendered alone: tests, showcases). */
export function useOptionalIxShell(): IxShellValue | null {
  return useContext(IxShellContext);
}
