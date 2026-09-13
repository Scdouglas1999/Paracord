import { useState } from 'react';

import { StageTile } from './stage';
import { CameraSurface } from './CameraSurface';
import { useVoiceStore } from '../../stores/voiceStore';

interface FocusedWebcamViewProps {
  participantId: string;
  username: string;
  isLocal: boolean;
}

/**
 * One participant's camera filling its container — the split pane's webcam
 * source (docs/lantern-stage-spec.md §7.2).
 *
 * It is a Stage tile at full size: the name tag bottom-left, the speaking ring
 * when they are talking, and their initials on the dark tile when the camera is
 * off. The frames themselves come from {@link CameraSurface}, which is the same
 * attach logic every other tile uses.
 */
export function FocusedWebcamView({ participantId, username, isLocal }: FocusedWebcamViewProps) {
  const speakingUsers = useVoiceStore((s) => s.speakingUsers);
  const [hasTrack, setHasTrack] = useState(false);

  return (
    <StageTile
      dominant
      name={username}
      speaking={speakingUsers.has(participantId)}
      userId={participantId}
      live={hasTrack}
      avatarSize={84}
      className="rounded-none"
    >
      <CameraSurface
        participantId={participantId}
        isLocal={isLocal}
        onTrackChange={setHasTrack}
      />
    </StageTile>
  );
}
