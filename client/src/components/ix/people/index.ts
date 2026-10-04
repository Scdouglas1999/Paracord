/**
 * The People place (docs/index-spec.md §6.6, §8.1; owner IX-14): the People sidebar,
 * the Friends and Inbox pages, the redirects that replace Home.
 *
 * `PeopleSidebar` is what `SidebarSlot` renders for the People place. `/app` and
 * `/app/dms` are `LastPlaceRedirect` (import it by path from `App.tsx`: this barrel
 * pulls in every page).
 */
export { PeopleSidebar } from './PeopleSidebar';
export type { PeopleSidebarProps } from './PeopleSidebar';
