/**
 * What a conversation is (docs/index-spec.md §4.11). The page that hosts it
 * (GuildPage, TextChannelView, DMPage) builds this; `IxConversation` draws the
 * large title, the toolbar's words, the welcome and the message box from it.
 *
 * Structurally a superset of the channel menu's subject
 * (`components/ix/menus/hostStore.ts` `ChannelMenuSubject`).
 */
export type ConversationSubject =
  | {
      kind: 'channel';
      guildId: string;
      guildName?: string;
      channelId: string;
      channelName: string;
      topic?: string | null;
      /**
       * Replaces the subtitle (a thread's "Thread in general · started by Mara").
       * The encrypted line still follows it.
       */
      subtitle?: string | null;
      /** A thread: a pushed page with no welcome (§8.1). */
      isThread?: boolean;
    }
  | {
      kind: 'dm';
      channelId: string;
      /** The person's name, or the group's title. */
      title: string;
      isGroup: boolean;
      /** The other person in a one-to-one message (the title opens their profile card, §4.11). */
      recipient?: {
        id: string;
        username: string;
        display_name?: string | null;
        avatar_hash?: string | null;
      } | null;
      /** How many people are in a group, you included ("Group · 4 people"). */
      participants?: number;
    };
