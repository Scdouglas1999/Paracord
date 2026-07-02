import { Monitor } from 'lucide-react';
import { StreamViewer } from './StreamViewer';
import { FocusedWebcamView } from './FocusedWebcamView';
import { SplitPaneSourcePicker, type PaneSource } from './SplitPaneSourcePicker';
import type { WebcamTile } from '../../hooks/useWebcamTiles';

interface SplitPaneProps {
  source: PaneSource;
  onSourceChange: (source: PaneSource) => void;
  otherPaneSource: PaneSource;
  activeStreamers: string[];
  webcamTiles: WebcamTile[];
  participantNames: Map<string, string>;
  currentUserId: string | null;
  selfStream: boolean;
  streamIssueMessage: string | null;
  activeStreamerSet: Set<string>;
  onStopStream?: () => void;
}

export function SplitPane({
  source,
  onSourceChange,
  otherPaneSource,
  activeStreamers,
  webcamTiles,
  participantNames,
  currentUserId,
  selfStream,
  streamIssueMessage,
  activeStreamerSet,
  onStopStream,
}: SplitPaneProps) {
  const resolveStreamerName = (userId: string): string | undefined => {
    if (currentUserId != null && userId === currentUserId) return 'You';
    return participantNames.get(userId);
  };

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-border-subtle">
      {/* Source picker overlay */}
      <div className="absolute left-2 top-2 z-20">
        <SplitPaneSourcePicker
          source={source}
          onSourceChange={onSourceChange}
          activeStreamers={activeStreamers}
          webcamTiles={webcamTiles}
          participantNames={participantNames}
          otherPaneSource={otherPaneSource}
          currentUserId={currentUserId}
        />
      </div>

      {/* Pane content */}
      {source.type === 'stream' ? (
        <StreamViewer
          streamerId={source.userId}
          streamerName={resolveStreamerName(source.userId)}
          issueMessage={
            currentUserId != null && source.userId === currentUserId
              ? streamIssueMessage
              : null
          }
          expectingStream={Boolean(
            currentUserId != null &&
            source.userId === currentUserId &&
            selfStream &&
            !activeStreamerSet.has(source.userId)
          )}
          skipSubscriptionManagement
          onStopWatching={() => onSourceChange({ type: 'none' })}
          onStopStream={onStopStream}
        />
      ) : source.type === 'webcam' ? (
        (() => {
          const tile = webcamTiles.find((t) => t.participantId === source.userId);
          if (!tile) {
            return <EmptyPane />;
          }
          return (
            <FocusedWebcamView
              participantId={tile.participantId}
              username={tile.username}
              isLocal={tile.isLocal}
            />
          );
        })()
      ) : (
        <EmptyPane />
      )}
    </div>
  );
}

function EmptyPane() {
  return (
    <div className="flex h-full min-h-[200px] items-center justify-center" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
      <div className="flex flex-col items-center gap-3">
        <div
          className="flex h-14 w-14 items-center justify-center rounded-2xl"
          style={{
            backgroundColor: 'var(--bg-mod-subtle)',
            border: '1px solid var(--border-subtle)',
          }}
        >
          <Monitor size={22} className="text-text-muted" />
        </div>
        <div className="text-sm font-medium text-text-muted">
          Select a source above
        </div>
      </div>
    </div>
  );
}
