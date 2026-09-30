/**
 * The conversation slot (owner: WP-G11; WP-G10 restyles the timeline it is
 * handed). Contract: `ConversationPaneProps` in components/glass/shell/slots.ts.
 * Mounted by GuildPage, TextChannelView and DMPage inside the conversation pane
 * the shell paints.
 *
 * WP-G7 stub: replace this re-export with the real pane, keeping the props.
 */
export { ConversationPane } from '../shell/stubs/ConversationPaneStub';
export type { ConversationPaneProps, ConversationSubject } from '../shell/slots';
