import { Headphones, HeadphoneOff, Mic, MicOff, Monitor, Users, Video } from 'lucide-react';
import type { StageInstance } from '../../api/stage';
import type { VoiceState } from '../../types';

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
    <div key={p.user_id} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg-mod-strong text-xs font-semibold text-text-secondary">
        {(p.username || '?')[0].toUpperCase()}
      </div>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
        {p.username || p.user_id}
      </span>
      <div className="flex items-center gap-1.5 text-text-muted">
        {p.self_mute && <span title="Muted"><MicOff size={13} className="text-accent-danger" /></span>}
        {p.self_deaf && <span title="Deafened"><HeadphoneOff size={13} className="text-accent-danger" /></span>}
        {p.self_video && <span title="Camera on"><Video size={13} className="text-accent-primary" /></span>}
        {p.self_stream && <span title="Streaming"><Monitor size={13} className="text-accent-primary" /></span>}
      </div>
      {isStage && canManageStage && stageInstance && (
        <div className="ml-2 flex items-center gap-1.5">
          {p.suppress ? (
            <button
              type="button"
              className="rounded-md border border-accent-primary/35 bg-accent-primary/10 px-2 py-0.5 text-[11px] font-semibold text-accent-primary transition-colors hover:bg-accent-primary/20"
              disabled={stageBusy}
              onClick={() => {
                onInviteSpeaker(p.user_id);
              }}
            >
              Invite Speaker
            </button>
          ) : (
            <button
              type="button"
              className="rounded-md border border-border-subtle bg-bg-primary px-2 py-0.5 text-[11px] font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong"
              disabled={stageBusy}
              onClick={() => {
                onRemoveSpeaker(p.user_id);
              }}
            >
              Move Audience
            </button>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="p-3 sm:p-4 shrink-0 px-5 pt-5 pb-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border-subtle bg-bg-mod-subtle text-text-secondary">
            <Users size={19} />
          </div>
          <div>
            <div className="text-base font-semibold leading-tight text-text-primary">{channelName}</div>
            <div className="text-xs leading-tight text-text-secondary">Participants: {participantCount}</div>
          </div>
        </div>
        <div className="flex w-full flex-col gap-3">
          {/* Join / error / pending controls */}
          <div className="flex w-full flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2.5">
            {voiceJoinError ? (
              <>
                <div className="w-full rounded-xl border border-accent-danger/40 bg-accent-danger/10 px-3.5 py-2.5 text-sm font-medium text-accent-danger sm:w-auto">
                  {isStage ? 'Stage join failed' : 'Voice join failed'}: {voiceJoinError}
                </div>
                {channelId && guildId && (
                  <button
                    className="control-pill-btn w-full justify-center sm:w-auto"
                    onClick={onRetryJoin}
                  >
                    Retry Join
                  </button>
                )}
              </>
            ) : (
              <button
                className="control-pill-btn w-full justify-center border-accent-primary/50 bg-accent-primary/15 text-text-primary hover:bg-accent-primary/25 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
                disabled={voiceJoinPending || !channelId || !guildId || (isStage && !stageInstance)}
                onClick={onJoin}
              >
                {voiceJoinPending ? (
                  <>
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    Connecting...
                  </>
                ) : (
                  <>
                    <Headphones size={16} />
                    {isStage ? 'Join Stage' : 'Join Voice'}
                  </>
                )}
              </button>
            )}
          </div>

          {isStage && (
            <div className="rounded-xl border border-border-subtle bg-bg-mod-subtle/65 px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                    Stage Instance
                  </div>
                  {stageLoading ? (
                    <div className="mt-1 text-sm text-text-secondary">Loading stage...</div>
                  ) : stageInstance ? (
                    <div className="mt-1 text-sm text-text-secondary">
                      Live now: <span className="font-semibold text-text-primary">{stageInstance.topic || channelName}</span>
                    </div>
                  ) : (
                    <div className="mt-1 text-sm text-text-secondary">
                      No live stage session yet.
                    </div>
                  )}
                  {stageError && (
                    <div className="mt-2 rounded-lg border border-accent-danger/35 bg-accent-danger/10 px-2.5 py-1.5 text-xs font-medium text-accent-danger">
                      {stageError}
                    </div>
                  )}
                </div>
                {canManageStage && (
                  <div className="flex flex-wrap items-center gap-2">
                    {!stageInstance ? (
                      <button
                        type="button"
                        className="control-pill-btn"
                        disabled={stageBusy || !channelId}
                        onClick={onCreateStage}
                      >
                        {stageBusy ? 'Starting...' : 'Start Stage'}
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="control-pill-btn"
                          disabled={stageBusy}
                          onClick={onUpdateStage}
                        >
                          {stageBusy ? 'Saving...' : 'Save Topic'}
                        </button>
                        <button
                          type="button"
                          className="control-pill-btn border-accent-danger/40 bg-accent-danger/12 text-accent-danger hover:bg-accent-danger/20"
                          disabled={stageBusy}
                          onClick={onEndStage}
                        >
                          {stageBusy ? 'Ending...' : 'End Stage'}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
              {canManageStage && (
                <label className="mt-3 block">
                  <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                    Topic
                  </span>
                  <input
                    type="text"
                    className="mt-1.5 w-full rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:border-border-strong"
                    value={stageTopicDraft}
                    onChange={(event) => onStageTopicChange(event.target.value)}
                    placeholder="Weekly sync, product launch, Q&A..."
                    maxLength={160}
                  />
                </label>
              )}
            </div>
          )}

          {/* Lobby: show who's already in the channel */}
          {lobbyParticipants.length > 0 && (
            <div className="rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-4 py-3">
              {isStage ? (
                <>
                  {lobbySpeakers.length > 0 && (
                    <div className="mb-3">
                      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-text-muted">
                        <Mic size={12} />
                        On Stage — {lobbySpeakers.length}
                      </div>
                      <div className="flex flex-col gap-1">
                        {lobbySpeakers.map(renderParticipant)}
                      </div>
                    </div>
                  )}
                  {lobbySpeakers.length > 0 && lobbyAudience.length > 0 && (
                    <div className="my-2 border-t border-border-subtle/60" />
                  )}
                  {lobbyAudience.length > 0 && (
                    <div>
                      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-text-muted">
                        <Users size={12} />
                        Audience — {lobbyAudience.length}
                      </div>
                      <div className="flex flex-col gap-1">
                        {lobbyAudience.map(renderParticipant)}
                      </div>
                    </div>
                  )}
                  {lobbySpeakers.length === 0 && lobbyAudience.length === 0 && (
                    <div className="text-xs text-text-muted">No participants yet.</div>
                  )}
                </>
              ) : (
                <>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-muted">
                    In Channel — {lobbyParticipants.length}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {lobbyParticipants.map(renderParticipant)}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
