import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';

import { GlassButton, JoinButton } from './GlassButton';
import { GlassChip } from './Chip';
import { GLYPH_NAMES, Glyph } from './Glyph';
import { InstrumentText } from './InstrumentText';
import { Kicker } from './Kicker';
import { Pane } from './Pane';
import { Waveform } from './Waveform';

/**
 * The Glass section of `/design-tokens` (dev only). Shows the room-tinted
 * surfaces at both reference tints (docs/glass-spec.md §2.1), the ink ramp, the
 * type roles, the glyphs, the waveform and the button variants. Kept beside the
 * primitives it shows, so a change to one is seen next to the other.
 */

const SURFACE_TOKENS = ['--pane', '--bub', '--raise', '--sel', '--deep', '--solid', '--glow'] as const;

const TINTS = [
  { id: 'warm', label: 'Warm: a live stream', className: 'glass-tint-warm' },
  { id: 'cool', label: 'Cool: a banner, nothing live', className: 'glass-tint-cool' },
] as const;

/** A computed `color-mix()` reads back as `rgb()` or `color(srgb …)`; show hex. */
function readableColor(computed: string): string {
  const srgb = computed.match(/^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/);
  const rgb = computed.match(/^rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)(?:[,/ ]+([\d.]+))?\)$/);
  let channels: number[] | null = null;
  let alpha = 1;
  if (srgb) {
    channels = [srgb[1], srgb[2], srgb[3]].map((n) => Math.round(Number(n) * 255));
    alpha = srgb[4] != null ? Number(srgb[4]) : 1;
  } else if (rgb) {
    channels = [rgb[1], rgb[2], rgb[3]].map(Number);
    alpha = rgb[4] != null ? Number(rgb[4]) : 1;
  }
  if (!channels) return computed;
  const hex = `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  return alpha < 1 ? `${hex} / ${alpha.toFixed(2)}` : hex;
}

function SurfaceSwatch({ token }: { token: (typeof SURFACE_TOKENS)[number] }) {
  const probe = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState('');
  useEffect(() => {
    if (probe.current) setValue(readableColor(getComputedStyle(probe.current).backgroundColor));
  }, []);
  return (
    <div className="flex w-[7.5rem] flex-col gap-1.5">
      <div
        ref={probe}
        className="h-14 w-full"
        style={{
          background: `var(${token})`,
          borderRadius: 'var(--r-row)',
          // The translucent ones would vanish on the pane; a hairline frames them.
          boxShadow: 'inset 0 0 0 1px var(--glass-hair)',
        }}
      />
      <code className="text-[12px]" style={{ color: 'var(--ink-2)' }}>
        {token}
      </code>
      <code className="text-[12px]" style={{ color: 'var(--ink-3)' }}>
        {value || ' '}
      </code>
    </div>
  );
}

function ConversationSample() {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2 pl-10">
        <span className="glass-secondary" style={{ color: 'var(--ink-1)', fontWeight: 600 }}>
          Brendan
        </span>
        <InstrumentText className="text-[13px]" style={{ color: 'var(--ink-3)' }}>
          9:02 PM
        </InstrumentText>
      </div>
      <div className="flex items-end gap-2">
        <span
          aria-hidden="true"
          className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-full glass-badge-text"
          style={{ background: 'var(--raise)', color: 'var(--ink-2)' }}
        >
          B
        </span>
        <div
          className="glass-body"
          style={{
            background: 'var(--bub)',
            padding: '9px 14px',
            borderRadius: 'var(--r-bubble) var(--r-bubble) var(--r-bubble) var(--r-join)',
            boxShadow: 'var(--sh-content)',
          }}
        >
          okay who&rsquo;s actually on tonight? need two more for a haz 5 run
        </div>
      </div>
      <div
        className="glass-body ml-10"
        style={{
          background: 'var(--raise)',
          padding: '9px 14px',
          borderRadius: 'var(--r-bubble)',
          boxShadow: 'var(--sh-raised)',
          alignSelf: 'flex-start',
        }}
      >
        <GlassChip
          tone="mention"
          className="glass-body"
          style={{ height: 24, padding: '0 6px', borderRadius: 'var(--r-chip)', fontSize: 15, fontWeight: 600 }}
        >
          @Sean
        </GlassChip>{' '}
        is <GlassChip tone="event">Movie night Fri 9 PM</GlassChip> still on?
      </div>
      <div
        className="glass-body"
        style={{
          background: 'var(--own-bub)',
          color: 'var(--own-ink)',
          padding: '9px 14px',
          borderRadius: 'var(--r-bubble) var(--r-join) var(--r-bubble) var(--r-bubble)',
          alignSelf: 'flex-end',
        }}
      >
        home in 20. what are we playing tonight?
      </div>
    </div>
  );
}

function RoomSample({ tint }: { tint: (typeof TINTS)[number] }) {
  return (
    <div
      className={`glass-room ${tint.className} flex flex-1 basis-[34rem] flex-col gap-3 p-4`}
      style={{ background: 'var(--street)', borderRadius: 'var(--r-pane)' }}
      data-testid={`glass-room-${tint.id}`}
    >
      <p className="glass-secondary">{tint.label}</p>
      <div className="flex flex-wrap gap-3">
        {SURFACE_TOKENS.map((token) => (
          <SurfaceSwatch key={token} token={token} />
        ))}
      </div>
      <Pane glow className="flex flex-col gap-4 p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="glass-title-channel">General</div>
            <div className="glass-secondary">Haz 5 runs from 9. Bring snacks.</div>
          </div>
          <div
            className="flex items-center gap-1.5"
            style={{ background: 'var(--pill)', borderRadius: 'var(--r-capsule)', padding: 8 }}
          >
            <span className="glass-name px-2">Lounge</span>
            <Waveform />
            <GlassButton pressed tone="amber">
              <Glyph name="listen" size={17} />
              Listening
            </GlassButton>
            <GlassButton variant="text">Watch</GlassButton>
            <JoinButton>Join</JoinButton>
          </div>
        </div>
        <ConversationSample />
        <div className="flex items-center gap-2 rounded-full px-3" style={{ background: 'var(--glass-fill-quiet)', height: 52, boxShadow: 'var(--glass-edge)' }}>
          <Plus size={18} aria-hidden="true" style={{ color: 'var(--ink-3)' }} />
          <span style={{ color: 'var(--ink-placeholder)' }}>Reply to Jeremy</span>
        </div>
      </Pane>
      <div className="flex gap-3">
        <Pane tone="deep" className="flex-1 p-4">
          <Kicker>Coming up</Kicker>
          <div className="glass-name mt-2">Haz 5 run</div>
          <div className="glass-secondary">Lounge, 1 spot left</div>
        </Pane>
        <Pane tone="solid" className="flex-1 p-4">
          <Kicker tone="amber">Live 42 min</Kicker>
          <div className="glass-name mt-2">Vincent is streaming</div>
          <div className="glass-secondary">Game Night Lounge</div>
        </Pane>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <code className="text-[12px]" style={{ color: 'var(--ink-3)' }}>
      {children}
    </code>
  );
}

export function GlassShowcase() {
  const [level, setLevel] = useState(0.6);
  return (
    <div className="glass-room glass-tint-warm flex flex-col gap-8" data-testid="glass-showcase">
      <div className="flex flex-wrap gap-4">
        {TINTS.map((tint) => (
          <RoomSample key={tint.id} tint={tint} />
        ))}
      </div>

      <div className="flex flex-wrap gap-4">
        <Pane className="flex flex-1 basis-[22rem] flex-col gap-3 p-5">
          <Kicker>Ink</Kicker>
          <div className="glass-body" style={{ color: 'var(--ink-1)' }}>--ink-1 primary</div>
          <div className="glass-body" style={{ color: 'var(--ink-2)' }}>--ink-2 secondary .76</div>
          <div className="glass-body" style={{ color: 'var(--ink-3)' }}>--ink-3 tertiary .64, never lower</div>
          <div className="glass-body" style={{ color: 'var(--amber)' }}>--amber: live, talking</div>
          <div className="glass-body" style={{ color: 'var(--amber-ink)' }}>--amber-ink: amber text on dark</div>
        </Pane>

        <Pane className="flex flex-1 basis-[26rem] flex-col gap-2 p-5">
          <Kicker>Type roles</Kicker>
          <div className="glass-title-server">Game Night</div>
          <Label>server title 28 / 600, wdth 92</Label>
          <div className="glass-title-channel">General</div>
          <Label>channel and window titles 20 / 600</Label>
          <div className="glass-title-section">Coming up</div>
          <Label>section title 17 / 600</Label>
          <div className="glass-body">Body, names and buttons, 15 / 400</div>
          <div className="glass-name">Jeremy 15 / 600</div>
          <div className="glass-secondary">Secondary text, 13 / 400</div>
          <div className="flex items-center gap-3">
            <Kicker>Kicker 12 / 700</Kicker>
            <GlassChip tone="count">3</GlassChip>
            <Label>badge 11 / 700, regular cut</Label>
          </div>
          <div className="flex items-center gap-3">
            <InstrumentText className="text-[15px]">9:09 PM · LIVE 42 MIN · Fri 2</InstrumentText>
            <Label>instrument cut, wdth 82, 12px and up</Label>
          </div>
        </Pane>
      </div>

      <div className="flex flex-wrap gap-4">
        <Pane className="flex flex-1 basis-[22rem] flex-col gap-4 p-5">
          <Kicker>Glyphs</Kicker>
          <div className="flex flex-wrap items-end gap-5">
            {GLYPH_NAMES.map((name) => (
              <figure key={name} className="flex flex-col items-center gap-2">
                <Glyph name={name} size={32} />
                <Glyph name={name} size={17} />
                <figcaption>
                  <Label>{name}</Label>
                </figcaption>
              </figure>
            ))}
          </div>
        </Pane>

        <Pane className="flex flex-1 basis-[22rem] flex-col gap-4 p-5">
          <Kicker>Waveform</Kicker>
          <div className="flex items-center gap-6">
            <div className="flex flex-col items-center gap-2">
              <Waveform />
              <Label>looping</Label>
            </div>
            <div className="flex flex-col items-center gap-2">
              <Waveform level={level} />
              <Label>voice level {level.toFixed(2)}</Label>
            </div>
          </div>
          <label className="glass-secondary flex items-center gap-3">
            Voice level
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={level}
              onChange={(event) => setLevel(Number(event.target.value))}
              className="glass-focusable" style={{ accentColor: 'var(--amber)' }}
            />
          </label>
        </Pane>
      </div>

      <Pane className="flex flex-col gap-4 p-5">
        <Kicker>Buttons</Kicker>
        <div className="flex flex-wrap items-center gap-3">
          <JoinButton>Join</JoinButton>
          <GlassButton>
            <Glyph name="listen" size={17} />
            Listen
          </GlassButton>
          <GlassButton pressed tone="amber">
            <Glyph name="listen" size={17} />
            Listening
          </GlassButton>
          <GlassButton>
            <Glyph name="clip" size={17} />
            Clip
          </GlassButton>
          <GlassButton variant="text">Watch</GlassButton>
          <GlassButton variant="text">Leave</GlassButton>
          <GlassButton variant="icon" aria-label="Layout">
            <Glyph name="split" size={18} />
          </GlassButton>
          <GlassButton variant="icon" pressed aria-label="Theater">
            <Glyph name="theater" size={18} />
          </GlassButton>
          <GlassButton variant="icon" disabled aria-label="Flame">
            <Glyph name="flame" size={18} />
          </GlassButton>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <JoinButton size="md">Join</JoinButton>
          <GlassButton size="md">
            <Glyph name="clip" size={19} />
            Clip
          </GlassButton>
          <GlassButton variant="icon" size="md" aria-label="Flame">
            <Glyph name="flame" size={19} />
          </GlassButton>
          <GlassButton variant="text" size="md">
            Stop watching
          </GlassButton>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <GlassChip tone="count">3</GlassChip>
          <GlassChip tone="mention">@</GlassChip>
          <GlassChip tone="live">Lounge 3 in</GlassChip>
          <GlassChip tone="event">Movie night Fri 9 PM</GlassChip>
          <GlassChip tone="reaction">
            <Glyph name="flame" size={13} />5
          </GlassChip>
        </div>
      </Pane>
    </div>
  );
}
