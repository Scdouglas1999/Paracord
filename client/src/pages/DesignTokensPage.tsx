import { useEffect, useRef, useState } from 'react';
import {
  Bell,
  Hash,
  Home,
  Mic,
  MonitorUp,
  MoreHorizontal,
  PhoneOff,
  Search,
  Settings,
  Users,
} from 'lucide-react';

import {
  Button,
  Chip,
  Divider,
  IconButton,
  Kbd,
  Lamp,
  MenuItem,
  MenuLabel,
  NavRow,
  Plate,
  Popover,
  Raised,
  SearchWell,
  SectionLabel,
  TextField,
  Tooltip,
  Well,
} from '../components/ui';
import { presenceLight } from '../lib/presence';

/**
 * `/design-tokens` — the Lantern Stage reference page. **Dev builds only**
 * (`App.tsx` mounts the route behind `import.meta.env.DEV`, so it is tree-shaken
 * out of production).
 *
 * This is how a reviewer or a later work package checks the system: every token
 * with its resolved value, the type scale, every primitive in every variant and
 * state, and all four themes side by side. If something here looks wrong, the
 * tokens are wrong — not the component that consumed them.
 */

/* -------------------------------------------------------------------------- */
/* Page scaffolding                                                            */
/* -------------------------------------------------------------------------- */

function Section({ id, title, blurb, children }: { id: string; title: string; blurb?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="pc-display text-title text-text-primary">{title}</h2>
        {blurb && <p className="max-w-[70ch] text-text-text-body">{blurb}</p>}
      </div>
      {children}
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>;
}

/** Reads a custom property off an element so the page shows the value in force. */
function useResolvedTokens(names: string[], scope: React.RefObject<HTMLElement | null>) {
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    const el = scope.current ?? document.documentElement;
    const style = getComputedStyle(el);
    const next: Record<string, string> = {};
    for (const name of names) next[name] = style.getPropertyValue(name).trim();
    setValues(next);
    // `names` is a module-level constant array per call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
  return values;
}

function Swatch({ name, value, kind }: { name: string; value: string; kind: 'fill' | 'ink' | 'shadow' }) {
  return (
    <div className="flex w-[15rem] flex-col gap-1.5">
      <div
        className="h-14 w-full rounded-[var(--radius-well)]"
        style={
          kind === 'fill'
            ? { background: `var(${name})`, boxShadow: 'var(--shadow-well)' }
            : kind === 'ink'
              ? { background: 'var(--bg-plate)', color: `var(${name})`, boxShadow: 'var(--shadow-well)' }
              : { background: 'var(--bg-plate)', boxShadow: `var(${name})` }
        }
      >
        {kind === 'ink' && (
          <span className="flex h-full items-center justify-center text-label font-medium">
            The quick brown fox
          </span>
        )}
      </div>
      <code className="pc-mono truncate text-meta text-text-secondary">{name}</code>
      <code className="pc-mono truncate text-meta text-text-faint" title={value}>
        {value || '—'}
      </code>
    </div>
  );
}

function TokenGrid({ names, kind }: { names: string[]; kind: 'fill' | 'ink' | 'shadow' }) {
  const scope = useRef<HTMLDivElement>(null);
  const values = useResolvedTokens(names, scope);
  return (
    <div ref={scope} className="flex flex-wrap gap-4">
      {names.map((name) => (
        <Swatch key={name} name={name} value={values[name] ?? ''} kind={kind} />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Token inventories — the vocabulary in docs/lantern-stage-spec.md §1–§5       */
/* -------------------------------------------------------------------------- */

const SURFACES = ['--bg-base', '--bg-plate', '--bg-raised', '--bg-well', '--bg-floating', '--window-dark'];
const WASHES = ['--bg-mod-subtle', '--bg-mod-strong', '--border-subtle', '--border-strong'];
const LIGHTS = ['--light-white', '--light-amber', '--accent-primary'];
const SEMANTIC = ['--accent-danger', '--accent-warning', '--accent-info', '--danger-well'];
const TEXT_RAMP = ['--text-primary', '--text-body-ink', '--text-secondary', '--text-muted', '--text-faint'];
const ON_FILLS = ['--text-on-light', '--text-on-accent', '--text-on-danger'];
const AVATARS = ['--color-avatar-1', '--color-avatar-2', '--color-avatar-3', '--color-avatar-4', '--color-avatar-5'];
const DEPTH = ['--shadow-plate', '--shadow-well', '--shadow-raised', '--shadow-lifted', '--shadow-composer', '--shadow-chip', '--shadow-tile'];
const GLOWS = ['--ring-lit', '--ring-speaking', '--ring-lit-plate', '--glow-light-fill', '--glow-control-on', '--glow-window-white', '--glow-window-amber'];

const TYPE_STEPS: Array<{ cls: string; name: string; face: string; use: string }> = [
  { cls: 'text-display pc-display', name: 'Display · 28/700', face: 'Gabarito', use: 'Lobby and Home titles' },
  { cls: 'text-title pc-display', name: 'Title · 22/700', face: 'Gabarito', use: 'Stage room name, text-room header' },
  { cls: 'text-heading pc-display', name: 'Heading · 18/700', face: 'Gabarito', use: 'Building names, room card titles' },
  { cls: 'text-name pc-display', name: 'Name · 15.5/600', face: 'Gabarito', use: 'Author names, list item titles' },
  { cls: 'text-body', name: 'Body · 15/400', face: 'Onest', use: 'Messages, prose' },
  { cls: 'text-ribbon', name: 'Ribbon · 14/400', face: 'Onest', use: 'The chat ribbon beside the Stage' },
  { cls: 'text-label', name: 'Label · 14/500', face: 'Onest', use: 'Nav rows, buttons, inputs' },
  { cls: 'text-meta', name: 'Meta · 12/500', face: 'Onest or Mono', use: 'Timestamps, counts, captions' },
  { cls: 'text-section', name: 'Section · 12/600', face: 'Onest', use: 'Section labels — sentence case' },
];

const RADII = ['--radius-plate', '--radius-card', '--radius-well', '--radius-control', '--radius-chip', '--radius-stage-control', '--radius-window'];
const HEIGHTS = ['--h-nav-row', '--h-list-row', '--h-control-sm', '--h-control', '--h-control-phone', '--h-composer', '--h-stage-control', '--h-chip', '--h-search-well'];
const MOTION = ['--duration-fast', '--duration-normal', '--duration-warm-up', '--duration-dim', '--duration-breathe', '--ease-out', '--ease-in', '--ease-in-out'];

/* -------------------------------------------------------------------------- */
/* Sections                                                                     */
/* -------------------------------------------------------------------------- */

function ScaleTable({ names, label }: { names: string[]; label: string }) {
  const scope = useRef<HTMLTableSectionElement>(null);
  const values = useResolvedTokens(names, scope);
  return (
    <table className="w-full max-w-[40rem] text-left">
      <caption className="pb-2 text-left text-section text-text-faint">{label}</caption>
      <tbody ref={scope}>
        {names.map((name) => (
          <tr key={name} className="border-b border-border-subtle last:border-0">
            <td className="py-1.5 pr-6">
              <code className="pc-mono text-meta text-text-secondary">{name}</code>
            </td>
            <td className="py-1.5">
              <code className="pc-mono text-meta text-text-faint">{values[name] || '—'}</code>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LightSection() {
  return (
    <Section
      id="light"
      title="Light"
      blurb="Three lights, three meanings. White is talking or live, amber is reading, emerald is an action you can take — and emerald is not a light. Every glow has a source, and light is state, never style: if a thing glows, a person is there right now."
    >
      <TokenGrid names={LIGHTS} kind="fill" />
      <Row>
        <div className="flex items-center gap-2">
          <span className="pc-window is-talking inline-block h-[13px] w-[10px]" aria-hidden />
          <span className="text-meta text-text-secondary">Window · talking</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="pc-window is-reading inline-block h-[13px] w-[10px]" aria-hidden />
          <span className="text-meta text-text-secondary">Window · reading</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="pc-window inline-block h-[13px] w-[10px]" aria-hidden />
          <span className="text-meta text-text-secondary">Window · dark</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="pc-live-dot" aria-hidden />
          <span className="text-meta text-text-secondary">Live dot</span>
        </div>
      </Row>
      <Row>
        {(['online', 'streaming', 'idle', 'dnd', 'offline'] as const).map((status) => {
          const light = presenceLight(status);
          return (
            <div key={status} className="flex w-[9rem] flex-col items-center gap-2">
              <span className={light.dnd ? 'pc-dnd rounded-full' : undefined}>
                <span
                  className={`${light.avatarClass} pc-display flex h-10 w-10 items-center justify-center rounded-full text-meta font-bold text-text-on-light`}
                  style={{ background: 'var(--color-avatar-1)' }}
                  aria-hidden
                >
                  MO
                </span>
              </span>
              <span className="text-meta text-text-faint">{light.label}</span>
            </div>
          );
        })}
        <div className="flex w-[9rem] flex-col items-center gap-2">
          <span
            className="pc-speaking pc-display flex h-10 w-10 items-center justify-center rounded-full text-meta font-bold text-text-on-light"
            style={{ background: 'var(--color-avatar-2)' }}
            aria-hidden
          >
            PR
          </span>
          <span className="text-meta text-text-faint">Speaking</span>
        </div>
      </Row>
      <ScaleTable names={GLOWS} label="Light recipes" />
      <TokenGrid names={GLOWS} kind="shadow" />
    </Section>
  );
}

function PrimitivesSection() {
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <Section
      id="primitives"
      title="Primitives"
      blurb="Every shared shell, in every variant and state. WP1's light components (WindowMap, LitAvatar, HereNowStrip, RoomThumbnail, StageTile) compose these."
    >
      <SectionLabel meta="4 variants">Button</SectionLabel>
      <Row>
        <Button variant="primary">Join</Button>
        <Button variant="light">Join</Button>
        <Button variant="ghost">Invite</Button>
        <Button variant="danger">Leave</Button>
        <Button variant="primary" loading>
          Saving
        </Button>
        <Button variant="primary" disabled>
          Disabled
        </Button>
      </Row>
      <Row>
        <Button size="sm">28 compact</Button>
        <Button size="md">32 default</Button>
        <Button size="lg">44 phone</Button>
        <Button size="icon" aria-label="More">
          <MoreHorizontal size={16} />
        </Button>
      </Row>

      <SectionLabel meta="4 tones · 4 sizes">Icon button</SectionLabel>
      <Row>
        <IconButton label="Search" size="sm">
          <Search size={14} />
        </IconButton>
        <IconButton label="Notifications">
          <Bell size={16} />
        </IconButton>
        <IconButton label="Settings" size="lg" tone="raised">
          <Settings size={18} />
        </IconButton>
        <IconButton label="Microphone is on" size="stage" tone="light">
          <Mic size={20} />
        </IconButton>
        <IconButton label="Share your screen" size="stage" tone="raised">
          <MonitorUp size={20} />
        </IconButton>
        <IconButton label="Leave the room" size="stage" tone="danger">
          <PhoneOff size={20} />
        </IconButton>
        <IconButton label="People" active>
          <Users size={16} />
        </IconButton>
      </Row>

      <SectionLabel meta="5 tones">Chip and Kbd</SectionLabel>
      <Row>
        <Chip>3</Chip>
        <Chip tone="accent">New</Chip>
        <Chip tone="talking">3 talking</Chip>
        <Chip tone="reading">5 reading</Chip>
        <Chip tone="danger">Failed</Chip>
        <Chip size="sm">2</Chip>
        <Chip as="button" onClick={() => {}}>
          Selectable
        </Chip>
        <Kbd>⌘K</Kbd>
        <Kbd>Esc</Kbd>
      </Row>

      <SectionLabel>Nav rows</SectionLabel>
      <Plate className="max-w-[var(--w-buildings-column)]">
        <div className="flex flex-col gap-0.5">
          <NavRow icon={<Home size={16} />} trailing={<Chip size="sm" tone="talking">3</Chip>}>
            Home
          </NavRow>
          <NavRow icon={<Hash size={16} />} active trailing={<span className="text-meta text-text-faint">5 reading</span>}>
            build-log
          </NavRow>
          <NavRow icon={<Hash size={16} />} display>
            Shop floor
          </NavRow>
        </div>
      </Plate>

      <SectionLabel>Fields</SectionLabel>
      <div className="flex max-w-[28rem] flex-col gap-4">
        <SearchWell icon={<Search size={16} />} shortcut={<Kbd>⌘K</Kbd>} />
        <TextField label="Room name" placeholder="Shop floor" hint="Short and specific." />
        <TextField label="Room name" defaultValue="general" error="A room already has that name." />
        <TextField label="Disabled" placeholder="Not editable" disabled />
      </div>

      <SectionLabel>Dividers</SectionLabel>
      <div className="flex max-w-[28rem] flex-col gap-4">
        <Divider />
        <Divider strong />
        <Divider label="Today" />
      </div>

      <SectionLabel>Floating surfaces</SectionLabel>
      <Row>
        <button
          ref={menuAnchor}
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          className="pc-focusable h-[var(--h-control)] rounded-[var(--radius-control)] bg-bg-raised px-3 text-label text-text-primary shadow-[var(--shadow-chip)]"
        >
          Open menu
        </button>
        <Popover anchor={menuAnchor} open={menuOpen} onClose={() => setMenuOpen(false)} role="menu" label="Room actions">
          <MenuLabel>Room</MenuLabel>
          <MenuItem icon={<Users size={16} />} onClick={() => setMenuOpen(false)}>
            Invite people
          </MenuItem>
          <MenuItem icon={<Settings size={16} />} trailing="⌘," onClick={() => setMenuOpen(false)}>
            Room settings
          </MenuItem>
          <MenuItem icon={<PhoneOff size={16} />} danger onClick={() => setMenuOpen(false)}>
            Leave the room
          </MenuItem>
        </Popover>
        <Tooltip content="Tooltips use the floating surface">
          <span className="text-label text-text-secondary underline decoration-dotted">Hover me</span>
        </Tooltip>
      </Row>
    </Section>
  );
}

/** A miniature of the real layout, so a theme can be judged on shapes, not swatches. */
function ThemePreview({ theme, label }: { theme?: string; label: string }) {
  return (
    <div
      data-theme={theme}
      className="flex min-w-0 flex-1 flex-col gap-2 rounded-[var(--radius-plate)] bg-bg-base p-3"
    >
      <div className="text-section text-text-faint">{label}</div>
      <div className="flex gap-2">
        <Plate bare className="relative w-1/3 overflow-hidden p-2.5" lit>
          <Lamp width={90} height={52} />
          <div className="relative flex flex-col gap-1.5">
            <div className="flex gap-[5px]">
              <span className="pc-window is-talking h-[13px] w-[10px]" />
              <span className="pc-window h-[13px] w-[10px]" />
              <span className="pc-window is-reading h-[13px] w-[10px]" />
              <span className="pc-window h-[13px] w-[10px]" />
            </div>
            <span className="text-meta text-text-faint">1 lit · 1 reading</span>
          </div>
        </Plate>
        <Plate bare className="flex min-w-0 flex-1 flex-col gap-2 p-2.5">
          <div className="pc-display truncate text-heading text-text-primary">Shop floor</div>
          <Well bare className="h-10 w-full" />
          <div className="flex items-center gap-2">
            <Button size="sm" variant="light">
              Join
            </Button>
            <Button size="sm" variant="ghost">
              Open
            </Button>
            <span className="ml-auto text-meta text-text-faint">3 talking</span>
          </div>
        </Plate>
      </div>
      <Raised bare className="flex items-center gap-2 p-2">
        <span
          className="pc-lit pc-display flex h-6 w-6 items-center justify-center rounded-full text-[9px] font-bold text-text-on-light"
          style={{ background: 'var(--color-avatar-3)' }}
          aria-hidden
        />
        <span className="text-meta text-text-secondary">Mara · lights on</span>
        <Chip size="sm" tone="reading" className="ml-auto">
          5
        </Chip>
      </Raised>
    </div>
  );
}

export default function DesignTokensPage() {
  return (
    <div className="h-full overflow-y-auto bg-bg-base">
      <div className="mx-auto flex max-w-[76rem] flex-col gap-12 px-6 py-10">
        <header className="flex flex-col gap-2">
          <p className="text-section text-text-faint">Dev only · docs/lantern-stage-spec.md</p>
          <h1 className="pc-display text-display text-text-primary">Lantern Stage tokens</h1>
          <p className="max-w-[70ch] text-text-text-body">
            A building at night, and light means people. Everything that is not light is dark, matte
            and quiet. This page is the contract made visible: if a component disagrees with what is
            here, the component is wrong.
          </p>
        </header>

        <Section
          id="surfaces"
          title="Surfaces"
          blurb="Three layers only: street → plate → raised or well inside a plate. Never nest a plate in a plate. Depth is a warm 1px top highlight plus a deep shadow, or an inset shadow — never a border."
        >
          <TokenGrid names={SURFACES} kind="fill" />
          <TokenGrid names={WASHES} kind="fill" />
          <Row>
            <Plate className="w-64">
              <p className="text-label text-text-secondary">Plate</p>
            </Plate>
            <Plate className="relative w-64 overflow-hidden" lit>
              <Lamp />
              <p className="relative text-label text-text-secondary">Plate · lit</p>
            </Plate>
            <Well className="w-64">
              <p className="text-label text-text-secondary">Well</p>
            </Well>
            <Raised className="w-64">
              <p className="text-label text-text-secondary">Raised</p>
            </Raised>
            <Raised lifted className="w-64">
              <p className="text-label text-text-secondary">Raised · lifted</p>
            </Raised>
          </Row>
          <ScaleTable names={DEPTH} label="Depth recipes" />
          <TokenGrid names={DEPTH} kind="shadow" />
        </Section>

        <LightSection />

        <Section id="semantic" title="Semantic" blurb="Distinct hues with fixed meanings. A light token is never spent on a semantic, and a semantic never means presence.">
          <TokenGrid names={SEMANTIC} kind="fill" />
        </Section>

        <Section
          id="text"
          title="Text"
          blurb="Five steps on the warm neutral. Body clears 7:1 on a plate and meta clears 4.5:1 on every Night ground."
        >
          <TokenGrid names={TEXT_RAMP} kind="ink" />
          <TokenGrid names={ON_FILLS} kind="ink" />
          <TokenGrid names={AVATARS} kind="fill" />
        </Section>

        <Section id="type" title="Type" blurb="Gabarito for names and titles, Onest for everything else, JetBrains Mono for meta. Tabular numerals everywhere a number can change.">
          <div className="flex flex-col gap-5">
            {TYPE_STEPS.map((step) => (
              <div key={step.cls} className="flex flex-col gap-1">
                <div className={`${step.cls} text-text-primary`}>
                  Shop floor — 3 talking, 5 reading
                </div>
                <div className="text-meta text-text-faint">
                  {step.name} · {step.face} · {step.use}
                </div>
              </div>
            ))}
            <div className="flex flex-col gap-1">
              <div className="pc-mono text-meta text-text-secondary">
                34:12 · 12,480 · 9:12 AM · 1,024 kbps · ⌘K
              </div>
              <div className="text-meta text-text-faint">Meta · JetBrains Mono · tabular numerals</div>
            </div>
          </div>
        </Section>

        <Section id="metrics" title="Spacing, radii, sizes, motion" blurb="A 4px grid; plates on a 12px gutter. Light is the only thing that animates on its own — everything else is a plain 120–160ms ease-out.">
          <div className="flex flex-wrap gap-10">
            <ScaleTable names={RADII} label="Radii" />
            <ScaleTable names={HEIGHTS} label="Control heights" />
            <ScaleTable names={MOTION} label="Motion" />
          </div>
          <Row>
            {RADII.map((name) => (
              <div key={name} className="flex w-[8.5rem] flex-col items-center gap-1.5">
                <div
                  className="h-14 w-14 bg-bg-raised"
                  style={{ borderRadius: `var(${name})`, boxShadow: 'var(--shadow-raised)' }}
                />
                <code className="pc-mono text-meta text-text-faint">{name.replace('--radius-', '')}</code>
              </div>
            ))}
          </Row>
        </Section>

        <PrimitivesSection />

        <Section
          id="themes"
          title="Themes"
          blurb="Themes remap the tokens, never the recipes. The light tokens are remapped in every theme, never removed: in Daylight they become ink so a lit room still reads as presence on paper."
        >
          <div className="flex flex-wrap gap-4">
            <ThemePreview label="Night — the default" />
            <ThemePreview theme="light" label="Daylight" />
            <ThemePreview theme="amoled" label="AMOLED" />
            <ThemePreview theme="high-contrast" label="High contrast" />
          </div>
        </Section>
      </div>
    </div>
  );
}
