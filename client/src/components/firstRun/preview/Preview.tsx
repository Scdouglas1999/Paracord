import type { CSSProperties, ReactNode } from 'react';

import { Avatar } from '../../ix/identity/Avatar';
import { ServerMark } from '../../ix/identity/ServerMark';
import { IxGlyph } from '../../ix/glyphs';
import { searchShortcut } from '../../ix/sidebar/SearchField';
import { cn } from '../../../lib/utils';
import { FrGlyph } from '../primitives';
import {
  HOST_FIRST_STEPS,
  HOST_TEXT_CHANNELS,
  HOST_VOICE_CHANNELS,
  hostStatusLine,
  plural,
  type HostPreviewModel,
  type JoinPreviewModel,
  type PreviewModel,
} from './model';
import './preview.css';

/** A server mark needs an id for its default hue; the preview always passes the hue. */
const PREVIEW_GUILD_ID = '0';
/** The prototype's dock avatar hue for the person being made. */
const ME_HUE = 38;

/**
 * The app as it will look, at full window size (the first run scales it down;
 * the Done step grows it back, spec §1.13). Index's own marks and sidebar
 * recipes (`ix-sq`, `ix-av`, `ix-ch`, `ix-rm`, `ix-search`, the dock) fed by a
 * static model. It is a picture: inert, hidden from assistive technology.
 */
export function Preview({ model, badge = true, className, style }: { model: PreviewModel; badge?: boolean; className?: string; style?: CSSProperties }) {
  const join = model.kind === 'join' ? model : null;
  return (
    <div className={cn('fr-pv', className)} style={style} aria-hidden="true" inert data-kind={model.kind} data-testid="fr-preview">
      {badge && (
        <div className="fr-pre__badge">
          <FrGlyph name="eye" size={15} />
          Preview
        </div>
      )}
      <div className="fr-app" data-dim={join && !join.server ? '' : undefined} data-blur={join?.server ? '' : undefined}>
        {model.kind === 'host' ? <HostSide model={model} /> : <JoinSide model={model} />}
        <main className="fr-app__main ix-hue-main">{model.kind === 'host' ? <HostMain model={model} /> : <JoinMain model={model} />}</main>
      </div>
    </div>
  );
}

function SideFrame({ header, children, mark, me }: { header: ReactNode; children: ReactNode; mark: ReactNode; me: string | null }) {
  return (
    <aside className="fr-app__side ix-hue-side">
      <div className="fr-app__pane">
        {header}
        <div className="ix-search fr-app__search">
          <span className="ix-search__text">Search</span>
          <kbd>{searchShortcut()}</kbd>
        </div>
        {children}
      </div>
      <div className="ix-dock fr-app__dock">
        <span className="ix-dock__item" data-current="">
          <span className="ix-dock__mark">{mark}</span>
        </span>
        <span className="ix-dock__sep" />
        <span className="ix-dock__plus fr-app__plus">
          <IxGlyph name="plus" size={16} />
        </span>
        <span className="fr-app__spacer" />
        <span className="fr-app__me" data-hidden={me ? undefined : ''}>
          <Avatar userId="me" name={me || 'S'} hue={ME_HUE} size={34} />
        </span>
        <span className="fr-app__ind" />
      </div>
    </aside>
  );
}

function HostSide({ model }: { model: HostPreviewModel }) {
  const name = model.name.trim() || 'Your server';
  const markName = model.name.trim() || '?';
  return (
    <SideFrame
      me={model.me}
      mark={<ServerMark guildId={PREVIEW_GUILD_ID} name={markName} hue={model.hue} size={34} />}
      header={
        <div className="ix-sh fr-app__sh">
          <ServerMark guildId={PREVIEW_GUILD_ID} name={markName} hue={model.hue} size={40} />
          <div className="fr-app__shtext">
            <b>{name}</b>
            <small>
              <i data-on={model.status === 'online' ? '' : undefined} />
              {hostStatusLine(model.status)}
            </small>
          </div>
        </div>
      }
    >
      <div className="ix-section-label fr-app__label">Channels</div>
      {HOST_TEXT_CHANNELS.map((channel, i) => (
        <div key={channel.name} className={cn('ix-ch fr-app__ch', i === 0 && 'ix-hue-selected')} aria-current={i === 0 ? 'page' : undefined}>
          <span className="ix-ch__name">
            <span className="ix-ch__name-text">{channel.name}</span>
          </span>
          <span className="ix-ch__line">
            <span className="ix-ch__line-text">{channel.topic}</span>
          </span>
        </div>
      ))}
      <div className="ix-section-label fr-app__label">Voice channels</div>
      {HOST_VOICE_CHANNELS.map((room) => (
        <div key={room} className="ix-rm fr-app__rm">
          <IxGlyph name="speaker" size={16} />
          <span className="ix-rm__name">{room}</span>
        </div>
      ))}
    </SideFrame>
  );
}

function HostMain({ model }: { model: HostPreviewModel }) {
  const name = model.name.trim() || 'your server';
  return (
    <>
      <div className="fr-app__title">
        general
        <small>The first channel in {name}</small>
      </div>
      <div className="fr-app__welcome">
        <h3>Welcome to {name}</h3>
        <p>It&rsquo;s ready. Here are a few good first steps.</p>
        <div className="fr-app__cards">
          {HOST_FIRST_STEPS.map((card) => (
            <div key={card.title} className="fr-app__card">
              <FrGlyph name={card.glyph} size={20} />
              <b>{card.title}</b>
              <span>{card.line}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="fr-app__compose">Message general</div>
    </>
  );
}

/** Placeholder rows: a server's channels are not shown to someone who has not joined (§1.9). */
function Bars({ count, kind }: { count: number; kind: 'ch' | 'rm' }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={cn('fr-app__ghost', `fr-app__ghost--${kind}`)} data-i={i}>
          <i />
          {kind === 'ch' && <i />}
        </div>
      ))}
    </>
  );
}

function JoinSide({ model }: { model: JoinPreviewModel }) {
  const server = model.server;
  const name = server?.name ?? 'A friend’s server';
  const mark = <ServerMark guildId={PREVIEW_GUILD_ID} name={server?.name ?? '?'} hue={server?.hue ?? 200} size={34} />;
  return (
    <SideFrame
      me={model.me}
      mark={mark}
      header={
        <div className="ix-sh fr-app__sh">
          <ServerMark guildId={PREVIEW_GUILD_ID} name={server?.name ?? '?'} hue={server?.hue ?? 200} size={40} />
          <div className="fr-app__shtext">
            <b>{name}</b>
            <small>
              <i data-on={server ? '' : undefined} />
              {server ? (server.online != null ? `${server.online.toLocaleString('en-US')} online` : 'Signing in') : 'Paste an invite'}
            </small>
          </div>
        </div>
      }
    >
      <div className="ix-section-label fr-app__label">Channels</div>
      <Bars count={3} kind="ch" />
      <div className="ix-section-label fr-app__label">Voice channels</div>
      <Bars count={2} kind="rm" />
    </SideFrame>
  );
}

function JoinMain({ model }: { model: JoinPreviewModel }) {
  const server = model.server;
  return (
    <>
      <div className="fr-app__title">
        <span className="fr-app__titlebar" />
        <small>{server ? (server.members != null ? `${server.name} · ${plural(server.members, 'member')}` : server.name) : ' '}</small>
      </div>
      <div className="fr-app__msgs">
        {[0, 1, 2].map((i) => (
          <div key={i} className="fr-app__msg" data-i={i}>
            <i className="fr-app__msgav" />
            <i />
            <i />
          </div>
        ))}
      </div>
      <div className="fr-app__compose">
        <span className="fr-app__composebar" />
      </div>
    </>
  );
}
