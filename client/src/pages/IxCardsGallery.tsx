import { useState, type CSSProperties, type ReactNode } from 'react';

import { FilePreview } from '../components/file/FilePreview';
import { FeedPostCard, type FeedEmbed } from '../components/feeds/FeedPostCard';
import { GlassFile } from '../components/glass/cards/MediaFrame';
import { ChannelChipView, EventChipView } from '../components/glass/cards/InlineChips';
import { EventButton, EventCard } from '../components/glass/cards/EventCard';
import { EventPlanCard, EventPlanView, EventUnavailable } from '../components/glass/cards/EventPlanCard';
import { PlanAction, PlanCard } from '../components/glass/cards/PlanCard';
import type { GuildEventView } from '../components/glass/cards/useGuildEvent';
import CodeBlock from '../components/message/CodeBlock';
import { EphemeralMessage } from '../components/message/EphemeralMessage';
import { GitHubEventEmbed } from '../components/message/GitHubEventEmbed';
import { MessageComponents } from '../components/message/MessageComponents';
import { MessageEmbedCard } from '../components/message/MessageEmbed';
import { PollCard, PollMessageCard } from '../components/message/PollMessageCard';
import { ScoreUpdateCard } from '../components/sports/ScoreUpdateCard';
import type { SportsTeam } from '../api/sports';
import type { Poll, PollOption } from '../types';
import { ButtonStyle, ComponentType, type Component } from '../types/components';

/**
 * The conversation cards, every one in every state it has (docs/index-spec.md
 * §4.11, §8.4; `styles/ix-cards.css`). Dev builds only, at `/ix-cards`. The
 * `index-cards` e2e spec shoots it and drives it.
 *
 *   /ix-cards?hue=350                    a place's hue (the weekday, the code's keywords, the file tile)
 *   /ix-cards?theme=glass-contrast       the High contrast look
 *
 * Everything here is drawn from data with the clock pinned (NOW), except the two
 * "wired" cards at the end, which are the real components over the real stores:
 * the spec answers their API calls. Pictures are `/ix-gallery/<name>.png`, which
 * the spec supplies too; opened by hand, they are blank.
 */

/** Monday 5 October 2026, 9:12 PM, in the page's zone: so Friday the 9th reads "Friday at 9:00 PM". */
const NOW = new Date(2026, 9, 5, 21, 12).getTime();
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);

const event = (over: Partial<GuildEventView> = {}): GuildEventView => ({
  id: '7001',
  guildId: 'g1',
  name: 'Game night',
  startsAt: at(9, 21),
  endsAt: null,
  channelId: 'c1',
  location: null,
  creatorId: '1001',
  going: 3,
  youAreGoing: false,
  status: 1,
  ...over,
});

// The app's html, body and root never scroll (tokens.css): the page is its own scroller.
const stage: CSSProperties = {
  height: '100%',
  overflowY: 'auto',
  boxSizing: 'border-box',
  padding: '32px 48px 96px',
  color: 'var(--ix-ink)',
  fontFamily: 'inherit',
};

function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: ReactNode }) {
  return (
    <section data-section={id} style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 36 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '4px 12px' }}>
        <h2 style={{ margin: 0, fontSize: 14.5, fontWeight: 600, color: 'var(--ix-ink-2)' }}>{title}</h2>
        {note && <span style={{ fontSize: 12.5, color: 'var(--ix-ink-3)' }}>{note}</span>}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 16 }}>{children}</div>
    </section>
  );
}

function Cell({ label, id, children }: { label: string; id?: string; children: ReactNode }) {
  return (
    <div data-cell={id} style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start', minWidth: 0, maxWidth: '100%' }}>
      <span style={{ fontSize: 11.5, color: 'var(--ix-ink-3)' }}>{label}</span>
      {children}
    </div>
  );
}

/** A bubble, for the cards that sit inside one: only what the chips and the ephemeral line need. */
function Bubble({ own, children }: { own?: boolean; children: ReactNode }) {
  return (
    <p
      data-own={own || undefined}
      style={{
        margin: 0,
        padding: '9px 14px',
        maxWidth: 520,
        borderRadius: 19,
        background: own ? 'var(--ix-cream)' : 'var(--ix-bubble)',
        color: own ? 'var(--ix-cream-ink)' : 'var(--ix-ink)',
        fontSize: 15,
        lineHeight: 1.42,
      }}
    >
      {children}
    </p>
  );
}

// ---- Events -----------------------------------------------------------------

function InteractiveEvent() {
  const [going, setGoing] = useState(false);
  const [maybe, setMaybe] = useState(false);
  return (
    <div data-testid="gallery-event" style={{ maxWidth: '100%' }}>
      <EventPlanView
        event={event({ youAreGoing: going, going: going ? 4 : 3 })}
        nowMs={NOW}
        channelName="General"
        maybe={maybe}
        onToggleRsvp={() => setGoing((value) => !value)}
        onSetMaybe={setMaybe}
        onOpenDetails={() => {}}
      />
    </div>
  );
}

function EventStates() {
  return (
    <>
      <Cell label="Plan a night (the draft: Post it, Edit)" id="event-draft">
        <EventCard weekday="Fri" day="9" title="Game night" meta="Friday at 9:00 PM · in General">
          <EventButton primary>Post it</EventButton>
          <EventButton>Edit</EventButton>
        </EventCard>
      </Cell>
      <Cell label="Upcoming, press I'm in or Maybe" id="event-upcoming">
        <InteractiveEvent />
      </Cell>
      <Cell label="You're in" id="event-going">
        <EventPlanView event={event({ youAreGoing: true })} nowMs={NOW} channelName="General" maybe={false} onToggleRsvp={() => {}} onSetMaybe={() => {}} />
      </Cell>
      <Cell label="Maybe (yours, on this device)" id="event-maybe">
        <EventPlanView event={event()} nowMs={NOW} channelName="General" maybe onToggleRsvp={() => {}} onSetMaybe={() => {}} />
      </Cell>
      <Cell label="Happening now" id="event-live">
        <EventPlanView
          event={event({ startsAt: at(5, 20), endsAt: at(5, 23), going: 7 })}
          nowMs={NOW}
          channelName="Lounge"
          maybe={false}
          onToggleRsvp={() => {}}
          onSetMaybe={() => {}}
        />
      </Cell>
      <Cell label="Tonight, a long name, no channel" id="event-long">
        <EventPlanView
          event={event({ name: 'Thermal test: driver v3, the long one, with everyone who can make it', startsAt: at(5, 23), channelId: null, location: 'Brendan’s garage', going: 0 })}
          nowMs={NOW}
          maybe={false}
          onToggleRsvp={() => {}}
          onSetMaybe={() => {}}
        />
      </Cell>
      <Cell label="Over" id="event-over">
        <EventPlanView
          event={event({ startsAt: at(3, 21), endsAt: at(3, 23), youAreGoing: true })}
          nowMs={NOW}
          channelName="General"
          maybe={false}
          onToggleRsvp={() => {}}
          onSetMaybe={() => {}}
        />
      </Cell>
      <Cell label="Canceled" id="event-canceled">
        <EventPlanView event={event({ status: 4 })} nowMs={NOW} channelName="General" maybe={false} onToggleRsvp={() => {}} onSetMaybe={() => {}} />
      </Cell>
      <Cell label="Loading, gone, could not ask" id="event-unavailable">
        <EventUnavailable status="loading" error={null} />
        <EventUnavailable status="missing" error={null} />
        <EventUnavailable status="error" error="offline" />
      </Cell>
      <Cell label="Plan card with faces (Home and Overview still draw it)" id="plan-slots">
        <PlanCard
          title="Haz 5 run"
          meta="Tonight at 9:30 PM in Lounge"
          action={<PlanAction taken={false} onToggle={() => {}} />}
          slots={[
            { key: 'a', name: 'Brendan', detail: 'Host', face: { userId: '1003' } },
            { key: 'b', name: 'You', you: true, face: { userId: '1006', name: 'Sean' } },
            { key: 'c', name: 'Your spot', open: true },
          ]}
        />
      </Cell>
    </>
  );
}

// ---- Polls ------------------------------------------------------------------

const option = (id: string, text: string, vote_count: number, voted = false, position = Number(id.slice(1))): PollOption => ({
  id,
  text,
  emoji: null,
  position,
  vote_count,
  voted,
});

const poll = (over: Partial<Poll> = {}): Poll => ({
  id: 'p1',
  message_id: 'm1',
  channel_id: 'c1',
  question: 'Late one after the run?',
  allow_multiselect: false,
  expires_at: null,
  created_at: '2026-10-05T20:35:00Z',
  total_votes: 12,
  options: [option('o0', 'Count me in', 6, true), option('o1', 'Maybe one round', 4), option('o2', 'Bed', 2)],
  ...over,
});

function InteractivePoll() {
  const [current, setCurrent] = useState(poll({ total_votes: 12, options: [option('o0', 'Count me in', 6), option('o1', 'Maybe one round', 4), option('o2', 'Bed', 2)] }));
  const vote = (picked: PollOption) =>
    setCurrent((before) => {
      const options = before.options.map((entry) => {
        if (entry.id === picked.id) return { ...entry, voted: !entry.voted, vote_count: entry.vote_count + (entry.voted ? -1 : 1) };
        if (!before.allow_multiselect && entry.voted) return { ...entry, voted: false, vote_count: entry.vote_count - 1 };
        return entry;
      });
      return { ...before, options, total_votes: options.reduce((sum, entry) => sum + entry.vote_count, 0) };
    });
  return (
    <div data-testid="gallery-poll" style={{ maxWidth: '100%' }}>
      <PollCard poll={current} canVote nowMs={NOW} onVote={vote} />
    </div>
  );
}

function PollStates() {
  const noop = () => {};
  return (
    <>
      <Cell label="Press an option to vote" id="poll-interactive">
        <InteractivePoll />
      </Cell>
      <Cell label="Your vote, ends Friday" id="poll-voted">
        <PollCard poll={poll({ expires_at: at(9, 21).toISOString() })} canVote nowMs={NOW} onVote={noop} />
      </Cell>
      <Cell label="Pick any, nobody has voted" id="poll-empty">
        <PollCard
          poll={poll({ allow_multiselect: true, total_votes: 0, options: [option('o0', 'Friday', 0), option('o1', 'Saturday', 0), option('o2', 'Sunday afternoon, if the weather holds', 0)] })}
          canVote
          nowMs={NOW}
          onVote={noop}
        />
      </Cell>
      <Cell label="Closed" id="poll-closed">
        <PollCard poll={poll({ expires_at: at(4, 21).toISOString() })} canVote nowMs={NOW} onVote={noop} />
      </Cell>
      <Cell label="No permission to vote" id="poll-locked">
        <PollCard poll={poll()} canVote={false} nowMs={NOW} onVote={noop} />
      </Cell>
    </>
  );
}

// ---- Files and media -------------------------------------------------------------

const resolveSame = async (url: string) => url;

function FileStates() {
  return (
    <>
      <Cell label="A file" id="file-generic">
        <FilePreview url="/ix-gallery/Q3-roadmap.pdf" filename="Q3-roadmap.pdf" mimeType="application/pdf" size={2_411_724} resolveObjectUrl={resolveSame} />
      </Cell>
      <Cell label="A file with a long name" id="file-long">
        <FilePreview
          url="/ix-gallery/long.zip"
          filename="game-night-clips-final-final-v3-do-not-delete-this-one.zip"
          mimeType="application/zip"
          size={88_104_000}
          resolveObjectUrl={resolveSame}
        />
      </Cell>
      <Cell label="A picture (opens the viewer)" id="file-image">
        <FilePreview url="/ix-gallery/ridge.png" filename="ridge.png" mimeType="image/png" size={61_440} resolveObjectUrl={resolveSame} />
      </Cell>
      <Cell label="A sound" id="file-audio">
        <FilePreview url="/ix-gallery/take-3.ogg" filename="take-3.ogg" mimeType="audio/ogg" size={1_204_000} resolveObjectUrl={resolveSame} />
      </Cell>
      <Cell label="A blocked link, and a failure" id="file-notes">
        <FilePreview url="javascript:void(0)" filename="x.html" mimeType="text/html" size={1} />
        <FilePreview
          url="/ix-gallery/broken.bin"
          filename="notes.txt"
          mimeType="text/plain"
          size={9}
          resolveObjectUrl={async () => {
            throw new Error('This attachment could not be decrypted.');
          }}
        />
      </Cell>
      <Cell label="The timeline's own file (preview off)" id="file-glass">
        <div className="glass-msg">
          <GlassFile
            name="notes-from-friday.txt"
            size="97.7 KB"
            note="Preview off"
            actions={
              <>
                <button type="button" className="glass-file__action">
                  Download
                </button>
                <button type="button" className="glass-file__action">
                  Delete
                </button>
              </>
            }
          />
        </div>
      </Cell>
    </>
  );
}

// ---- Links, GitHub, feeds, scores --------------------------------------------------

const feed = (over: Partial<FeedEmbed> = {}): FeedEmbed => ({
  type: 'rich',
  url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
  title: 'Making the lantern, start to finish',
  description: 'Six weeks of evenings in one video: the frame, the glass, and the wiring that took three tries.',
  thumbnail: '/ix-gallery/video.png',
  timestamp: new Date(NOW - 2 * 3600_000).toISOString(),
  feed: { kind: 'youtube', video_id: 'aaaaaaaaaaa', source_url: 'https://www.youtube.com/channel/UCx' },
  ...over,
});

const team = (short: string, color: string | null): SportsTeam => ({
  id: short,
  abbr: short.slice(0, 3).toUpperCase(),
  name: short,
  short_name: short,
  logo: '',
  score: 0,
  record: null,
  possession: false,
  winner: false,
  color,
});

function LinkStates() {
  return (
    <>
      <Cell label="Link with a picture" id="embed-image">
        <MessageEmbedCard
          embed={{
            url: 'https://example.com/release',
            site_name: 'Example',
            title: 'Paracord 3.4 is out',
            description: 'A quieter interface, calls that open where you are, and a window that takes the color of the server you are in.',
            image: '/ix-gallery/video.png',
          }}
        />
      </Cell>
      <Cell label="Link, the source's own color" id="embed-accent">
        <MessageEmbedCard
          embed={{ url: 'https://example.com/status', site_name: 'Status', title: 'All systems normal', description: 'Last checked a minute ago.', color: 'var(--ix-amber)' }}
        />
      </Cell>
      <Cell label="A link and nothing else, and a card with no link" id="embed-plain">
        <MessageEmbedCard embed={{ url: 'https://example.com/a/very/long/path/that/keeps/going/and/going/index.html' }} />
        <MessageEmbedCard embed={{ title: 'Build 42', description: 'passed in 41s' }} />
      </Cell>
      <Cell label="GitHub: a pull request, a push, a deleted branch" id="github">
        <GitHubEventEmbed content="**alice** opened PR [#42](https://github.com/acme/app/pull/42) in **acme/app**" />
        <GitHubEventEmbed content="**alice** pushed 3 commits to `main` in **acme/app**" />
        <GitHubEventEmbed content="**alice** deleted branch `old-ui` in **acme/app**" />
      </Cell>
      <Cell label="Feed: a video" id="feed-video">
        <FeedPostCard embed={feed()} />
      </Cell>
      <Cell label="Feed: a post with a picture, and with an action" id="feed-post">
        <FeedPostCard
          embed={feed({
            feed: { kind: 'rss' },
            url: 'https://blog.example/post',
            title: 'What we learned shipping a window that changes color',
            thumbnail: '/ix-gallery/thumb.png',
          })}
          actions={<EventButton>Watch together</EventButton>}
        />
      </Cell>
      <Cell label="Feed: a poster, and the overflow line" id="feed-poster">
        <FeedPostCard embed={feed({ feed: { kind: 'jellyfin' }, url: 'https://media.home/item/9', title: 'The Long Walk Home', description: 'Added to Movies.', thumbnail: '/ix-gallery/poster.png' })} />
        <FeedPostCard
          embed={feed({ title: 'and 7 more from Lantern Journal', url: 'https://blog.example/', thumbnail: undefined, feed: { kind: 'rss', more: 7 } })}
        />
      </Cell>
      <Cell label="Sports: a score, with a team color and without" id="score">
        <>
          <ScoreUpdateCard
            update={{ label: 'Touchdown', leadName: 'Chiefs', leadScore: '14', otherName: 'Colts', otherScore: '7', clock: '8:41 2nd', play: 'K.Walker 4 yd run', overtime: false }}
            lead={team('Chiefs', 'e31837')}
            other={team('Colts', '002c5f')}
            href="/app/guilds/g1/sports/football/nfl/401872945"
          />
          <ScoreUpdateCard
            update={{ label: 'Final', leadName: 'Cubs', leadScore: '3', otherName: 'Brewers', otherScore: '2', clock: null, play: null, overtime: true }}
            lead={team('Cubs', null)}
            other={team('Brewers', null)}
            href={null}
          />
        </>
      </Cell>
    </>
  );
}

// ---- Code, ephemeral, bot components, chips ----------------------------------------------

const SNIPPET = `export function paletteHue(id: string): number {
  // the last nine digits, then one of eleven hues
  const n = Number(id.slice(-9)) % PALETTE_HUES.length;
  return PALETTE_HUES[n] ?? 210;
}`;

const row = (components: Component[]): Component => ({ type: ComponentType.ActionRow, components });
const button = (custom_id: string, label: string, style: number, extra: Partial<Component> = {}): Component => ({
  type: ComponentType.Button,
  custom_id,
  label,
  style,
  ...extra,
});

function BotStates() {
  return (
    <>
      <Cell label="One primary: it is cream" id="bot-one-primary">
        <MessageComponents
          messageId="m1"
          channelId="c1"
          components={[
            row([
              button('approve', 'Approve', ButtonStyle.Primary),
              button('later', 'Later', ButtonStyle.Secondary),
              button('reject', 'Reject', ButtonStyle.Danger),
              button('docs', 'Open docs', ButtonStyle.Link, { url: 'https://example.com/docs' }),
              button('off', 'Disabled', ButtonStyle.Secondary, { disabled: true }),
            ]),
          ]}
        />
      </Cell>
      <Cell label="Two primaries: neither is cream; success is no second color" id="bot-two-primary">
        <MessageComponents
          messageId="m2"
          channelId="c1"
          components={[
            row([button('a', 'Ship it', ButtonStyle.Primary), button('b', 'Hold', ButtonStyle.Primary), button('c', 'Done', ButtonStyle.Success)]),
          ]}
        />
      </Cell>
      <Cell label="Selects: pick one (press to open), pick several" id="bot-selects">
        <MessageComponents
          messageId="m3"
          channelId="c1"
          components={[
            row([
              {
                type: ComponentType.StringSelect,
                custom_id: 'priority',
                placeholder: 'Choose a priority',
                options: [
                  { label: 'Low', value: 'low', description: 'Whenever' },
                  { label: 'High', value: 'high', description: 'Today' },
                  { label: 'Urgent', value: 'urgent', default: true },
                ],
              },
            ]),
            row([
              {
                type: ComponentType.StringSelect,
                custom_id: 'days',
                placeholder: 'Pick the days',
                min_values: 1,
                max_values: 3,
                options: [
                  { label: 'Friday', value: 'fri', default: true },
                  { label: 'Saturday', value: 'sat' },
                  { label: 'Sunday', value: 'sun' },
                ],
              },
            ]),
          ]}
        />
      </Cell>
    </>
  );
}

function ChipsAndText() {
  const sentence = (own: boolean) => (
    <Bubble own={own}>
      {own ? 'See you in ' : 'Come to '}
      <ChannelChipView name="Lounge" inside={3} onOpen={() => {}} />
      {' after '}
      <EventChipView name="Movie night" aside="Fri 9 PM" />
      {', or find us in '}
      <ChannelChipView name="general" onOpen={() => {}} />
      {'. '}
      <span className="glass-mention">@Vincent</span>
      {' and '}
      <span className="glass-mention glass-mention-self">@Sean</span>
      {' are in.'}
    </Bubble>
  );
  return (
    <>
      <Cell label="Chips and mentions in a bubble" id="chips-others">
        {sentence(false)}
      </Cell>
      <Cell label="The same in your own bubble" id="chips-own">
        {sentence(true)}
      </Cell>
      <Cell label="A channel that is gone, an event that is gone" id="chips-missing">
        <Bubble>
          <ChannelChipView name="a channel" missing />{' '}
          <span className="ix-inline ix-inline--channel" data-missing>
            an event that is gone
          </span>
        </Bubble>
      </Cell>
      <Cell label="Ephemeral" id="ephemeral">
        <Bubble>
          <EphemeralMessage>
            <span>Reminder set for 9:00 PM.</span>
          </EphemeralMessage>
        </Bubble>
        <Bubble own>
          <EphemeralMessage>
            <span>Only I can see my own.</span>
          </EphemeralMessage>
        </Bubble>
      </Cell>
      <Cell label="Code" id="code">
        <div style={{ width: 'min(520px, 100%)' }}>
          <Bubble>
            Try this:
            <CodeBlock code={SNIPPET} language="typescript" />
          </Bubble>
        </div>
      </Cell>
      <Cell label="Code: no language, one long line" id="code-long">
        <div style={{ width: 'min(520px, 100%)' }}>
          <CodeBlock code={'cargo build --release --bin paracord-server -- --config config/paracord.toml --log-level debug --no-gui'} />
        </div>
      </Cell>
    </>
  );
}

// ---- The page ----------------------------------------------------------------------

export default function IxCardsGallery() {
  const params = new URLSearchParams(window.location.search);
  const hue = Number(params.get('hue') ?? 350);
  const theme = params.get('theme');
  const style = { ...stage, '--ix-hue': Number.isFinite(hue) ? hue : 350 } as CSSProperties;
  return (
    <div className="ix-hue-main" data-theme={theme ?? undefined} style={style} data-testid="ix-cards-gallery">
      <h1 style={{ margin: 0, fontSize: 28, fontWeight: 700, letterSpacing: '-0.03em' }}>Conversation cards</h1>
      <p style={{ margin: '4px 0 0', fontSize: 14, color: 'var(--ix-ink-3)' }}>
        The Index card family in every state. The clock is Monday 5 October, 9:12 PM; the hue is {hue}.
      </p>

      <Section id="events" title="Event card" note="the prototype's .event: tile, title, line, actions">
        <EventStates />
      </Section>
      <Section id="polls" title="Poll card" note="the bar behind an option is its share (scaleX)">
        <PollStates />
      </Section>
      <Section id="files" title="Files and media">
        <FileStates />
      </Section>
      <Section id="links" title="Links, GitHub, feeds and scores">
        <LinkStates />
      </Section>
      <Section id="text" title="Chips, ephemeral and code">
        <ChipsAndText />
      </Section>
      <Section id="bots" title="Bot components">
        <BotStates />
      </Section>
      <Section id="wired" title="Wired to the stores" note="the real components; the e2e spec answers their API calls">
        <Cell label="EventPlanCard: gal-guild / gal-event" id="wired-event">
          <EventPlanCard guildId="gal-guild" eventId="gal-event" />
        </Cell>
        <Cell label="PollMessageCard: gal-channel / gal-poll" id="wired-poll">
          <PollMessageCard
            channelId="gal-channel"
            canVote
            poll={poll({ id: 'gal-poll', channel_id: 'gal-channel', total_votes: 4, options: [option('o0', 'Yes', 3), option('o1', 'No', 1)] })}
          />
        </Cell>
      </Section>
    </div>
  );
}
