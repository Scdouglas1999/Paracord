import { useLocation, useSearchParams } from 'react-router';

import {
  RoomChatRibbon,
  SpeakerGrid,
  StageControlBar,
  StageHeader,
  StageLayout,
  StageNotice,
  StageStatus,
  StageTile,
} from '../components/voice/stage';
import { AvatarStack, HereNowStrip, LitAvatar } from '../components/light';
import { Button, IconButton, Raised, Well } from '../components/ui';
import { personLight } from '../lib/attention/light';
import {
  Headphones,
  LayoutList,
  LogOut,
  MessageSquare,
  Mic,
  MonitorUp,
  MoreHorizontal,
  UserPlus,
  Video,
} from 'lucide-react';

/**
 * `/design-stage` — the Stage, at full size, from fixture models
 * (docs/lantern-stage-spec.md §7.2). **Dev builds only**, registered the same
 * way `/design-tokens` is and stripped from production by the same fold-to-null.
 *
 * The screenshot gate needs the real composed surface at 1440×900 and 390×844,
 * which a live call cannot give a mocked browser: there is no media server on
 * the other end of the e2e run. So the page hands the same components the same
 * shapes the call hands them, and nothing else — if this page looks right, the
 * Stage looks right, because it is the Stage.
 *
 *   /design-stage?state=share        share + four speakers (artboard 1)
 *   /design-stage?state=speakers     nobody sharing
 *   /design-stage?state=joining      "Joining Shop floor"
 *   /design-stage?state=reconnecting "Reconnecting to Shop floor · 3 s"
 *   /design-stage?phone=1            the 390×844 arrangement (artboard 5)
 */

const MARA = personLight({
  userId: '101',
  name: 'Mara Okafor',
  status: 'online',
  speaking: true,
  inRoom: true,
  roomName: 'Shop floor',
});
const PRIYA = personLight({ userId: '102', name: 'Priya Raman', status: 'online', inRoom: true, roomName: 'Shop floor' });
const REN = personLight({ userId: '103', name: 'Ren Ito', status: 'online', inRoom: true, roomName: 'Shop floor' });
const SAM = personLight({ userId: '104', name: 'Sam Douglas', status: 'online', inRoom: true, roomName: 'Shop floor' });

const HERE_NOW = {
  people: [MARA, PRIYA, REN, SAM],
  here: 4,
  lightsOn: 20,
  caption: '4 here · 20 lights on',
};

const RIBBON_MESSAGES = [
  { person: MARA, time: '09:12', body: 'Driver board v3 came back from the fab. Solder mask is the right green this time.' },
  { person: REN, time: '09:31', body: 'Nice. Did the mounting holes move? The v2 bracket was 0.4 mm off.' },
  { person: MARA, time: '09:34', body: 'Same footprint — I only touched the copper pour.' },
  { person: PRIYA, time: '10:02', body: 'Thermal rig is booked 1–3 pm. I will be in the shop if anyone wants to watch it cook.' },
];

function RibbonMessage({
  person,
  time,
  body,
  fromRoom = false,
}: {
  person: typeof MARA;
  time: string;
  body: string;
  fromRoom?: boolean;
}) {
  return (
    <div
      className={
        fromRoom
          ? 'mx-2 mt-1 grid grid-cols-[28px_minmax(0,1fr)] gap-x-2.5 rounded-[var(--radius-well)] bg-bg-raised p-2 shadow-[var(--shadow-raised)]'
          : 'grid grid-cols-[28px_minmax(0,1fr)] gap-x-2.5 px-3.5 py-1'
      }
    >
      <LitAvatar person={person} size={28} hideLabel />
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="pc-display text-name text-text-primary">{person.name.split(' ')[0]}</span>
          <span className="pc-mono text-meta text-text-faint">{time}</span>
          {fromRoom && <span className="text-meta text-text-faint">in Shop floor</span>}
        </div>
        <p className="text-ribbon text-text-body">{body}</p>
      </div>
    </div>
  );
}

export default function StagePreviewPage() {
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const state = params.get('state') ?? 'share';
  const phone = params.get('phone') === '1';
  // Mounted at /app/design-stage the page is the AppShell's outlet, so the
  // Buildings column is beside it exactly as it is in a real call (§7.1); the
  // shell already owns the viewport height and the gutter. Mounted at
  // /design-stage it owns the window itself.
  const inShell = pathname.startsWith('/app/');
  const sharing = state === 'share';

  const hasDominant = state !== 'speakers';
  const speakers = (
    <SpeakerGrid arrangement={hasDominant ? 'strip' : 'grid'} compact={phone} count={4} className="h-full">
      {[MARA, PRIYA, REN, SAM].map((person, index) => (
        <li key={person.userId} className="min-h-0 min-w-0">
          <StageTile
            className="h-full w-full"
            style={hasDominant ? undefined : { aspectRatio: '16 / 9' }}
            person={person}
            name={person.userId === SAM.userId ? 'You' : person.name.split(' ')[0]}
            speaking={index === 0}
            muted={index === 2}
            avatarSize={44}
          />
        </li>
      ))}
    </SpeakerGrid>
  );

  const dominant = sharing ? (
    <StageTile
      dominant
      name="Mara’s screen"
      sharing
      readout="QUIC"
      live
      className="h-full w-full"
    >
      <div className="flex h-full w-full items-center justify-center bg-bg-well">
        <span className="pc-display text-heading text-text-faint">
          Driver v3 — thermal soak, channel 7
        </span>
      </div>
    </StageTile>
  ) : state === 'joining' || state === 'failed' ? (
    <StageStatus
      phase={state === 'joining' ? 'joining' : 'failed'}
      roomName="Shop floor"
      reason={state === 'failed' ? 'The media server refused the ticket.' : null}
      actions={
        state === 'failed' ? (
          <>
            <Button variant="light">Try joining again</Button>
            <Button variant="ghost">Run a connection check</Button>
          </>
        ) : undefined
      }
    />
  ) : null;

  const controls = (
    <StageControlBar compact={phone}>
      <IconButton label="Mute microphone" size="stage" tone="light"><Mic size={20} /></IconButton>
      <IconButton label="Deafen audio" size="stage" tone="raised"><Headphones size={20} /></IconButton>
      <IconButton label="Turn on camera" size="stage" tone="raised"><Video size={20} /></IconButton>
      <IconButton label="Share screen" size="stage" tone="raised"><MonitorUp size={20} /></IconButton>
      {!phone && (
        <IconButton label="Hide voice chat" size="stage" tone="raised"><MessageSquare size={20} /></IconButton>
      )}
      <IconButton label="Disconnect from voice" size="stage" tone="danger" className="w-[72px] sm:w-16">
        <LogOut size={20} />
      </IconButton>
    </StageControlBar>
  );

  const ribbon = (
    <RoomChatRibbon
      roomName="build-log"
      lit
      surface={phone ? 'sheet' : 'ribbon'}
      composer={
        <Well bare className="flex h-[var(--h-composer-ribbon)] items-center gap-2 pl-3 pr-1.5">
          <span className="flex-1 truncate text-label text-text-faint">Say something to the room</span>
          <span className="inline-flex h-[30px] items-center rounded-[var(--radius-control)] bg-light-white px-3 text-label font-semibold text-text-on-light shadow-[var(--glow-control-on)]">
            Send
          </span>
        </Well>
      }
    >
      <div className="flex flex-col justify-end gap-0.5 pb-1.5">
        {RIBBON_MESSAGES.slice(phone ? 2 : 0).map((message) => (
          <RibbonMessage key={`${message.person.userId}-${message.time}`} {...message} />
        ))}
        <RibbonMessage
          person={MARA}
          time="10:31"
          body="Q3 is running hot — 72° at 20 minutes. Watch the green line."
          fromRoom
        />
      </div>
    </RoomChatRibbon>
  );

  return (
    <div
      className={
        inShell
          ? 'flex h-full min-h-0 w-full flex-col bg-bg-base'
          : 'flex h-[100dvh] w-full flex-col bg-bg-base p-[var(--gutter)]'
      }
    >
      <StageLayout
        phone={phone}
        header={
          <StageHeader
            compact={phone}
            roomName="Shop floor"
            buildingName="Kestrel"
            durationMs={34 * 60_000 + 12_000}
            hereCaption={phone ? '4 here' : null}
            hereNow={
              phone ? (
                <AvatarStack people={HERE_NOW.people} size={26} max={3} context="in Shop floor" />
              ) : (
                <HereNowStrip hereNow={HERE_NOW} context="in Shop floor" />
              )
            }
            actions={
              <>
                {!phone && (
                  <>
                    <Button variant="ghost"><UserPlus size={16} className="mr-1.5" />Invite</Button>
                    <Button variant="ghost"><LayoutList size={16} className="mr-1.5" />Layout</Button>
                  </>
                )}
                <IconButton label="More room actions" size="md" tone="ghost">
                  <MoreHorizontal size={18} />
                </IconButton>
              </>
            }
          />
        }
        notice={
          state === 'reconnecting' ? (
            <Raised bare className="shrink-0 px-3 py-2">
              <StageNotice phase="reconnecting" roomName="Shop floor" elapsedMs={3_000} />
            </Raised>
          ) : undefined
        }
        dominant={dominant}
        speakers={speakers}
        controls={state === 'joining' || state === 'failed' ? null : controls}
        ribbon={ribbon}
      />
    </div>
  );
}
