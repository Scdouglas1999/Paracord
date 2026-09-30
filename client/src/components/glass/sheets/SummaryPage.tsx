import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { channelApi } from '../../../api/channels';
import { extractApiError } from '../../../api/client';
import { SheetAlert, SheetEmpty, SheetStatus } from './SheetParts';

/**
 * The catch-up summary: what the last few hours in this channel came to, read
 * for you. It is asked for when the page opens (an answer costs the server a
 * model call, so nothing asks for it ahead of time) and says which model
 * answered and how many messages it read.
 */

interface Summary {
  text: string;
  provider: string;
  model: string;
  messageCount: number;
}

export function SummaryPage({ channelId }: { channelId: string | null }) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'done'; summary: Summary }
  >({ status: 'loading' });

  // The page is keyed by channel (ChannelSheet), so it starts at "loading" for each.
  useEffect(() => {
    if (!channelId) return;
    let canceled = false;
    channelApi
      .summarizeChannel(channelId, 180)
      .then(({ data }) => {
        if (canceled) return;
        setState({
          status: 'done',
          summary: {
            text: data.summary,
            provider: data.provider,
            model: data.model,
            messageCount: data.message_count,
          },
        });
      })
      .catch((err) => {
        if (!canceled) setState({ status: 'error', message: `Failed to summarize channel: ${extractApiError(err)}` });
      });
    return () => {
      canceled = true;
    };
  }, [channelId]);

  if (!channelId) {
    return (
      <SheetEmpty icon={<Sparkles size={20} />} title="No channel selected">
        Open a channel to catch up on it.
      </SheetEmpty>
    );
  }
  if (state.status === 'loading') return <SheetStatus>Reading the last few hours…</SheetStatus>;
  if (state.status === 'error') return <SheetAlert>{state.message}</SheetAlert>;

  const { summary } = state;
  return (
    <div className="glass-sheet-narrow">
      <p className="glass-sheet-line glass-summary__meta">
        <span>Provider {summary.provider}</span>
        <span aria-hidden>·</span>
        <span>Model {summary.model}</span>
        <span aria-hidden>·</span>
        <span className="glass-instrument">{summary.messageCount} messages</span>
      </p>
      <div className="glass-sheet-card glass-summary__text">{summary.text || 'No summary available.'}</div>
    </div>
  );
}
