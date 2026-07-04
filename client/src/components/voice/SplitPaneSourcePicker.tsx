import { useState, useRef, useEffect } from 'react';
import { Monitor, Video, ChevronDown, X } from 'lucide-react';
import type { WebcamTile } from '../../hooks/useWebcamTiles';

export type PaneSource =
  | { type: 'none' }
  | { type: 'stream'; userId: string }
  | { type: 'webcam'; userId: string };

interface SplitPaneSourcePickerProps {
  source: PaneSource;
  onSourceChange: (source: PaneSource) => void;
  activeStreamers: string[];
  webcamTiles: WebcamTile[];
  /** Participants map for resolving streamer display names */
  participantNames: Map<string, string>;
  otherPaneSource: PaneSource;
  currentUserId: string | null;
}

export function SplitPaneSourcePicker({
  source,
  onSourceChange,
  activeStreamers,
  webcamTiles,
  participantNames,
  otherPaneSource,
  currentUserId,
}: SplitPaneSourcePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen]);

  const getSourceLabel = (src: PaneSource): string => {
    if (src.type === 'none') return 'Select source';
    if (src.type === 'stream') {
      const name = resolveDisplayName(src.userId);
      return `${name}'s stream`;
    }
    const tile = webcamTiles.find((t) => t.participantId === src.userId);
    return tile ? `${tile.username}'s cam` : 'Webcam';
  };

  const resolveDisplayName = (userId: string): string => {
    if (currentUserId != null && userId === currentUserId) return 'Your';
    return participantNames.get(userId) ?? `User ${userId.slice(0, 6)}`;
  };

  const isUsedInOther = (type: PaneSource['type'], userId: string): boolean => {
    return otherPaneSource.type === type && 'userId' in otherPaneSource && otherPaneSource.userId === userId;
  };

  return (
    <div ref={containerRef} className="relative z-20">
      <button
        onClick={() => setIsOpen((prev) => !prev)}
        className="flex items-center gap-1.5 rounded-sm border border-border-subtle px-2.5 py-1.5 text-meta font-medium shadow-sm outline-none backdrop-blur-md transition-[color,background-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] hover:border-border-strong focus-visible:shadow-[var(--focus-ring)]"
        style={{
          backgroundColor: 'color-mix(in srgb, var(--bg-floating) 85%, transparent)',
          color: source.type === 'none' ? 'var(--text-muted)' : 'var(--text-primary)',
        }}
      >
        {source.type === 'stream' && <Monitor size={12} />}
        {source.type === 'webcam' && <Video size={12} />}
        <span className="max-w-[120px] truncate">{getSourceLabel(source)}</span>
        <ChevronDown size={12} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div
          className="absolute left-0 top-full mt-1 min-w-[210px] rounded-md border border-border-subtle p-1 shadow-lg"
          style={{ backgroundColor: 'var(--bg-floating)', backdropFilter: 'blur(16px)' }}
        >
          {/* None option */}
          <button
            onClick={() => { onSourceChange({ type: 'none' }); setIsOpen(false); }}
            className={`flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-meta outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)] ${
              source.type === 'none'
                ? 'bg-accent-tint text-text-primary'
                : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary'
            }`}
          >
            <X size={13} className="text-text-muted" />
            <span>None</span>
          </button>

          {/* Streams section */}
          {activeStreamers.length > 0 && (
            <>
              <div className="mx-1.5 mb-1 mt-2 text-section uppercase text-text-muted">
                Streams
              </div>
              {activeStreamers.map((userId) => {
                const inOther = isUsedInOther('stream', userId);
                const isSelected = source.type === 'stream' && source.userId === userId;
                const displayName = currentUserId != null && userId === currentUserId
                  ? 'You'
                  : participantNames.get(userId) ?? `User ${userId.slice(0, 6)}`;
                return (
                  <button
                    key={`stream-${userId}`}
                    onClick={() => { onSourceChange({ type: 'stream', userId }); setIsOpen(false); }}
                    className={`flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-meta outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)] ${
                      isSelected
                        ? 'bg-accent-tint text-text-primary'
                        : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary'
                    }`}
                  >
                    <Monitor size={13} className="shrink-0 text-accent-danger" />
                    <span className="truncate">{displayName}</span>
                    {inOther && (
                      <span className="ml-auto shrink-0 rounded-xs bg-bg-mod-strong px-1.5 py-0.5 text-meta text-text-muted">
                        other pane
                      </span>
                    )}
                  </button>
                );
              })}
            </>
          )}

          {/* Webcams section */}
          {webcamTiles.length > 0 && (
            <>
              <div className="mx-1.5 mb-1 mt-2 text-section uppercase text-text-muted">
                Cameras
              </div>
              {webcamTiles.map((tile) => {
                const inOther = isUsedInOther('webcam', tile.participantId);
                const isSelected = source.type === 'webcam' && source.userId === tile.participantId;
                const displayName = tile.isLocal ? 'You' : tile.username;
                return (
                  <button
                    key={`webcam-${tile.participantId}`}
                    onClick={() => { onSourceChange({ type: 'webcam', userId: tile.participantId }); setIsOpen(false); }}
                    className={`flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-meta outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)] ${
                      isSelected
                        ? 'bg-accent-tint text-text-primary'
                        : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary'
                    }`}
                  >
                    <Video size={13} className="shrink-0 text-accent-primary" />
                    <span className="truncate">{displayName}</span>
                    {inOther && (
                      <span className="ml-auto shrink-0 rounded-xs bg-bg-mod-strong px-1.5 py-0.5 text-meta text-text-muted">
                        other pane
                      </span>
                    )}
                  </button>
                );
              })}
            </>
          )}

          {activeStreamers.length === 0 && webcamTiles.length === 0 && (
            <div className="px-2.5 py-3 text-meta text-text-muted">
              No one is streaming or on camera right now.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
