import type { InboxSummary } from './usePeopleSidebar';
import { inboxLine, inboxNewestLine } from './peopleModel';
import type { RowFocus } from '../sidebar/useRovingList';
import { UtilityRow } from './UtilityRow';
import { useConversationPreview } from './useConversationPreview';
import type { ConversationEntry } from '../../../lib/attention/conversationModel';

export interface InboxRowProps extends RowFocus {
  summary: InboxSummary;
  href: string;
  selected: boolean;
  leaving: boolean;
  onOpen: () => void;
}

/** The Inbox row (§6.6): the newest thing that needs you as its line, a white count of mentions. */
export function InboxRow({ summary, ...rest }: InboxRowProps) {
  const count = summary.mentions;
  const countWords = count > 0 ? (count === 1 ? '1 mention' : `${count} mentions`) : null;
  const counts = { newest: null, mentions: summary.mentions, unread: summary.unread, reminders: 0 };
  if (!summary.top) {
    return <UtilityRow id="inbox" name="Inbox" line={inboxLine(counts)} count={count} countWords={countWords} {...rest} />;
  }
  return <InboxRowWithNewest top={summary.top} counts={counts} count={count} countWords={countWords} {...rest} />;
}

function InboxRowWithNewest({
  top,
  counts,
  count,
  countWords,
  ...rest
}: Omit<InboxRowProps, 'summary'> & {
  top: ConversationEntry;
  counts: Parameters<typeof inboxLine>[0];
  count: number;
  countWords: string | null;
}) {
  const newest = useConversationPreview(top, 'attention');
  const line = inboxLine({ ...counts, newest: inboxNewestLine(top, newest.preview?.message, top.scope.userId) });
  return <UtilityRow id="inbox" name="Inbox" line={line} count={count} countWords={countWords} {...rest} />;
}
