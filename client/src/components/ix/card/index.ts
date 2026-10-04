/**
 * The live room card slot (owner: IX-7; docs/index-spec.md §4.3, §4.4, §4.10,
 * §5.4, §5.5, §5.7). Contract: `CardSlotProps` in components/ix/shell/slots.ts.
 * `position="pinned"` is mounted by the shell above the sidebar panes;
 * `position="inline"` by the sidebar (IX-5) under its search field.
 */
export { CardSlot } from './CardSlot';
export type { CardPosition, CardSlotProps } from '../shell/slots';
export { useInlineCardRoom, useServerLive } from './selectors';
export { JoinMutedSetting } from './JoinMutedSetting';
