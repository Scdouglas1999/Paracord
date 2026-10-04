import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { PALETTE_HUES, PEOPLE_HUE } from '../../../lib/identityHue';
import { Avatar, AvatarStack, PresenceDot, ServerMark } from '../identity';
import { IX_GLYPH_NAMES, IxGlyph } from '../glyphs';
import { Control, CreamButton, Hairline, SectionLabel, ToolChip, WideControl } from './index';

/**
 * The Index section of `/design-tokens` (dev only): the tokens with their
 * resolved values, every palette hue as a window tint, avatars and server marks
 * at every size in use, presence, the primitives and the glyph set. It is drawn
 * on Index's own ground, in the default theme and in High contrast, so a change
 * to a token or a recipe is seen on the surfaces it is for. Kept beside the
 * primitives it shows.
 */

/** A 24px picture, to show that an uploaded image wins over a monogram. */
const PICTURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAsElEQVR42u3MzQoBcRTG4ffqrF2Jj5CRj5C9RCMRaWoKNYmaRM3CwsLCwgW4ECuLKZ3O/8RZnKzUszvv+eGe5EzgdsqbwPVQMIFLXDSB876k9Hz4FLsi2ZY1WCVFBzhGFQ0xRAeIN1UNMUQH2K08DTFEB4jCmoYYogOsg7oSq7ArwmXDBIJ50wQWs5YJTCdtExj7HRMYjrqfZbysy50hPfQHPUb8d733UD589Q/9MPQC+xi05MCkbykAAAAASUVORK5CYII=';

const GROUND_TOKENS = ['--ix-ground', '--ix-main', '--ix-side-end', '--ix-bubble', '--ix-card', '--ix-call'] as const;
const INK_TOKENS = ['--ix-ink', '--ix-ink-2', '--ix-ink-3'] as const;
const FILL_TOKENS = ['--ix-line', '--ix-fill', '--ix-fill-2', '--ix-fill-ctl', '--ix-fill-ctl-hover', '--ix-danger-fill'] as const;
const ACTION_TOKENS = ['--ix-cream', '--ix-cream-hover', '--ix-cream-press', '--ix-amber', '--ix-danger-ink', '--ix-cream-ink'] as const;

const PERSON_SIZES = [24, 30, 32, 34, 38, 40, 76, 88] as const;

const PEOPLE = [
  { userId: '1001', name: 'Jeremy' },
  { userId: '1002', name: 'Vincent' },
  { userId: '1003', name: 'Brendan' },
  { userId: '1004', name: 'Nick' },
  { userId: '1005', name: 'Maya' },
  { userId: '1006', name: 'You' },
] as const;

function Block({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '4px 12px' }}>
        <h3 style={{ margin: 0, fontSize: 13.5, fontWeight: 600, color: 'var(--ix-ink-2)' }}>{title}</h3>
        {note && <span style={{ fontSize: 12.5, color: 'var(--ix-ink-3)' }}>{note}</span>}
      </div>
      {children}
    </div>
  );
}

const row: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14 };

function TokenSwatch({ name, kind, values }: { name: string; kind: 'fill' | 'ink'; values: Record<string, string> }) {
  return (
    <div style={{ display: 'flex', width: 168, flexDirection: 'column', gap: 6 }}>
      <div
        style={{
          height: 48,
          borderRadius: 12,
          display: 'grid',
          placeItems: 'center',
          background: kind === 'ink' ? 'var(--ix-card)' : `var(${name})`,
          color: kind === 'ink' ? `var(${name})` : 'var(--ix-ink-3)',
          boxShadow: 'inset 0 0 0 1px var(--ix-line)',
          fontSize: 13.5,
          fontWeight: 600,
        }}
      >
        {kind === 'ink' ? 'The quick brown fox' : ''}
      </div>
      <code style={{ fontSize: 12, color: 'var(--ix-ink-2)' }}>{name}</code>
      <code style={{ fontSize: 11.5, color: 'var(--ix-ink-3)' }}>{values[name] || ' '}</code>
    </div>
  );
}

function Tokens() {
  const scope = useRef<HTMLDivElement>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!scope.current) return;
    const style = getComputedStyle(scope.current);
    const next: Record<string, string> = {};
    for (const name of [...GROUND_TOKENS, ...INK_TOKENS, ...FILL_TOKENS, ...ACTION_TOKENS]) next[name] = style.getPropertyValue(name).trim();
    setValues(next);
  }, []);
  return (
    <div ref={scope} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={row}>
        {GROUND_TOKENS.map((name) => (
          <TokenSwatch key={name} name={name} kind="fill" values={values} />
        ))}
      </div>
      <div style={row}>
        {INK_TOKENS.map((name) => (
          <TokenSwatch key={name} name={name} kind="ink" values={values} />
        ))}
        {FILL_TOKENS.map((name) => (
          <TokenSwatch key={name} name={name} kind="fill" values={values} />
        ))}
      </div>
      <div style={row}>
        {ACTION_TOKENS.map((name) => (
          <TokenSwatch key={name} name={name} kind="fill" values={values} />
        ))}
      </div>
    </div>
  );
}

/** One palette hue as a window: the sidebar's ground, a selected row, the mark and a face. */
function HueCard({ hue, label }: { hue: number; label?: string }) {
  const vars = { '--ix-hue': hue } as CSSProperties;
  return (
    <div style={{ ...vars, width: 168, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div
        className="ix-hue-side"
        style={{ borderRadius: 14, padding: 10, display: 'flex', flexDirection: 'column', gap: 8, boxShadow: 'inset 0 0 0 1px var(--ix-line)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ServerMark guildId="1" name="Fuel" hue={hue} size={34} />
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <b style={{ fontSize: 14, color: 'var(--ix-ink)' }}>Fuel</b>
            <small style={{ fontSize: 11.5, color: 'var(--ix-ink-3)' }}>2 here now</small>
          </div>
        </div>
        <div className="ix-hue-selected" style={{ borderRadius: 12, padding: '7px 10px', display: 'flex', flexDirection: 'column', gap: 1 }}>
          <b style={{ fontSize: 14, color: 'var(--ix-ink)' }}>general</b>
          <span style={{ fontSize: 12.5, color: 'var(--ix-ink-3)' }}>Nick: yep, bringing the projector</span>
        </div>
      </div>
      <div className="ix-hue-main" style={{ borderRadius: 14, height: 28, boxShadow: 'inset 0 0 0 1px var(--ix-line)' }} />
      <code style={{ fontSize: 12, color: 'var(--ix-ink-2)' }}>
        {hue}
        {label ? ` · ${label}` : ''}
      </code>
    </div>
  );
}

function Identity({ ring }: { ring: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <Block title="People" note="paletteHue(id), one letter, flat tonal; 44% letter, 36% from 88px">
        <div style={row}>
          {PERSON_SIZES.map((size, i) => (
            <div key={size} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
              <Avatar userId={PEOPLE[i % PEOPLE.length].userId} name={PEOPLE[i % PEOPLE.length].name} size={size} />
              <code style={{ fontSize: 11.5, color: 'var(--ix-ink-3)' }}>{size}</code>
            </div>
          ))}
        </div>
      </Block>
      <Block title="Servers" note="rounded square, 28%, a quiet diagonal, a condensed letter">
        <div style={row}>
          {PERSON_SIZES.map((size, i) => (
            <div key={size} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
              <ServerMark
                guildId={String(2001 + i)}
                name={['Fuel', 'Game Night', 'Basecamp', 'Late Shift'][i % 4]}
                size={size}
                hue={PALETTE_HUES[i % PALETTE_HUES.length]}
                radius={size === 76 ? 22 : undefined}
                fontSize={size === 76 ? 34 : undefined}
              />
              <code style={{ fontSize: 11.5, color: 'var(--ix-ink-3)' }}>{size}</code>
            </div>
          ))}
        </div>
      </Block>
      <Block title="Every palette hue" note="a person and a server on each of the eleven hues">
        <div style={row}>
          {PALETTE_HUES.map((hue) => (
            <div key={hue} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
              <ServerMark guildId="1" name="Fuel" hue={hue} size={40} />
              <Avatar userId="1" name="Maya" hue={hue} size={40} />
              <code style={{ fontSize: 11.5, color: 'var(--ix-ink-3)' }}>{hue}</code>
            </div>
          ))}
        </div>
      </Block>
      <Block title="An uploaded picture wins" note="the same shape and the same hairline, drawn over it">
        <div style={row}>
          <Avatar userId="1" name="Jeremy" avatar={PICTURE} size={40} />
          <Avatar userId="1" name="Jeremy" avatar={PICTURE} size={88} />
          <ServerMark guildId="1" name="Fuel" icon={PICTURE} size={40} />
          <ServerMark guildId="1" name="Fuel" icon={PICTURE} size={88} />
        </div>
      </Block>
      <Block title="Presence" note="ink, ink-3, a hollow ring; offline draws nothing; presence is never a color">
        <div style={{ ...row, gap: 22, '--ix-ring': ring } as CSSProperties}>
          {(['online', 'idle', 'dnd', 'offline'] as const).map((status, i) => (
            <div key={status} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
              <Avatar userId={PEOPLE[i].userId} name={PEOPLE[i].name} size={38} presence={status} />
              <code style={{ fontSize: 11.5, color: 'var(--ix-ink-3)' }}>{status}</code>
            </div>
          ))}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
              <PresenceDot status="online" inline />
              <PresenceDot status="idle" inline />
              <PresenceDot status="dnd" inline />
            </span>
            <code style={{ fontSize: 11.5, color: 'var(--ix-ink-3)' }}>inline</code>
          </div>
        </div>
      </Block>
      <Block title="Stacks" note="−7px overlap, a 2px ring in the surface behind">
        <div style={row}>
          <AvatarStack people={PEOPLE} size={24} ring={ring} />
          <AvatarStack people={PEOPLE.slice(0, 3)} size={16} overlap={5} ring={ring} />
        </div>
      </Block>
    </div>
  );
}

function Primitives() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <Block title="Cream button" note="one per surface: Join, Watch, Post it, Send with text">
        <div style={row}>
          <CreamButton>Join</CreamButton>
          <CreamButton>Watch Vincent</CreamButton>
          <CreamButton size="sm">Post it</CreamButton>
          <CreamButton disabled>Disabled</CreamButton>
        </div>
      </Block>
      <Block title="A call card's actions" note="controls, a wide control, Leave in the one danger color">
        <div style={{ ...row, width: 280, gap: 6, flexWrap: 'nowrap' }}>
          <Control label="Mute">
            <IxGlyph name="mic" size={16} />
          </Control>
          <Control label="Camera">
            <IxGlyph name="camera" size={16} />
          </Control>
          <Control label="Share screen">
            <IxGlyph name="screen" size={16} />
          </Control>
          <WideControl>Open call</WideControl>
          <Control label="Leave" tone="danger">
            <IxGlyph name="x" size={16} />
          </Control>
        </div>
        <div style={{ ...row, width: 280, gap: 6, flexWrap: 'nowrap' }}>
          <Control label="Listen" pressed>
            <IxGlyph name="listen" size={16} />
          </Control>
          <WideControl>Join</WideControl>
          <CreamButton grow>Watch Vincent</CreamButton>
        </div>
      </Block>
      <Block title="Tool chips" note="under the open message box">
        <div style={row}>
          <ToolChip>
            <IxGlyph name="attach" size={14} />
            Attach
          </ToolChip>
          <ToolChip>GIF</ToolChip>
          <ToolChip>
            <IxGlyph name="poll" size={14} />
            Poll
          </ToolChip>
          <ToolChip>
            <IxGlyph name="event" size={14} />
            Event
          </ToolChip>
        </div>
      </Block>
      <Block title="Section label and hairline">
        <div style={{ width: 280 }}>
          <SectionLabel count="2">Channels</SectionLabel>
          <Hairline />
          <SectionLabel>Voice</SectionLabel>
        </div>
        <div style={{ ...row, gap: 10 }}>
          <span style={{ color: 'var(--ix-ink-3)', fontSize: 12.5 }}>vertical, 24px</span>
          <Hairline orientation="vertical" />
          <span style={{ color: 'var(--ix-ink-3)', fontSize: 12.5 }}>dock separator</span>
        </div>
      </Block>
      <Block title="Hue-derived classes" note="selected row, action-card tile, event weekday, message box halo">
        <div style={{ ...row, '--ix-hue': PALETTE_HUES[5] } as CSSProperties}>
          <span className="ix-hue-selected" style={{ borderRadius: 12, padding: '8px 14px', fontSize: 14.5, fontWeight: 600, color: 'var(--ix-ink)' }}>
            general
          </span>
          <span className="ix-hue-tile" style={{ width: 38, height: 38, borderRadius: 12, display: 'grid', placeItems: 'center' }}>
            <IxGlyph name="plan" size={18} />
          </span>
          <span className="ix-hue-weekday" style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em' }}>
            FRI
          </span>
          <span className="ix-hue-halo" style={{ borderRadius: 24, padding: '14px 30px', background: 'var(--ix-fill-field)', color: 'var(--ix-ink-3)', fontSize: 15 }}>
            Message general
          </span>
        </div>
      </Block>
    </div>
  );
}

function Glyphs() {
  return (
    <div style={{ ...row, gap: 10 }}>
      {IX_GLYPH_NAMES.map((name) => (
        <div key={name} style={{ width: 84, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, color: 'var(--ix-ink-2)' }}>
          <IxGlyph name={name} size={22} />
          <code style={{ fontSize: 11.5, color: 'var(--ix-ink-3)' }}>{name}</code>
        </div>
      ))}
    </div>
  );
}

/** A themed panel on Index's own ground. */
function Panel({ theme, label, children }: { theme: 'glass' | 'glass-contrast'; label: string; children: ReactNode }) {
  return (
    <div
      data-theme={theme}
      style={{ borderRadius: 24, padding: 24, background: 'var(--ix-main)', color: 'var(--ix-ink)', display: 'flex', flexDirection: 'column', gap: 22, minWidth: 0, flex: '1 1 480px' }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ix-ink-3)' }}>{label}</div>
      {children}
    </div>
  );
}

/** The Index section of `/design-tokens`. */
export function IndexShowcase() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <Panel theme="glass" label="Tokens (docs/index-spec.md §2.1)">
        <Tokens />
      </Panel>
      <Panel theme="glass" label="Window hue (§2.2): the sidebar's ground, the selected row and the glow, at each palette hue and at People's">
        <div style={row}>
          {PALETTE_HUES.map((hue) => (
            <HueCard key={hue} hue={hue} />
          ))}
          <HueCard hue={PEOPLE_HUE} label="People" />
        </div>
      </Panel>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
        <Panel theme="glass" label="Identity (§2.3), default theme">
          <Identity ring="var(--ix-main)" />
        </Panel>
        <Panel theme="glass-contrast" label="Identity (§2.3), High contrast">
          <Identity ring="var(--ix-main)" />
        </Panel>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
        <Panel theme="glass" label="Primitives (§3.1), default theme">
          <Primitives />
        </Panel>
        <Panel theme="glass-contrast" label="Primitives (§3.1), High contrast">
          <Primitives />
        </Panel>
      </div>
      <Panel theme="glass" label="Glyphs (§2.6): 24 grid, stroke 1.7, round caps and joins">
        <Glyphs />
      </Panel>
    </div>
  );
}
