import { useCallback, useEffect } from 'react';
import { MonitorPlay, PanelLeft, X } from 'lucide-react';

import { useGlassKeybinds } from '../../../hooks/useGlassKeybinds';
import { useGlassStore, type OpenStageMode, type StageTarget } from '../../../stores/glassStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import { ErrorBoundary } from '../../ErrorBoundary';
import { TogetherNowPlaying, TogetherWatchStage } from '../../voice/together/TogetherStage';
import { useTogether } from '../../voice/together/useTogether';
import { useGlassLayout } from '../shell/useGlassLayout';
import { CallEmpty } from './CallEmpty';
import type { StageModel } from './stageModel';
import { StageControls } from './StageControls';
import { StagePeople } from './StagePeople';
import { useStageData } from './useStageData';

/**
 * The call itself on the stage (`target.streamerId === null`): nobody's screen
 * is being watched, so the people take the stage.
 *
 * It is how a joined person reaches everything a call does besides watching a
 * stream, the way the stream's stage does it (docs/glass-spec.md §6.1; owner
 * decisions, docs/design/glass-plan.md §8.4): the cameras, large; turning your
 * own camera on; starting a screen share; Deafen and devices in the
 * microphone's menu; the soundboard, Watch together, invite and the connection
 * check under More; and Leave. A Watch together video plays here too, and a
 * Listen together session shows what is playing. The pill opens it ("Show the
 * call") when there is no stream to watch; a click on somebody who starts
 * sharing switches it to their stream.
 *
 * It keeps the stage's pane, title row and control row. There is no theater
 * (no stream to fill the window with), so T, H and C stay free; S browses, Esc
 * and Close put it away. Closing it never leaves the call.
 *
 * A direct message call is the same, named for the people in it, with no
 * server (no invite, soundboard or Watch together). Its people share their
 * screens and watch each other's like anyone in a call.
 */
export function CallStage({ target, mode }: { target: StageTarget; mode: OpenStageMode }) {
  const layout = useGlassLayout();
  const phone = layout === 'phone';
  const { model } = useStageData(target);
  const callEngine = useVoiceStore((state) => state.mediaEngine);
  const browseOpen = useGlassStore((state) => state.browseOpen);
  const toggleBrowse = useGlassStore((state) => state.toggleBrowse);
  const openStage = useGlassStore((state) => state.openStage);
  const setStageMode = useGlassStore((state) => state.setStageMode);
  const togetherInCall = useTogether();
  const together = togetherInCall && togetherInCall.channelId === target.channelId ? togetherInCall : null;
  const watchTogether = together?.session?.kind === 'watch' ? together : null;
  const listenTogether = together?.session && together.session.kind !== 'watch' ? together : null;

  useGlassKeybinds({ enabled: true, phone, stream: false, onStop: closeCall });

  // Nothing is watched while the call itself is on the stage.
  useEffect(() => {
    if (useVoiceStore.getState().watchView) void useVoiceStore.getState().stopWatch();
  }, []);

  // Theater is the stream filling the window; with no stream the desktop stays
  // side by side. (The phone's full screen is its own and stays.)
  useEffect(() => {
    if (mode === 'theater' && !phone) setStageMode('side');
  }, [mode, phone, setStageMode]);

  const switchTo = useCallback(
    (streamerId: string) => openStage({ ...target, streamerId }),
    [openStage, target],
  );

  const notice = callNotice(model);
  // No camera on: the people themselves are the stage (`CallEmpty`).
  const noCameras = model.cameras.length === 0;
  const joined = model.relation === 'joined';
  const realVoice = model.relation === 'joined' || model.relation === 'listening';

  const people = (
    <StagePeople
      cameras={model.cameras}
      chips={model.chips}
      callEngine={callEngine}
      joined={joined}
      realVoice={realVoice}
      watchedId={null}
      onSwitch={switchTo}
    />
  );

  return (
    <div
      className="glass-stage"
      data-view="call"
      data-mode="side"
      data-layout={phone ? 'phone' : 'pane'}
      data-browse={browseOpen ? 'true' : undefined}
      data-together={watchTogether ? 'watch' : undefined}
      data-cameras={model.cameras.length > 0 ? 'true' : undefined}
    >
      {!phone && (
        <div className="glass-stage__call-bar">
          <div className="glass-stage__title-group">
            <button
              type="button"
              className="glass-stage__sbtn glass-focusable"
              aria-label={browseOpen ? 'Hide servers and channels' : 'Show servers and channels'}
              aria-pressed={browseOpen}
              aria-keyshortcuts="S"
              title="Servers and channels (S)"
              onClick={toggleBrowse}
            >
              <PanelLeft size={18} strokeWidth={1.7} aria-hidden="true" />
            </button>
            <span className="glass-stage__live-dot" aria-hidden="true" />
            <span className="glass-stage__titles">
              <span className="glass-stage__title">{model.label}</span>
              <span className="glass-stage__subtitle">{model.subtitle}</span>
            </span>
          </div>
          <div className="glass-stage__actions">
            <button
              type="button"
              className="glass-stage__sbtn glass-stage__stop glass-focusable"
              aria-keyshortcuts="Escape"
              title="Close (Esc). You stay in the call."
              onClick={closeCall}
            >
              <X size={16} strokeWidth={2} aria-hidden="true" />
              <span>Close</span>
            </button>
          </div>
        </div>
      )}

      <div className="glass-stage__call-main">
        {watchTogether ? (
          <ErrorBoundary variant="section" label="Watch together">
            <TogetherWatchStage together={watchTogether} phone={phone} />
          </ErrorBoundary>
        ) : noCameras ? (
          <CallEmpty
            people={model.chips}
            name={model.label}
            line={notice ?? ''}
            realVoice={realVoice}
            phone={phone}
            onSwitch={switchTo}
          />
        ) : (
          people
        )}
      </div>

      {[...model.cameras, ...model.chips].some((person) => person.sharing) && (
        <div className="glass-call-streams" role="group" aria-label="Shared screens">
          {[...model.cameras, ...model.chips].filter((person) => person.sharing).map((person) => (
            <button key={person.userId} type="button" className="glass-call-streams__watch glass-focusable"
              onClick={() => switchTo(person.userId)}
              aria-label={person.self ? 'Watch your stream' : `Watch ${person.name}’s stream`}>
              <MonitorPlay size={22} strokeWidth={1.6} aria-hidden="true" />
              <span><strong>{person.self ? 'Your screen' : `${person.name}’s screen`}</strong><small>{person.self ? 'Show preview' : 'Watch stream'}</small></span>
            </button>
          ))}
        </div>
      )}

      {watchTogether && !phone && <div className="glass-stage__call-row">{people}</div>}

      {listenTogether && (
        <div className="glass-stage__call-together">
          <ErrorBoundary variant="section" label="Listen together">
            <TogetherNowPlaying together={listenTogether} phone={phone} />
          </ErrorBoundary>
        </div>
      )}

      {!phone && <StageControls target={target} model={model} fit={0} />}
    </div>
  );
}

/** "Close" and Esc: the stage goes, the call stays. */
function closeCall(): void {
  useGlassStore.getState().closeStage();
}

/**
 * What the call with no cameras says under the faces (`CallEmpty`): what is not
 * happening, or what to do about it. Null while there are cameras to show.
 */
export function callNotice(model: StageModel): string | null {
  if (model.cameras.length > 0) return null;
  if (model.relation !== 'joined') {
    return model.relation === 'joining' ? `Joining ${model.channelName}…` : 'Join the call to see cameras and share your screen.';
  }
  const self = model.chips.find((person) => person.self);
  if (self?.sharing) return 'You are sharing your screen. Everyone in the call can watch it.';
  const sharing = model.otherSharers;
  if (sharing.length === 1) return `${sharing[0].name} is sharing their screen`;
  if (sharing.length === 2) return `${sharing[0].name} and ${sharing[1].name} are sharing their screens`;
  if (sharing.length > 2) return `${sharing.length} people are sharing their screens`;
  return 'No one is sharing';
}
