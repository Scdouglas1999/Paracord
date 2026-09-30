/**
 * The conversation slot (owner: WP-G11; WP-G10 restyles the timeline it is
 * handed). Contract: `ConversationPaneProps` in components/glass/shell/slots.ts.
 * Mounted by GuildPage, TextChannelView and DMPage inside the conversation pane
 * the shell paints.
 *
 * WP-G11: the real pane. The header, the channel menu behind its title, the
 * DM call control and the interim sheet bridge live beside it; the message box
 * is `components/message/MessageInput`.
 */
export { ConversationPane } from './ConversationPane';
export { ConversationHeader } from './ConversationHeader';
export type { ConversationPaneProps, ConversationSubject } from '../shell/slots';
