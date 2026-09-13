import { StreamViewer } from './StreamViewer';
import { FocusedWebcamView } from './FocusedWebcamView';
import { SplitPaneSourcePicker, type PaneSource } from './SplitPaneSourcePicker';
import type { WebcamTile } from '../../hooks/useWebcamTiles';
import { ErrorBoundary } from '../ErrorBoundary';

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
    <div
      data-native-underlay-clear=""
      className="relative min-h-0 flex-1 overflow-hidden rounded-[var(--radius-card)] bg-bg-well shadow-[var(--shadow-tile)]"
    >
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
        // One pane failing must not take the other pane — or the call — down.
        <ErrorBoundary variant="section" label="this pane">
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
        </ErrorBoundary>
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
    <div className="flex h-full min-h-[200px] items-center bg-bg-well px-6">
      <div className="flex max-w-[32ch] flex-col items-start gap-1.5">
        <span className="pc-display text-heading text-text-primary">Nothing in this pane</span>
        <p className="text-label text-text-secondary">
          Pick a share or a camera from the menu in the top-left.
        </p>
      </div>
    </div>
  );
}
