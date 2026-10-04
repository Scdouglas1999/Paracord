import { useFreshRelationships } from '../../../hooks/useFreshRelationships';
import { useRememberRoute } from './useRememberRoute';

/**
 * What the sidebar slot asks of the People place whichever place is open, so it
 * is one call in `SidebarSlot`:
 *
 *   - remember the route you are on, so `/app` can open it next launch;
 *   - keep the relationship list fresh, so the dock's People badge counts friend
 *     requests from a server's page too (Home used to load it for the whole app).
 */
export function usePeopleMemory(enabled: boolean): void {
  useRememberRoute(enabled);
  useFreshRelationships();
}
