/**
 * The Stage (docs/lantern-stage-spec.md §7.2, §8).
 *
 * Presentational only: every component here takes what is true about the call
 * and draws it. The wiring — tracks, participants, the media engines — stays in
 * `src/pages/guild/VoiceStageChannel.tsx` and the containers beside this folder.
 */
export { StageTile, type StageTileProps } from './StageTile';
export { StageHeader, type StageHeaderProps } from './StageHeader';
export { StageControlBar, type StageControlBarProps } from './StageControlBar';
export {
  SpeakerGrid,
  speakerColumns,
  type SpeakerGridProps,
  type SpeakerArrangement,
} from './SpeakerGrid';
export {
  StageLayout,
  SPEAKER_STRIP_HEIGHT,
  PHONE_DOMINANT_HEIGHT,
  type StageLayoutProps,
} from './StageLayout';
export { RoomChatRibbon, type RoomChatRibbonProps } from './RoomChatRibbon';
export {
  StageStatus,
  StageNotice,
  type StageNoticeProps,
  stageStatusMessage,
  stageStatusDetail,
  type StagePhase,
  type StageStatusProps,
} from './StageStatus';
export {
  transportReadout,
  callTransport,
  type CallTransport,
  type LinkQuality,
  type TransportReadoutInput,
} from './transportReadout';
