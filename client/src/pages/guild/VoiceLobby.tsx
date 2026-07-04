import { Headphones, HeadphoneOff, Mic, MicOff, Monitor, Users, Video } from 'lucide-react';
import type { ReactNode } from 'react';
import type { StageInstance } from '../../api/stage';
import type { VoiceState } from '../../types';
import { Button } from '../../components/ui/Button';

interface VoiceLobbyProps {
  channelName: string;
  participantCount: number;
  isStage: boolean;
  channelId: string | undefined;
  guildId: string | undefined;
  voiceJoinError: string | null;
  voiceJoinPending: boolean;
  onRetryJoin: () => void;
  onJoin: () => void;
  canManageStage: boolean;
  stageInstance: StageInstance | null;
  stageLoading: boolean;
  stageBusy: boolean;
  stageError: string | null;
  stageTopicDraft: string;
  onStageTopicChange: (value: string) => void;
  onCreateStage: () => void;
  onUpdateStage: () => void;
  onEndStage: () => void;
  onInviteSpeaker: (userId: string) => void;
  onRemoveSpeaker: (userId: string) => void;
  lobbyParticipants: VoiceState[];
}

// Avatar with a meaning-carrying ring: teal→emerald duotone when streaming
// (the rationed brand moment), emerald when on camera, otherwise a quiet edge.
function ParticipantAvatar({ p }: { p: VoiceState }) {
  const initial = (p.username || '?')[0].toUpperCase();
  const ringClass = p.self_stream
    ? 'bg-gradient-to-br from-accent-secondary to-accent-primary'
    : p.self_video
      ? 'bg-accent-primary'
      : 'bg-border-subtle';
  return (
    <div className={`shrink-0 rounded-full p-[2px] ${ringClass}`}>
      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-bg-secondary text-meta font-semibold text-text-secondary">
        {initial}
      </div>
    </div>
  );
}

export function VoiceLobby({
  channelName,
  participantCount,
  isStage,
  channelId,
  guildId,
  voiceJoinError,
  voiceJoinPending,
  onRetryJoin,
  onJoin,
  canManageStage,
  stageInstance,
  stageLoading,
  stageBusy,
  stageError,
  stageTopicDraft,
  onStageTopicChange,
  onCreateStage,
  onUpdateStage,
  onEndStage,
  onInviteSpeaker,
  onRemoveSpeaker,
  lobbyParticipants,
}: VoiceLobbyProps) {
  const lobbySpeakers = isStage ? lobbyParticipants.filter((p) => !p.suppress) : lobbyParticipants;
  const lobbyAudience = isStage ? lobbyParticipants.filter((p) => p.suppress) : [];

  const renderParticipant = (p: VoiceState) => (
    <div
      key={p.user_id}
      className="flex items-center gap-2.5 rounded-sm px-2 py-1.5 transition-colors hover:bg-bg-mod-subtle"
    >
      <ParticipantAvatar p={p} />
      <span className="min-w-0 flex-1 truncate text-label text-text-primary">
        {p.username || p.user_id}
      </span>
      <div className="flex items-center gap-1.5">
        {p.self_mute && (
          <span title="Muted"><MicOff size={14} className="text-accent-danger" /></span>
        )}
        {p.self_deaf && (
          <span title="Deafened"><HeadphoneOff size={14} className="text-accent-danger" /></span>
        )}
        {p.self_video && (
          <span title="Camera on"><Video size={14} className="text-accent-primary" /></span>
        )}
        {p.self_stream && (
          <span title="Streaming"><Monitor size={14} className="text-accent-secondary" /></span>
        )}
      </div>
      {isStage && canManageStage && stageInstance && (
        <div className="ml-1">
          {p.suppress ? (
            <Button size="sm" variant="ghost" disabled={stageBusy} onClick={() => onInviteSpeaker(p.user_id)}>
              Invite to speak
            </Button>
          ) : (
            <Button size="sm" variant="ghost" disabled={stageBusy} onClick={() => onRemoveSpeaker(p.user_id)}>
              Move to audience
            </Button>
          )}
        </div>
      )}
    </div>
  );

  const groupLabel = (icon: ReactNode, text: string) => (
    <div className="mb-1.5 flex items-center gap-1.5 text-section uppercase text-text-muted">
      <span className="text-interactive-normal">{icon}</span>
      {text}
    </div>
  );

  return (
    <div className="shrink-0 px-5 pt-5">
      <div className="flex flex-col gap-4">
        {/* Channel identity + primary join */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-border-subtle bg-bg-secondary text-text-secondary shadow-sm">
              {isStage ? <Mic size={20} /> : <Headphones size={20} />}
            </div>
            <div className="min-w-0">
              <div className="truncate text-subhead text-text-primary">{channelName}</div>
              <div className="font-code text-meta text-text-muted">
                {participantCount === 0
                  ? isStage ? 'No one on stage' : 'No one connected'
                  : `${participantCount} connected`}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2.5">
            {voiceJoinError ? (
              channelId && guildId && (
                <Button variant="secondary" onClick={onRetryJoin}>
                  Try joining again
                </Button>
              )
            ) : (
              <Button
                size="lg"
                loading={voiceJoinPending}
                disabled={voiceJoinPending || !channelId || !guildId || (isStage && !stageInstance)}
                onClick={onJoin}
              >
                {!voiceJoinPending && <Headphones size={16} className="mr-1.5" />}
                {voiceJoinPending ? 'Connecting…' : isStage ? 'Join stage' : 'Join voice'}
              </Button>
            )}
          </div>
        </div>

        {voiceJoinError && (
          <div className="rounded-md border border-accent-danger/35 bg-danger-tint px-3.5 py-2.5 text-label text-accent-danger">
            {isStage ? 'Stage' : 'Voice'} connection failed: {voiceJoinError}
          </div>
        )}

        {isStage && (
          <div className="rounded-md border border-border-subtle bg-bg-secondary p-4 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-section uppercase text-text-muted">Stage session</div>
                {stageLoading ? (
                  <div className="mt-1 text-label text-text-secondary">Checking for a live stage…</div>
                ) : stageInstance ? (
                  <div className="mt-1 text-label text-text-secondary">
                    Live now — <span className="font-semibold text-text-primary">{stageInstance.topic || channelName}</span>
                  </div>
                ) : (
                  <div className="mt-1 text-label text-text-secondary">
                    No one has opened the stage yet.
                  </div>
                )}
              </div>
              {canManageStage && (
                <div className="flex flex-wrap items-center gap-2">
                  {!stageInstance ? (
                    <Button size="sm" loading={stageBusy} disabled={stageBusy || !channelId} onClick={onCreateStage}>
                      {stageBusy ? 'Starting…' : 'Open the stage'}
                    </Button>
                  ) : (
                    <>
                      <Button size="sm" variant="secondary" loading={stageBusy} disabled={stageBusy} onClick={onUpdateStage}>
                        {stageBusy ? 'Saving…' : 'Save topic'}
                      </Button>
                      <Button size="sm" variant="destructive" disabled={stageBusy} onClick={onEndStage}>
                        {stageBusy ? 'Ending…' : 'End stage'}
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
            {stageError && (
              <div className="mt-3 rounded-sm border border-accent-danger/35 bg-danger-tint px-2.5 py-1.5 text-meta font-medium text-accent-danger">
                {stageError}
              </div>
            )}
            {canManageStage && (
              <label className="mt-3 block">
                <span className="text-section uppercase text-text-muted">Topic</span>
                <input
                  type="text"
                  className="mt-1.5 w-full rounded-sm border border-border-subtle bg-bg-tertiary px-3 py-2 text-body text-text-primary placeholder:text-text-muted outline-none transition-[border-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] focus-visible:border-accent-primary focus-visible:shadow-[var(--focus-ring-input)]"
                  value={stageTopicDraft}
                  onChange={(event) => onStageTopicChange(event.target.value)}
                  placeholder="Weekly sync, product launch, Q&A…"
                  maxLength={160}
                />
              </label>
            )}
          </div>
        )}

        {/* Who's already here */}
        {lobbyParticipants.length > 0 ? (
          <div className="rounded-md border border-border-subtle bg-bg-secondary p-4 shadow-sm">
            {isStage ? (
              <>
                {lobbySpeakers.length > 0 && (
                  <div className="mb-3">
                    {groupLabel(<Mic size={12} />, `On stage — ${lobbySpeakers.length}`)}
                    <div className="flex flex-col gap-0.5">{lobbySpeakers.map(renderParticipant)}</div>
                  </div>
                )}
                {lobbySpeakers.length > 0 && lobbyAudience.length > 0 && (
                  <div className="my-2 border-t border-border-subtle" />
                )}
                {lobbyAudience.length > 0 && (
                  <div>
                    {groupLabel(<Users size={12} />, `Audience — ${lobbyAudience.length}`)}
                    <div className="flex flex-col gap-0.5">{lobbyAudience.map(renderParticipant)}</div>
                  </div>
                )}
              </>
            ) : (
              <>
                {groupLabel(<Users size={12} />, `In this channel — ${lobbyParticipants.length}`)}
                <div className="flex flex-col gap-0.5">{lobbyParticipants.map(renderParticipant)}</div>
              </>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-md border border-border-subtle bg-bg-secondary px-4 py-3.5 shadow-sm">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-accent-tint text-accent-primary">
              {isStage ? <Mic size={16} /> : <Headphones size={16} />}
            </div>
            <p className="text-label text-text-secondary">
              {isStage
                ? 'The stage is quiet — open it and be the first voice on.'
                : 'This voice channel is quiet — be the first to join.'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
