import { Hand, Headphones, HeadphoneOff, Mic, MicOff, MonitorUp, Users, Video } from 'lucide-react';
import type { ReactNode } from 'react';

import type { StageInstance } from '../../api/stage';
import type { VoiceState } from '../../types';
import type { RoomLight } from '../../lib/attention/light';
import { Button, IconButton, Plate, SectionLabel, TextField, Well } from '../../components/ui';
import { LightCaption, LiveDot, avatarInitials, roomCaptionFor } from '../../components/light';
import { VoiceConnectionCheckButton } from '../../components/voice/VoiceConnectionCheckButton';
import { getIdentityColor } from '../../lib/colors';
import { cn } from '../../lib/utils';
import { displayName } from '../../lib/displayName';

interface VoiceLobbyProps {
  channelName: string;
  participantCount: number;
  isStage: boolean;
  channelId: string | undefined;
  guildId: string | undefined;
  /** The room, as light (WP1) — the caption and the lit Join come from here. */
  room?: RoomLight | null;
  voiceJoinError: string | null;
  voiceJoinPending: boolean;
  onRetryJoin: () => void;
  onJoin: () => void;
  /** When set, streaming participants show a Watch button that calls this. */
  onWatchStream?: (userId: string) => void;
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

/**
 * A person in the room, seen from outside it. They are in a voice room, so
 * their lights are on — the rim has a source (§0).
 */
function ParticipantAvatar({ p }: { p: VoiceState }) {
  const name = displayName(p);
  return (
    <span
      className="pc-display pc-lit flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-meta font-bold text-text-on-light"
      style={{ background: getIdentityColor(p.user_id) }}
      aria-hidden
    >
      {avatarInitials(name)}
    </span>
  );
}

/**
 * The room you are not in yet (docs/lantern-stage-spec.md §7.2, §7.3).
 *
 * A lit room gets the white-light Join — somebody is in there right now; a dark
 * one says so in its own words and offers the same door. The Stage itself takes
 * over the moment you are in.
 */
export function VoiceLobby({
  channelName,
  participantCount,
  isStage,
  channelId,
  guildId,
  room = null,
  voiceJoinError,
  voiceJoinPending,
  onRetryJoin,
  onJoin,
  onWatchStream,
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
  const lit = participantCount > 0;
  const caption = room
    ? roomCaptionFor(room, { surface: 'card', withLastLit: !room.lit })
    : lit
      ? `${participantCount} in`
      : "Dark · nobody's in";

  const renderParticipant = (p: VoiceState) => (
    <li
      key={p.user_id}
      className="flex items-center gap-2.5 rounded-[var(--radius-control)] px-2 py-1.5 transition-colors hover:bg-bg-mod-subtle"
    >
      <ParticipantAvatar p={p} />
      <span className="min-w-0 flex-1 truncate text-label text-text-primary">
        {displayName(p)}
      </span>
      <div className="flex items-center gap-1.5">
        {isStage && p.request_to_speak_at && (
          <span className="inline-flex items-center gap-1 rounded-[var(--radius-chip)] bg-bg-mod-strong px-2 py-0.5 text-meta text-text-secondary">
            <Hand size={11} /> Raised a hand
          </span>
        )}
        {p.self_mute && (
          <span title="Muted"><MicOff size={14} className="text-accent-danger" /></span>
        )}
        {p.self_deaf && (
          <span title="Deafened"><HeadphoneOff size={14} className="text-accent-danger" /></span>
        )}
        {p.self_video && (
          <span title="Camera on"><Video size={14} className="text-text-secondary" /></span>
        )}
        {p.self_stream && (
          onWatchStream ? (
            <Button
              size="sm"
              variant="light"
              onClick={() => onWatchStream(p.user_id)}
              aria-label={`Watch ${displayName(p)}'s screen`}
            >
              Watch
            </Button>
          ) : (
            <span title="Sharing a screen"><MonitorUp size={14} className="text-light-white" /></span>
          )
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
              Move to the audience
            </Button>
          )}
        </div>
      )}
    </li>
  );

  const groupLabel = (icon: ReactNode, text: string) => (
    <SectionLabel className="mb-1.5 flex items-center gap-1.5">
      <span aria-hidden>{icon}</span>
      {text}
    </SectionLabel>
  );

  return (
    <Plate
      as="section"
      bare
      lit={lit}
      className="relative m-[var(--gutter)] flex flex-col gap-4 overflow-hidden p-5"
    >
      {/* The room, and the door into it. */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Well
            bare
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-well)] text-text-secondary"
          >
            {isStage ? <Mic size={20} /> : <Headphones size={20} />}
          </Well>
          <div className="min-w-0">
            <div className="pc-display truncate text-heading text-text-primary">{channelName}</div>
            <div className="flex items-center gap-2">
              {lit && <LiveDot />}
              <LightCaption>{caption}</LightCaption>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2.5">
          {voiceJoinError ? (
            <>
              <VoiceConnectionCheckButton variant="ghost" label="Run a connection check" autoStart />
              {channelId && guildId && (
                <Button variant="light" onClick={onRetryJoin}>
                  Try joining again
                </Button>
              )}
            </>
          ) : (
            <Button
              size="lg"
              variant={lit ? 'light' : 'primary'}
              loading={voiceJoinPending}
              disabled={voiceJoinPending || !channelId || !guildId || (isStage && !stageInstance)}
              onClick={onJoin}
            >
              {!voiceJoinPending && <Headphones size={16} className="mr-1.5" />}
              {voiceJoinPending ? `Joining ${channelName}` : isStage ? 'Join the stage' : 'Join the room'}
            </Button>
          )}
        </div>
      </div>

      {voiceJoinError && (
        <Well bare className="px-3.5 py-2.5">
          <p className="text-label text-accent-danger">
            {isStage ? 'The stage' : 'The room'} would not open: {voiceJoinError}
          </p>
          <p className="mt-1 text-meta text-text-secondary">
            Chat still works. Calls take a separate network path, so the connection check above
            will say which part of it failed.
          </p>
        </Well>
      )}

      {isStage && (
        <Well bare className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <SectionLabel>Stage session</SectionLabel>
              {stageLoading ? (
                <div className="mt-1 text-label text-text-secondary">Looking for a live stage…</div>
              ) : stageInstance ? (
                <div className="mt-1 text-label text-text-secondary">
                  Live now — <span className="font-semibold text-text-primary">{stageInstance.topic || channelName}</span>
                </div>
              ) : (
                <div className="mt-1 text-label text-text-secondary">
                  Nobody has opened the stage yet.
                </div>
              )}
            </div>
            {canManageStage && (
              <div className="flex flex-wrap items-center gap-2">
                {!stageInstance ? (
                  <Button size="sm" loading={stageBusy} disabled={stageBusy || !channelId} onClick={onCreateStage}>
                    {stageBusy ? 'Opening…' : 'Open the stage'}
                  </Button>
                ) : (
                  <>
                    <Button size="sm" variant="ghost" loading={stageBusy} disabled={stageBusy} onClick={onUpdateStage}>
                      {stageBusy ? 'Saving…' : 'Save the topic'}
                    </Button>
                    <Button size="sm" variant="danger" disabled={stageBusy} onClick={onEndStage}>
                      {stageBusy ? 'Ending…' : 'End the stage'}
                    </Button>
                  </>
                )}
              </div>
            )}
          </div>
          {stageError && (
            <p role="alert" className="mt-3 text-meta font-medium text-accent-danger">
              {stageError}
            </p>
          )}
          {canManageStage && (
            <TextField
              label="Topic"
              className="mt-3"
              value={stageTopicDraft}
              onChange={(event) => onStageTopicChange(event.target.value)}
              placeholder="Weekly sync, product launch, Q&A…"
              maxLength={160}
            />
          )}
        </Well>
      )}

      {/* Who is already in there. */}
      {lobbyParticipants.length > 0 ? (
        <Well bare className="p-4">
          {isStage ? (
            <>
              {lobbySpeakers.length > 0 && (
                <div className={cn(lobbyAudience.length > 0 && 'mb-3')}>
                  {groupLabel(<Mic size={12} />, `On stage — ${lobbySpeakers.length}`)}
                  <ul className="flex flex-col gap-0.5">{lobbySpeakers.map(renderParticipant)}</ul>
                </div>
              )}
              {lobbySpeakers.length > 0 && lobbyAudience.length > 0 && (
                <div className="my-2 border-t border-border-subtle" />
              )}
              {lobbyAudience.length > 0 && (
                <div>
                  {groupLabel(<Users size={12} />, `Listening — ${lobbyAudience.length}`)}
                  <ul className="flex flex-col gap-0.5">{lobbyAudience.map(renderParticipant)}</ul>
                </div>
              )}
            </>
          ) : (
            <>
              {groupLabel(<Users size={12} />, `In this room — ${lobbyParticipants.length}`)}
              <ul className="flex flex-col gap-0.5">{lobbyParticipants.map(renderParticipant)}</ul>
            </>
          )}
        </Well>
      ) : (
        <Well bare className="flex items-center gap-3 px-4 py-3.5">
          <IconButton label={isStage ? 'Open the stage' : 'Join the room'} size="md" tone="raised" onClick={onJoin}>
            {isStage ? <Mic size={16} /> : <Headphones size={16} />}
          </IconButton>
          <p className="text-label text-text-secondary">
            {isStage
              ? 'The stage is dark — open it and be the first voice on.'
              : `${channelName} is dark. Walk in and the window lights up.`}
          </p>
        </Well>
      )}
    </Plate>
  );
}
