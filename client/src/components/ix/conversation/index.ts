/**
 * The conversation chrome (docs/index-spec.md §4.11-4.13; owner IX-15): the
 * conversation in main, its welcomes, the draft event card, the drop target, the
 * banner strip and the toolbar's DM call button.
 *
 *   <IxConversation subject notices? onBack? onPickRoles? />   what GuildPage, TextChannelView and DMPage render
 *   ConversationSubject                                         what the page says the conversation is
 *   <BannerStrip action? onDismiss? tone?>                      the 36px strip (BannerStack stacks them)
 *
 * See docs/design/index-checkpoints/IX-15.md.
 */
export { IxConversation } from './IxConversation';
export type { IxConversationProps } from './IxConversation';
export type { ConversationSubject } from './types';
export { BannerStrip } from './BannerStrip';
export type { BannerStripProps } from './BannerStrip';
export { DmCallButton } from './DmCallButton';
export { useDmCall } from './useDmCall';
export { ForumPage } from './ForumPage';
export { isWelcomed, markWelcomed } from './joinerWelcome';
