import { useEffect, useRef, useState } from 'react';
import {
  Bell,
  Hash,
  Home,
  Inbox,
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
  EmptyState,
  ErrorBanner,
  IconButton,
  Kbd,
  Lamp,
  MenuItem,
  MenuLabel,
  Modal,
  ModalBody,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  NavRow,
  Plate,
  Popover,
  Raised,
  SearchWell,
  SectionLabel,
  Select,
  SettingsSectionHeader,
  SettingsShell,
  Switch,
  Tabs,
  Textarea,
  TextField,
  ToggleRow,
  Tooltip,
  Well,
} from '../components/ui';
import {
  AvatarStack,
  BuildingPlate,
  HereNowStrip,
  LightCaption,
  LitAvatar,
  OnAirPill,
  RoomDuration,
  RoomThumbnail,
  WindowMap,
  roomCaptionFor,
} from '../components/light';
import {
  aroundNowSentence,
  buildingLight,
  hereNowCaption,
  lightsOnOverflowCaption,
  litMembersCaption,
  personLight,
  textRoomLight,
  voiceRoomLight,
} from '../lib/attention/light';
import { presenceLight } from '../lib/presence';
import { toast } from '../stores/toastStore';
import {
  bloom,
  buildingIsDim,
  changeLights,
  clearVoiceLevels,
  dim,
  dimBuilding,
  flicker,
  press,
  publishVoiceLevels,
  relightBuilding,
  RollingNumber,
  settleIn,
  springEasing,
  SPEAKING_MARK,
  stagger,
  supportsLinearEasing,
  transitionWith,
  useFlipList,
  usePresence,
  useReducedMotion,
} from '../lib/motion';
import { cn } from '../lib/utils';
import { AccountPlate } from '../components/layout/sidebar/AccountPlate';
import { BuildingsColumn } from '../components/layout/sidebar/BuildingsColumn';
import { useMobile } from '../hooks/useMobile';
import { useUIStore } from '../stores/uiStore';

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
        {blurb && <p className="max-w-[70ch] text-text-body">{blurb}</p>}
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
const WASHES = ['--bg-mod-subtle', '--bg-mod-strong', '--bg-selected', '--border-subtle', '--border-strong'];
const LIGHTS = ['--light-white', '--light-amber', '--accent-primary'];
const SEMANTIC = ['--accent-danger', '--accent-warning', '--accent-info', '--danger-well'];
const TEXT_RAMP = ['--text-primary', '--text-body-ink', '--text-secondary', '--text-muted', '--text-faint'];
const ON_FILLS = ['--text-on-light', '--text-on-accent', '--text-on-danger'];
const AVATARS = [
  '--color-avatar-1',
  '--color-avatar-2',
  '--color-avatar-3',
  '--color-avatar-4',
  '--color-avatar-5',
  '--color-avatar-6',
  '--color-avatar-7',
  '--color-avatar-8',
];
const DEPTH = ['--shadow-plate', '--shadow-well', '--shadow-raised', '--shadow-lifted', '--shadow-composer', '--shadow-chip', '--shadow-tile'];
const GLOWS = ['--ring-lit', '--ring-speaking', '--ring-lit-plate', '--glow-light-fill', '--glow-control-on', '--glow-window-white', '--glow-window-amber'];

const TYPE_STEPS: Array<{ cls: string; name: string; face: string; use: string }> = [
  { cls: 'text-display pc-display', name: 'Display · 28/700', face: 'Gabarito', use: 'Lobby and Home titles' },
  { cls: 'text-title pc-display', name: 'Title · 22/700', face: 'Gabarito', use: 'Stage channel name, text-channel header' },
  { cls: 'text-heading pc-display', name: 'Heading · 18/700', face: 'Gabarito', use: 'Server names, channel card titles' },
  { cls: 'text-name pc-display', name: 'Name · 15.5/600', face: 'Gabarito', use: 'Author names, list item titles' },
  { cls: 'text-body', name: 'Body · 15/400', face: 'Onest', use: 'Messages, prose' },
  { cls: 'text-ribbon', name: 'Ribbon · 14/400', face: 'Onest', use: 'The chat ribbon beside the Stage' },
  { cls: 'text-label', name: 'Label · 14/500', face: 'Onest', use: 'Nav rows, buttons, inputs' },
  { cls: 'text-meta', name: 'Meta · 12/500', face: 'Onest or Mono', use: 'Timestamps, counts, captions' },
  { cls: 'text-section', name: 'Section · 12/600', face: 'Onest', use: 'Section labels — sentence case' },
];

const RADII = ['--radius-plate', '--radius-card', '--radius-well', '--radius-control', '--radius-chip', '--radius-stage-control', '--radius-window'];
const HEIGHTS = ['--h-nav-row', '--h-list-row', '--h-control-sm', '--h-control', '--h-control-phone', '--h-composer', '--h-stage-control', '--h-chip', '--h-search-well'];
const MOTION = [
  '--duration-fast', '--duration-normal', '--duration-slow', '--duration-warm-up', '--duration-dim',
  '--duration-move', '--duration-roll', '--duration-breathe',
  '--ease-out', '--ease-in', '--ease-in-out', '--ease-spring-settle',
  '--stagger-light', '--stagger-chrome',
  '--spring-stiffness', '--spring-damping', '--spring-mass',
];

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
      blurb="Three lights, three meanings. White is talking or live, amber is somebody in a text channel, emerald is an action you can take — and emerald is not a light. Every glow has a source, and light is state, never style: if a thing glows, a person is there right now."
    >
      <TokenGrid names={LIGHTS} kind="fill" />
      <Row>
        <div className="flex items-center gap-2">
          <span className="pc-window is-talking inline-block h-[13px] w-[10px]" aria-hidden />
          <span className="text-meta text-text-secondary">Window · talking</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="pc-window is-reading inline-block h-[13px] w-[10px]" aria-hidden />
          <span className="text-meta text-text-secondary">Window · somebody here</span>
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

const DEMO_TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'roles', label: 'Roles', meta: '4' },
  { value: 'audit', label: 'Audit log' },
] as const;

const DEMO_SETTINGS_GROUPS = [
  { items: [{ id: 'account', label: 'My account', icon: <Users size={16} /> }] },
  {
    label: 'Preferences',
    items: [
      { id: 'appearance', label: 'Appearance', icon: <Settings size={16} /> },
      { id: 'voice', label: 'Voice and video', icon: <Mic size={16} /> },
      { id: 'notifications', label: 'Notifications', icon: <Bell size={16} /> },
    ],
  },
];

function PrimitivesSection() {
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [switchOn, setSwitchOn] = useState(true);
  const [soundOn, setSoundOn] = useState(false);
  const [tab, setTab] = useState<string>('roles');
  const [pageTab, setPageTab] = useState<string>('overview');
  const [settingsSection, setSettingsSection] = useState('voice');
  const [settingsShowIndex, setSettingsShowIndex] = useState(true);
  const shellIsMobile = useMobile();
  const [dialogOpen, setDialogOpen] = useState(false);

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
        <IconButton label="Leave the call" size="stage" tone="danger">
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
        <Chip tone="reading">5 here</Chip>
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
          <NavRow icon={<Hash size={16} />} active trailing={<span className="text-meta text-text-faint">5 here</span>}>
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
        <TextField label="Channel name" placeholder="Shop floor" hint="Short and specific." />
        <TextField label="Channel name" defaultValue="general" error="A channel already has that name." />
        <TextField label="Disabled" placeholder="Not editable" disabled />
        <Select defaultValue="default" aria-label="Microphone">
          <option value="default">System default — Scarlett Solo</option>
          <option value="webcam">C920 webcam</option>
        </Select>
        <Textarea rows={3} placeholder="What is this channel for?" aria-label="Channel topic" />
      </div>

      <SectionLabel meta="off is a well, on is the emerald">Switch and toggle row</SectionLabel>
      <div className="flex max-w-[32rem] flex-col">
        <Row>
          <Switch checked={switchOn} onChange={setSwitchOn} label="Compact messages" />
          <Switch checked={!switchOn} onChange={(v) => setSwitchOn(!v)} label="Quiet hours" />
          <Switch checked={false} onChange={() => {}} label="Unavailable" disabled />
        </Row>
        <Plate className="mt-3">
          <ToggleRow
            label="Play a sound for mentions"
            description="Only while the app is in the background."
            checked={soundOn}
            onChange={setSoundOn}
          />
          <Divider />
          <ToggleRow
            label="Show when you are in a voice channel"
            description="Other people see the channel name on your profile."
            checked={switchOn}
            onChange={setSwitchOn}
          />
        </Plate>
      </div>

      <SectionLabel meta="2 variants">Tabs</SectionLabel>
      <div className="flex max-w-[32rem] flex-col gap-4">
        <Tabs items={DEMO_TABS} value={tab} onChange={setTab} label="Server settings" className="self-start" />
        <Tabs
          items={DEMO_TABS}
          value={pageTab}
          onChange={setPageTab}
          label="Server settings, as pages"
          variant="underline"
        />
      </div>

      <SectionLabel>Dialog, toast, banner, empty state</SectionLabel>
      <Row>
        <Button variant="ghost" onClick={() => setDialogOpen(true)}>
          Open a dialog
        </Button>
        {/* The stack is one FLIP'd list (§5.1): a new toast rises into the
            bottom-right, a dismissed one falls away, and the toasts still on
            screen slide to their new spots on the spring. Three buttons,
            because one toast cannot show you a stack behaving. */}
        <Button variant="ghost" onClick={() => toast.success('The invite is live.')}>
          Raise a toast
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            toast.info('Recovering this channel’s history…');
            window.setTimeout(() => toast.warning('Two attachments are still uploading.'), 220);
            window.setTimeout(() => toast.error('The thermal rig stopped answering.'), 440);
          }}
        >
          Raise three
        </Button>
      </Row>
      <Modal
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        size="sm"
        labelledBy="tokens-dialog-title"
        describedBy="tokens-dialog-desc"
        showCloseButton
      >
        <ModalHeader>
          <ModalTitle id="tokens-dialog-title">Delete “build-log”?</ModalTitle>
          <ModalDescription id="tokens-dialog-desc">
            Its 1,204 messages go with it. Nobody can undo this.
          </ModalDescription>
        </ModalHeader>
        <ModalBody>
          <TextField label="Type the channel name to confirm" placeholder="build-log" />
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" onClick={() => setDialogOpen(false)}>
            Keep it
          </Button>
          <Button variant="danger" onClick={() => setDialogOpen(false)}>
            Delete the channel
          </Button>
        </ModalFooter>
      </Modal>
      <div className="flex max-w-[36rem] flex-col gap-4">
        <ErrorBanner message="That invite has already been used." onRetry={() => {}} />
        <ErrorBanner
          multiline
          message="The server refused the upload: attachments are capped at 25 MB here, and this file is 41 MB. Compress it, or ask an admin to raise the cap."
        />
        <Plate>
          <EmptyState
            icon={<Inbox size={18} />}
            title="No invites are live right now"
            description="An invite lets someone join this server without an admin adding them by hand."
            action={<Button>Create an invite</Button>}
          />
        </Plate>
      </div>

      <SectionLabel meta="one plate, index and content">Settings shell</SectionLabel>
      <div className="h-[26rem] max-w-[52rem]">
        <SettingsShell
          label="User settings, as an example"
          title="Sam Douglas"
          groups={DEMO_SETTINGS_GROUPS}
          active={settingsSection}
          onSelect={(id) => {
            setSettingsSection(id);
            setSettingsShowIndex(false);
          }}
          onClose={() => {}}
          closeLabel="Close the example"
          isMobile={shellIsMobile}
          showIndex={settingsShowIndex}
          onShowIndex={setSettingsShowIndex}
          contentClassName="px-6 py-6"
        >
          <SettingsSectionHeader
            title="Voice and video"
            description="Pick the microphone and camera this device uses, and check the connection before a call."
            action={<Button>Run a connection check</Button>}
          />
          <Select defaultValue="default" aria-label="Microphone" className="max-w-sm">
            <option value="default">System default — Scarlett Solo</option>
          </Select>
        </SettingsShell>
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
        <Popover anchor={menuAnchor} open={menuOpen} onClose={() => setMenuOpen(false)} role="menu" label="Channel actions">
          <MenuLabel>Channel</MenuLabel>
          <MenuItem icon={<Users size={16} />} onClick={() => setMenuOpen(false)}>
            Invite people
          </MenuItem>
          <MenuItem icon={<Settings size={16} />} trailing="⌘," onClick={() => setMenuOpen(false)}>
            Channel settings
          </MenuItem>
          <MenuItem icon={<PhoneOff size={16} />} danger onClick={() => setMenuOpen(false)}>
            Leave the channel
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
function ThemePreview({ theme, label }: { theme: string; label: string }) {
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
            <span className="text-meta text-text-faint">1 in voice · 1 here</span>
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
        <span className="text-meta text-text-secondary">Mara · online</span>
        <Chip size="sm" tone="reading" className="ml-auto">
          5
        </Chip>
      </Raised>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* WP1 — the light components                                                  */
/* -------------------------------------------------------------------------- */

const LIGHT_SCOPE = { serverId: 'design', userId: 'viewer' };
const LIGHT_NOW = 1_800_000_000_000;

function demoPerson(userId: string, name: string, over: Partial<Parameters<typeof personLight>[0]> = {}) {
  return personLight({ userId, name, status: 'online', ...over });
}

const DEMO_MARA = demoPerson('101', 'Mara');
const DEMO_PRIYA = demoPerson('102', 'Priya');
const DEMO_REN = demoPerson('103', 'Ren');
const DEMO_TOMAS = demoPerson('104', 'Tomas');
const DEMO_AISHA = demoPerson('105', 'Aisha');
const DEMO_DEVON = demoPerson('106', 'Devon', { status: 'idle' });
const DEMO_SASHA = demoPerson('107', 'Sasha', { status: 'dnd' });
const DEMO_JO = demoPerson('108', 'Jo', { status: 'offline' });
const DEMO_SPEAKER = demoPerson('101', 'Mara', {
  speaking: true,
  inRoom: true,
  roomName: 'Shop floor',
});

function demoVoice(
  over: Partial<Parameters<typeof voiceRoomLight>[0]> = {},
): ReturnType<typeof voiceRoomLight> {
  return voiceRoomLight({
    scope: LIGHT_SCOPE,
    guildId: 'g1',
    channelId: 'v1',
    name: 'Shop floor',
    occupants: [],
    nowMs: LIGHT_NOW,
    ...over,
  });
}

function demoText(
  over: Partial<Parameters<typeof textRoomLight>[0]> = {},
): ReturnType<typeof textRoomLight> {
  return textRoomLight({
    scope: LIGHT_SCOPE,
    guildId: 'g1',
    channelId: 't1',
    name: 'build-log',
    candidates: [DEMO_TOMAS, DEMO_AISHA],
    nowMs: LIGHT_NOW,
    ...over,
  });
}

const DEMO_LIT_ROOM = demoVoice({
  occupants: [
    { person: DEMO_SPEAKER, speaking: true, sharingScreen: true },
    { person: DEMO_PRIYA },
    { person: DEMO_REN },
  ],
  startedAtMs: LIGHT_NOW - 34 * 60_000 - 12_000,
});
const DEMO_DARK_ROOM = demoVoice({
  channelId: 'v2',
  name: 'Lounge',
  order: 1,
  lastLitMs: LIGHT_NOW - 2 * 3_600_000,
});
const DEMO_READ_ROOM = demoText({ typingUserIds: ['104', '105'], order: 2 });
const DEMO_QUIET_ROOM = demoText({ channelId: 't2', name: 'general', order: 3 });

/** A real building has more rooms than fit on one row — that is what the two-row
 *  cap and the overflow count are for, so the demo carries a realistic set. */
const DEMO_QUIET_ROOMS = [
  'firmware',
  'shipping',
  'pcb-review',
  'purchasing',
  'off-topic',
  'bench-notes',
  'calibration',
  'archive',
].map((name, index) =>
  demoText({ channelId: `t${index + 3}`, name, order: index + 4, candidates: [] }),
);

const DEMO_BUILDING = buildingLight({
  scope: LIGHT_SCOPE,
  guildId: 'g1',
  name: 'Kestrel Robotics',
  rooms: [
    DEMO_LIT_ROOM,
    demoVoice({ channelId: 'v3', name: 'Quiet corner', order: 1, occupants: [{ person: DEMO_AISHA }] }),
    DEMO_DARK_ROOM,
    DEMO_READ_ROOM,
    DEMO_QUIET_ROOM,
    ...DEMO_QUIET_ROOMS,
  ],
  members: [DEMO_MARA, DEMO_PRIYA, DEMO_REN, DEMO_TOMAS, DEMO_AISHA, DEMO_DEVON],
  memberCount: 61,
});

const DEMO_DARK_BUILDING = buildingLight({
  scope: LIGHT_SCOPE,
  guildId: 'g2',
  name: 'Saltmarsh Sailing',
  rooms: [
    demoVoice({ channelId: 'v9', name: 'Clubhouse' }),
    demoText({ channelId: 't90', name: 'regatta-2026', order: 1, candidates: [] }),
    demoText({ channelId: 't91', name: 'crew-list', order: 2, candidates: [] }),
    demoText({ channelId: 't92', name: 'boat-swap', order: 3, candidates: [] }),
    demoText({ channelId: 't93', name: 'tides', order: 4, candidates: [] }),
  ],
  members: [DEMO_JO],
  memberCount: 12,
});

const DEMO_HERE_NOW = {
  people: [DEMO_SPEAKER, DEMO_PRIYA, DEMO_REN, DEMO_TOMAS],
  here: 4,
  lightsOn: 20,
  caption: '4 here · 20 online',
};

const DEMO_ON_AIR = {
  isDirectMessage: false,
  others: [{ userId: 'u-ada', name: 'Ada', speaking: false }],
  room: DEMO_LIT_ROOM,
  roomName: 'Shop floor',
  buildingName: 'Kestrel Robotics',
  durationMs: 34 * 60_000 + 12_000,
  micOn: true,
  deafened: false,
  sharing: true,
  speaking: true,
};

function LightComponentsSection() {
  return (
    <Section
      id="light-components"
      title="Light components"
      blurb="The WP1 vocabulary: a window map, a server plate, lit avatars, a here-now strip, a channel thumbnail and the on-air pill. Every state below is real data from lib/attention/light.ts — the models decide what is lit, the components only draw it, and each one renders its words as well as its light."
    >
      <div id="light-avatars" className="flex flex-col gap-4">
      <SectionLabel meta="rim · breathe · dim · slash">Lit avatars</SectionLabel>
      <Row>
        {[DEMO_MARA, DEMO_SPEAKER, DEMO_DEVON, DEMO_SASHA, DEMO_JO].map((person, index) => (
          <div key={`${person.userId}-${index}`} className="flex w-[9rem] flex-col items-center gap-2">
            <LitAvatar person={person} size={40} />
            <span className="text-meta text-text-faint">{person.label}</span>
          </div>
        ))}
      </Row>
      <Row>
        {[18, 22, 24, 28, 32, 36].map((size) => (
          <div key={size} className="flex flex-col items-center gap-1.5">
            <LitAvatar person={DEMO_MARA} size={size} hideLabel />
            <span className="pc-mono text-meta text-text-faint">{size}</span>
          </div>
        ))}
      </Row>

      <SectionLabel meta="overlap · max N · +M">Avatar stacks</SectionLabel>
      <Row>
        <AvatarStack people={[DEMO_MARA, DEMO_PRIYA, DEMO_REN]} size={26} context="in Shop floor" />
        <AvatarStack
          people={[DEMO_MARA, DEMO_PRIYA, DEMO_REN, DEMO_TOMAS, DEMO_AISHA, DEMO_DEVON, DEMO_JO]}
          size={28}
          max={5}
          context="online"
        />
        <AvatarStack people={[DEMO_MARA]} size={18} max={3} context="in Shop floor" />
      </Row>

      </div>

      <div id="light-windows" className="flex flex-col gap-4">
      <SectionLabel meta="≤ 2 rows of 8">Window map</SectionLabel>
      <div className="flex flex-col gap-4">
        <Well className="w-full max-w-[26rem]">
          <WindowMap
            windows={DEMO_BUILDING.windows}
            overflowCount={DEMO_BUILDING.overflowCount}
            caption={DEMO_BUILDING.caption}
          />
        </Well>
        <Well className="w-full max-w-[30rem]">
          <WindowMap
            windows={DEMO_BUILDING.windows}
            caption={DEMO_BUILDING.caption}
            scale="home"
          />
        </Well>
      </div>

      <SectionLabel meta="lit · dark">Server plate</SectionLabel>
      <div className="flex max-w-[var(--w-buildings-column)] flex-col gap-2">
        <SectionLabel meta={litMembersCaption(DEMO_BUILDING.lightsOn)}>
          {DEMO_BUILDING.name}
        </SectionLabel>
        <BuildingPlate building={DEMO_BUILDING} />
        <SectionLabel meta={litMembersCaption(DEMO_DARK_BUILDING.lightsOn)}>
          {DEMO_DARK_BUILDING.name}
        </SectionLabel>
        <BuildingPlate building={DEMO_DARK_BUILDING} />
      </div>

      </div>

      <div id="light-thumbnails" className="flex flex-col gap-4">
      <SectionLabel meta="64 · 168 · 176">Channel thumbnails</SectionLabel>
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex w-full max-w-[17rem] flex-col gap-1.5">
          <RoomThumbnail room={DEMO_LIT_ROOM} height={64} />
          <div className="flex items-center gap-2">
            <span className="pc-display truncate text-name text-text-primary">
              {DEMO_LIT_ROOM.name}
            </span>
            <LightCaption className="ml-auto">{roomCaptionFor(DEMO_LIT_ROOM)}</LightCaption>
          </div>
        </div>
        <div className="flex w-full max-w-[17rem] flex-col gap-1.5">
          <RoomThumbnail room={DEMO_DARK_ROOM} height={64} />
          <div className="flex items-center gap-2">
            <span className="pc-display truncate text-name text-text-secondary">
              {DEMO_DARK_ROOM.name}
            </span>
            <LightCaption className="ml-auto">
              {roomCaptionFor(DEMO_DARK_ROOM, {
                surface: 'card',
                withLastLit: true,
                nowMs: LIGHT_NOW,
              })}
            </LightCaption>
          </div>
        </div>
        {/* The Lobby card (§7.3): the thumbnail carries the light, the body
            carries the people and the Join. WP4 builds the real one. */}
        <Plate bare lit className="relative w-full max-w-[22rem] overflow-hidden">
          <RoomThumbnail
            room={DEMO_LIT_ROOM}
            height={168}
            showOccupants={false}
            className="rounded-b-none"
          />
          <div className="flex flex-col gap-2.5 p-3.5">
            <div className="flex items-center gap-2">
              <span className="pc-display text-heading text-text-primary">
                {DEMO_LIT_ROOM.name}
              </span>
              <RoomDuration durationMs={DEMO_LIT_ROOM.durationMs} />
            </div>
            <div className="flex items-center gap-2.5">
              <AvatarStack
                people={DEMO_LIT_ROOM.occupants.map((occupant) => occupant.person)}
                size={26}
                context={`in ${DEMO_LIT_ROOM.name}`}
              />
              <span className="text-label text-text-body">Mara speaking</span>
              <Button size="sm" variant="light" className="ml-auto">
                Join
              </Button>
            </div>
          </div>
        </Plate>
        {/* Home's 176px thumbnail (§7.5) puts the people and the Join on the
            frame itself. */}
        <div className="w-full max-w-[22rem]">
          <RoomThumbnail
            room={DEMO_LIT_ROOM}
            height={176}
            action={
              <Button size="sm" variant="light">
                Join
              </Button>
            }
          />
        </div>
      </div>

      </div>

      <div id="light-herenow" className="flex flex-col gap-4">
      <SectionLabel meta="the only full list is the sheet">Here now</SectionLabel>
      <Plate className="flex w-full max-w-[42rem] flex-wrap items-center gap-3">
        <span className="pc-display text-title text-text-primary">Shop floor</span>
        <LightCaption mono>34:12</LightCaption>
        <HereNowStrip
          hereNow={DEMO_HERE_NOW}
          context="in Shop floor"
          everyone={[
            DEMO_SPEAKER,
            DEMO_PRIYA,
            DEMO_REN,
            DEMO_TOMAS,
            DEMO_AISHA,
            DEMO_DEVON,
            DEMO_SASHA,
            DEMO_JO,
          ]}
        />
      </Plate>

      <SectionLabel meta="returns you to the Stage">On-air pill</SectionLabel>
      <Row>
        <OnAirPill onAir={DEMO_ON_AIR} />
        <OnAirPill onAir={{ ...DEMO_ON_AIR, micOn: false, sharing: false }} />
        <OnAirPill onAir={{ ...DEMO_ON_AIR, deafened: true, durationMs: 3_782_000 }} />
      </Row>

      <SectionLabel meta="light is never the only cue">Captions</SectionLabel>
      <div className="flex flex-col gap-1.5">
        {[
          roomCaptionFor(DEMO_LIT_ROOM),
          roomCaptionFor(DEMO_READ_ROOM),
          roomCaptionFor(DEMO_DARK_ROOM, { surface: 'row' }),
          roomCaptionFor(DEMO_DARK_ROOM, { surface: 'card', withLastLit: true, nowMs: LIGHT_NOW }),
          DEMO_BUILDING.caption,
          hereNowCaption(4, 20),
          lightsOnOverflowCaption(17),
          aroundNowSentence({
            rooms: [DEMO_LIT_ROOM, DEMO_READ_ROOM],
            people: [DEMO_DEVON],
          }),
        ].map((caption) => (
          <LightCaption key={caption} className="text-text-secondary">
            {caption}
          </LightCaption>
        ))}
      </div>
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* WP2 — the Buildings column                                                  */
/* -------------------------------------------------------------------------- */

/** The lit room with you in it, so the caption reads "you're here" (§7.1). */
const DEMO_YOUR_ROOM = demoVoice({
  channelId: 'v1',
  occupants: [
    { person: DEMO_SPEAKER, speaking: true, sharingScreen: true },
    { person: DEMO_PRIYA },
    { person: DEMO_REN },
    { person: demoPerson('viewer', 'Sam Douglas', { inRoom: true, roomName: 'Shop floor' }) },
  ],
  selfUserId: 'viewer',
  startedAtMs: LIGHT_NOW - 34 * 60_000 - 12_000,
});

const DEMO_IN_CALL_BUILDING = buildingLight({
  scope: LIGHT_SCOPE,
  guildId: 'g1',
  name: 'Kestrel Robotics',
  rooms: [
    DEMO_YOUR_ROOM,
    DEMO_DARK_ROOM,
    DEMO_READ_ROOM,
    DEMO_QUIET_ROOM,
    ...DEMO_QUIET_ROOMS,
  ],
  members: [DEMO_MARA, DEMO_PRIYA, DEMO_REN, DEMO_TOMAS, DEMO_AISHA, DEMO_DEVON],
  memberCount: 61,
});

const DEMO_ACCOUNT = {
  user: { id: 'viewer', username: 'sam.douglas', display_name: null, avatar_hash: null, flags: 0 },
  navigate: () => undefined,
  muted: false,
  deafened: false,
  onToggleMute: () => undefined,
  onToggleDeaf: () => undefined,
  showAdminDashboard: false,
};

const DEMO_COLUMN_HANDLERS = {
  onOpenHome: () => undefined,
  onOpenMessages: () => undefined,
  onOpenLobby: () => undefined,
  onOpenRoom: () => undefined,
  onAddBuilding: () => undefined,
};

function ColumnFrame({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div id={id} className="flex flex-col gap-2">
      <SectionLabel>{label}</SectionLabel>
      <div className="h-[44rem] w-[calc(var(--w-buildings-column)+var(--gutter)+var(--gutter))] max-w-full shrink-0 bg-bg-base p-3">
        {children}
      </div>
    </div>
  );
}

function BuildingsColumnSection() {
  return (
    <Section
      id="buildings-column"
      title="Servers column"
      blurb="The sidebar, in the three states worth reviewing: a Lobby open, a text channel open, and you in a call. Every server, channel and caption below is a real model from lib/attention — the column only draws them."
    >
      <div className="flex flex-wrap items-start gap-6">
        <ColumnFrame id="column-lobby" label="A Lobby is open">
          <BuildingsColumn
            buildings={[DEMO_BUILDING, DEMO_DARK_BUILDING]}
            needsYouCount={3}
            messagesCount={2}
            activeBuildingKey={DEMO_BUILDING.key}
            {...DEMO_COLUMN_HANDLERS}
            footer={<AccountPlate {...DEMO_ACCOUNT} />}
          />
        </ColumnFrame>

        <ColumnFrame id="column-room" label="A text channel is open">
          <BuildingsColumn
            buildings={[DEMO_BUILDING, DEMO_DARK_BUILDING]}
            needsYouCount={3}
            messagesCount={2}
            activeRoomKey={DEMO_READ_ROOM.key}
            attention={new Map([[DEMO_QUIET_ROOM.key, { unread: true, mentionCount: 2 }]])}
            {...DEMO_COLUMN_HANDLERS}
            footer={<AccountPlate {...DEMO_ACCOUNT} />}
          />
        </ColumnFrame>

        <ColumnFrame id="column-call" label="You are in a call">
          <BuildingsColumn
            buildings={[DEMO_IN_CALL_BUILDING, DEMO_DARK_BUILDING]}
            needsYouCount={3}
            messagesCount={2}
            activeRoomKey={DEMO_YOUR_ROOM.key}
            {...DEMO_COLUMN_HANDLERS}
            footer={<AccountPlate {...DEMO_ACCOUNT} />}
          />
        </ColumnFrame>

        <ColumnFrame id="column-empty" label="No servers yet">
          <BuildingsColumn
            buildings={[]}
            needsYouCount={0}
            messagesCount={0}
            homeActive
            {...DEMO_COLUMN_HANDLERS}
            footer={<AccountPlate {...DEMO_ACCOUNT} />}
          />
        </ColumnFrame>
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Motion (§5) — the engine, one recipe at a time                              */
/* -------------------------------------------------------------------------- */

/**
 * One recipe: what it is for, the tokens it spends, a thing to play it on, and
 * a button to play it again. A recipe that cannot be replayed cannot be judged.
 */
function Recipe({
  id,
  name,
  model,
  tokens,
  onPlay,
  children,
}: {
  id: string;
  name: string;
  /** The physical model §5.1 gives it. A recipe without one is rejected. */
  model: string;
  tokens: string;
  onPlay: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      id={id}
      className="flex min-w-0 flex-col gap-3 rounded-[var(--radius-card)] bg-bg-well p-4 shadow-[var(--shadow-well)]"
    >
      <div className="flex items-baseline gap-2">
        <span className="pc-display text-name text-text-primary">{name}</span>
        <code className="pc-mono ml-auto shrink-0 text-meta text-text-faint">{tokens}</code>
      </div>
      <div className="flex min-h-[5.5rem] items-center justify-center">{children}</div>
      <p className="text-meta leading-relaxed text-text-faint">{model}</p>
      <Button variant="secondary" size="sm" className="self-start" onClick={onPlay}>
        Replay
      </Button>
    </div>
  );
}

/**
 * The audio-reactive speaking ring, driven by a made-up voice (§5.1, WP9d).
 *
 * A level only exists inside a call, and this page is not one — so the demo
 * plays a two-second phrase through the real engine: the same
 * `publishVoiceLevels` the media engines call, the same single rAF loop, the
 * same `--voice-level` on the same marks. What is fake is the voice, and
 * nothing else. It is also what the motion gate drives, which is why it is
 * here rather than in a story.
 */
const VOICE_DEMO_ID = 'tokens-speaker';
/** How long the made-up phrase lasts. */
const DEMO_PHRASE_MS = 1900;

function SpeakingRingDemo({ take }: { take: number }) {
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (take === 0) return undefined;
    const started = performance.now();
    // A phrase, not a sine: two syllables, a breath, and a longer one. The
    // envelope in `voiceLevel.ts` is what makes it read as a voice rather than
    // as a slider being dragged.
    const shape = (t: number) =>
      t > DEMO_PHRASE_MS ? 0 : Math.max(0, Math.sin(t / 150) * 0.55 + Math.sin(t / 420) * 0.5);
    // The media engines report at their own cadence — a few times a second, not
    // per frame. Publishing faster here would be measuring something the
    // product never does.
    timer.current = window.setInterval(() => {
      const t = performance.now() - started;
      publishVoiceLevels('room', new Map([[VOICE_DEMO_ID, Math.min(1, shape(t))]]));
      if (t > DEMO_PHRASE_MS + 300 && timer.current != null) {
        clearInterval(timer.current);
        timer.current = null;
        clearVoiceLevels();
      }
    }, 90);
    return () => {
      if (timer.current != null) clearInterval(timer.current);
      timer.current = null;
      clearVoiceLevels();
    };
  }, [take]);

  return (
    <span
      {...{ [SPEAKING_MARK]: VOICE_DEMO_ID }}
      className="pc-speaking pc-display flex h-14 w-14 items-center justify-center rounded-full bg-bg-raised text-name font-bold text-text-primary"
      aria-hidden
    >
      MO
    </span>
  );
}

/** The rows the reorder recipe shuffles — the sidebar's own shape, in miniature. */
const REORDER_ROWS: readonly string[] = ['build-log', 'Shop floor', 'Design review', 'Announcements'];

function MotionSection() {
  const reduced = useReducedMotion();
  const bloomRef = useRef<HTMLSpanElement>(null);
  const dimRef = useRef<HTMLSpanElement>(null);
  const flickerRef = useRef<HTMLSpanElement>(null);
  const settleRef = useRef<HTMLDivElement>(null);
  const pressRef = useRef<HTMLButtonElement>(null);
  const staggerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [rolled, setRolled] = useState(4);
  const [walkedIn, setWalkedIn] = useState(false);
  const [engine, setEngine] = useState<string | null>(null);
  const [order, setOrder] = useState(REORDER_ROWS);
  const reorderRef = useFlipList<HTMLDivElement>();
  // WP9d: the reaction pop row, the writing pulse, and a plate from its edge.
  const [popped, setPopped] = useState(false);
  const popRef = useFlipList<HTMLDivElement>({ enter: 'pop' });
  const [writing, setWriting] = useState(false);
  const writingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [plateOpen, setPlateOpen] = useState(false);
  const platePresence = usePresence(plateOpen);
  const [speaking, setSpeaking] = useState(0);
  const [lightsEngine, setLightsEngine] = useState<string | null>(null);
  const [dark, setDark] = useState(false);
  const themeOf = useUIStore((state) => state.theme);
  const setThemeOf = useUIStore((state) => state.setTheme);

  const swapTheme = (force?: 'crossfade') => {
    const next = themeOf === 'light' ? 'dark' : 'light';
    void changeLights(() => setThemeOf(next), {
      engine: force ?? 'auto',
      applied: () => document.documentElement.getAttribute('data-theme') === next,
    }).then((result) => setLightsEngine(result.engine));
  };

  const cutPower = () => {
    if (buildingIsDim()) {
      void relightBuilding().then(() => setDark(false));
      return;
    }
    dimBuilding();
    setDark(true);
  };

  const walk = (force?: 'flip') => {
    void transitionWith(() => setWalkedIn((value) => !value), {
      root: stageRef.current ?? undefined,
      engine: force ?? 'auto',
    }).then((result) => setEngine(result.engine));
  };

  return (
    <Section
      id="motion"
      title="Motion"
      blurb="Only light and the things people do animate. Every recipe below is Web Animations over the tokens beside it — transform and opacity, plus box-shadow on the small light elements. Nothing runs longer than 500ms except breathing."
    >
      <p className="max-w-[70ch] text-meta leading-relaxed text-text-faint">
        The switch is one place: Settings › Appearance › Motion, folded with the
        OS setting and published as <code className="pc-mono">data-motion</code> on the document.
        It is currently <span className="text-text-primary">{reduced ? 'reduced — every recipe below lands its end state instantly' : 'on'}</span>.
        Springs solve <code className="pc-mono">--spring-stiffness</code> 260 /{' '}
        <code className="pc-mono">--spring-damping</code> 24 and resolve to{' '}
        <code className="pc-mono">{supportsLinearEasing() ? 'a sampled linear() easing' : '--ease-spring-settle'}</code>:{' '}
        <code className="pc-mono break-all text-text-faint">{springEasing().slice(0, 96)}</code>
      </p>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Recipe
          id="motion-bloom"
          name="Bloom"
          tokens="--duration-warm-up · --ease-out"
          model="A light coming on goes 20% past its resting glow and settles. The bloom is the element's own recipe turned up — the engine never invents a glow."
          onPlay={() => bloom(bloomRef.current)}
        >
          <span ref={bloomRef} className="pc-window is-reading h-[26px] w-[20px]" aria-hidden />
        </Recipe>

        <Recipe
          id="motion-dim"
          name="Dim"
          tokens="--duration-dim · --ease-in"
          model="A light going out lingers a beat, then goes. Slower than the bloom on purpose: channels empty more gently than they fill."
          onPlay={() => dim(dimRef.current)}
        >
          <span ref={dimRef} className="pc-window is-talking h-[26px] w-[20px]" aria-hidden />
        </Recipe>

        <Recipe
          id="motion-flicker"
          name="Flicker"
          tokens="two 40ms pulses · --ease-out"
          model="Reading light flickers once when a message lands. This is the only thing in the product that flickers, and it means one thing."
          onPlay={() => flicker(flickerRef.current)}
        >
          <span ref={flickerRef} className="pc-window is-reading h-[26px] w-[20px]" aria-hidden />
        </Recipe>

        <Recipe
          id="motion-settle"
          name="Settle"
          tokens="--duration-move · spring-settle"
          model="A plate entering the street rises 14px with one small overshoot. The same curve carries shared elements and sliding indicators."
          onPlay={() => settleIn(settleRef.current)}
        >
          <div
            ref={settleRef}
            className="flex h-16 w-40 items-center justify-center rounded-[var(--radius-card)] bg-bg-raised shadow-[var(--shadow-raised)]"
          >
            <span className="text-meta text-text-secondary">A plate</span>
          </div>
        </Recipe>

        <Recipe
          id="motion-press"
          name="Press"
          tokens="0.96 · 80ms · spring-settle · --bg-mod-subtle"
          model="Controls are tactile: hover lifts 1px and takes a faint wash, and the thing you press gives way under the finger and springs back. It answers on the same frame as the pointer. The left one is the engine's recipe, called by hand — the composer's send control uses it. The right one is `.pc-pressable`, which every Button, IconButton, NavRow and Chip in the product carries: hover it and press it rather than replaying it."
          onPlay={() => press(pressRef.current)}
        >
          <div className="flex items-center gap-3">
            <button
              ref={pressRef}
              type="button"
              onPointerDown={() => press(pressRef.current)}
              className="pc-focusable inline-flex h-8 items-center rounded-[var(--radius-control)] bg-accent-primary px-3 text-label font-semibold text-text-on-accent"
            >
              Join
            </button>
            <Button variant="primary" size="sm" data-motion-pressable>
              Join
            </Button>
          </div>
        </Recipe>

        <Recipe
          id="motion-stagger"
          name="Stagger"
          tokens="--stagger-light 30ms"
          model="Neighbouring lights are 30ms apart, so a server comes on as a sequence rather than a switch."
          onPlay={() => stagger(staggerRef.current?.querySelectorAll('span') ?? [])}
        >
          <div ref={staggerRef} className="flex gap-1.5" aria-hidden>
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <span key={index} className="pc-window is-reading h-[26px] w-[20px]" />
            ))}
          </div>
        </Recipe>

        <Recipe
          id="motion-roll"
          name="Roll"
          tokens="--duration-roll 180ms"
          model="Any count that changes flips: old up and out, new up and in. It only ever moves on a change — a number that is merely rendered has not been caused by anybody."
          onPlay={() => setRolled((value) => value + 1)}
        >
          <span className="pc-display text-title text-text-primary">
            <RollingNumber value={rolled} format={(count) => `${count} here`} />
          </span>
        </Recipe>

        <Recipe
          id="motion-reorder"
          name="List reorder"
          tokens="--duration-move · spring-settle"
          model="A list that changes order animates layout: every row travels to its new place on the same curve a plate settles on, so the row you were reaching for is somewhere you watched it go. Nothing moves on the first paint."
          onPlay={() => setOrder((rows) => [rows[rows.length - 1], ...rows.slice(0, -1)])}
        >
          <div ref={reorderRef} className="flex w-full flex-col gap-1.5">
            {order.map((row) => (
              <div
                key={row}
                data-flip-key={row}
                className="flex h-7 items-center rounded-[var(--radius-control)] bg-bg-raised px-2.5 text-meta text-text-secondary shadow-[var(--shadow-chip)]"
              >
                {row}
              </div>
            ))}
          </div>
        </Recipe>

        <Recipe
          id="motion-pop"
          name="Reaction pop"
          tokens="0.6 / 0.8 · spring-settle · --duration-fast out"
          model="A reaction lands, it does not slide in. Yours pops 0.6 to 1 and the emoji over-rotates 8° on the way; somebody else's pops smaller at 0.8. Removing fades the chip and shrinks it back out the way it came — replay again to see the leave. The row under a real message is this exact hook."
          onPlay={() => setPopped((value) => !value)}
        >
          <div ref={popRef} className="flex flex-wrap items-center gap-1.5">
            <Chip data-flip-key="seed" className="gap-1.5 px-2.5">
              <span data-flip-glyph>🔥</span>
              <span className="font-medium">2</span>
            </Chip>
            {popped && (
              <>
                <Chip data-flip-key="mine" data-flip-own className="gap-1.5 bg-accent-tint px-2.5 text-accent-primary">
                  <span data-flip-glyph>👍</span>
                  <span className="font-medium">1</span>
                </Chip>
                <Chip data-flip-key="theirs" className="gap-1.5 px-2.5">
                  <span data-flip-glyph>🎉</span>
                  <span className="font-medium">3</span>
                </Chip>
              </>
            )}
          </div>
        </Recipe>

        <Recipe
          id="motion-writing"
          name="Writing pulse"
          tokens="--duration-breathe · --glow-window-amber-breathe"
          model="While somebody writes in the channel, its window breathes at half the speaking ring's amplitude — presence, not an alert. The pulse holds while typing refreshes and ends when typing stops; under reduced motion the window is simply lit."
          onPlay={() => {
            if (writingTimer.current) clearTimeout(writingTimer.current);
            setWriting(true);
            // Two breaths, then it stops — the way an 8s typing window closes.
            writingTimer.current = setTimeout(() => setWriting(false), 3300);
          }}
        >
          <span className="flex items-center gap-4">
            <span className={cn('pc-window-breath', writing && 'is-writing')} aria-hidden>
              <span
                className={cn('pc-window is-reading h-[26px] w-[20px]', writing && 'is-writing')}
                aria-hidden
              />
            </span>
            <span className="pc-typing-dots" aria-hidden>
              <span />
              <span />
              <span />
            </span>
          </span>
        </Recipe>

        <Recipe
          id="motion-plate"
          name="Contextual plate"
          tokens="--duration-move · spring-settle in · --duration-fast ease-in out"
          model="A pane slides in from the edge it opens against and slides back the way it came. The surface stays mounted for the 120ms the leave takes and is scenery the whole way — the desktop right rail and the profile card run on this."
          onPlay={() => setPlateOpen((value) => !value)}
        >
          <div className="relative h-24 w-full overflow-hidden rounded-[var(--radius-well)] bg-bg-base">
            {platePresence.mounted && (
              <div
                className={cn(
                  'absolute right-0 top-0 h-full w-2/5 rounded-l-[var(--radius-card)] bg-bg-plate shadow-[var(--shadow-plate)]',
                  platePresence.exiting ? 'pc-drawer-out-right' : 'pc-drawer-in-right',
                )}
                {...platePresence.scenery}
              />
            )}
          </div>
        </Recipe>

        <Recipe
          id="motion-voice"
          name="The ring takes the voice"
          tokens="--voice-level · 60ms / 240ms"
          model="Speaking is a breath, and where the engine knows how loud, the breath takes the voice: +15% of the resting glow at full voice, 60ms to reach it and 240ms to let go. One rAF loop writes one custom property for every tile on screen — never React state, never a loop per face."
          onPlay={() => setSpeaking((value) => value + 1)}
        >
          <SpeakingRingDemo take={speaking} />
        </Recipe>

        <Recipe
          id="motion-outage"
          name="The power goes"
          tokens="--duration-dim · --ease-in / --ease-out"
          model="A gateway that is away is drawn on the whole server: it dims 30% and holds there until it is back. Never a spinner — a spinner says wait; going dark says what is true."
          onPlay={cutPower}
        >
          <span className="text-meta text-text-faint">
            {dark ? 'The lights are out. Replay brings them back.' : 'The lights are on.'}
          </span>
        </Recipe>

        <div
          id="motion-lights-change"
          className="flex min-w-0 flex-col gap-3 rounded-[var(--radius-card)] bg-bg-well p-4 shadow-[var(--shadow-well)]"
        >
          <div className="flex items-baseline gap-2">
            <span className="pc-display text-name text-text-primary">The lights change</span>
            <code className="pc-mono ml-auto shrink-0 text-meta text-text-faint">--duration-dim</code>
          </div>
          <div className="flex min-h-[5.5rem] items-center justify-center">
            <span className="text-meta text-text-faint">
              Currently {themeOf === 'light' ? 'Daylight' : 'Night'}.
            </span>
          </div>
          <p className="text-meta leading-relaxed text-text-faint">
            Changing the theme is the lights changing: the whole shell crosses over
            <code className="pc-mono"> --duration-dim</code>, and the windows, lamps and rims
            re-bloom once the new ground has settled. View Transitions where the webview has
            them, a crossfade everywhere else.{' '}
            {lightsEngine && <span className="text-text-secondary">Last run: {lightsEngine}.</span>}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => swapTheme()}>
              Change the lights
            </Button>
            <Button variant="ghost" size="sm" onClick={() => swapTheme('crossfade')}>
              Change the lights (crossfade)
            </Button>
          </div>
        </div>

        <div
          id="motion-shared"
          className="flex min-w-0 flex-col gap-3 rounded-[var(--radius-card)] bg-bg-well p-4 shadow-[var(--shadow-well)] sm:col-span-2"
        >
          <div className="flex items-baseline gap-2">
            <span className="pc-display text-name text-text-primary">Shared element</span>
            <code className="pc-mono ml-auto shrink-0 text-meta text-text-faint">
              --duration-move · spring-settle · --stagger-chrome
            </code>
          </div>
          <div ref={stageRef} className="relative min-h-[9rem] overflow-hidden rounded-[var(--radius-well)] bg-bg-base p-3">
            {walkedIn ? (
              <div className="flex flex-col gap-2">
                <div
                  data-motion-shared="tokens-room"
                  className="h-20 w-full rounded-[var(--radius-card)] bg-bg-raised shadow-[var(--ring-lit-plate)]"
                />
                <div data-motion-chrome className="flex gap-2">
                  {[0, 1, 2].map((index) => (
                    <span key={index} className="h-5 flex-1 rounded-[var(--radius-window)] bg-bg-raised" />
                  ))}
                </div>
                <div data-motion-chrome className="h-7 w-24 self-center rounded-[var(--radius-control)] bg-bg-raised" />
              </div>
            ) : (
              <div className="flex gap-2">
                <div
                  data-motion-shared="tokens-room"
                  className="h-24 w-28 rounded-[var(--radius-card)] bg-bg-raised shadow-[var(--ring-lit-plate)]"
                />
                <div className="h-24 flex-1 rounded-[var(--radius-card)] bg-bg-plate" />
              </div>
            )}
          </div>
          <p className="text-meta leading-relaxed text-text-faint">
            The thing you click becomes the thing you look at: the lit card moves from the Lobby to
            the Stage and the supporting chrome rises 80ms later, staggered. View Transitions where
            the webview has them, a Web Animations FLIP everywhere else — the same choreography on
            both, which is why both buttons are here.{' '}
            {engine && <span className="text-text-secondary">Last run: {engine}.</span>}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => walk()}>
              {walkedIn ? 'Back to the Lobby' : 'Walk into the channel'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => walk('flip')}>
              {walkedIn ? 'Back to the Lobby (FLIP)' : 'Walk into the channel (FLIP)'}
            </Button>
          </div>
        </div>
      </div>
    </Section>
  );
}

export default function DesignTokensPage() {
  return (
    <div className="h-full overflow-y-auto bg-bg-base">
      <div className="mx-auto flex max-w-[76rem] flex-col gap-12 px-6 py-10">
        <header className="flex flex-col gap-2">
          <p className="text-section text-text-faint">Dev only · docs/lantern-stage-spec.md</p>
          <h1 className="pc-display text-display text-text-primary">Lantern Stage tokens</h1>
          <p className="max-w-[70ch] text-text-body">
            Windows at night, and light means people. Everything that is not light is dark, matte
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
                  Shop floor — 3 talking, 5 here
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

        <MotionSection />

        <PrimitivesSection />

        <LightComponentsSection />

        <BuildingsColumnSection />

        <Section
          id="themes"
          title="Themes"
          blurb="Themes remap the tokens, never the recipes. The light tokens are remapped in every theme, never removed: in Daylight they become ink so a lit channel still reads as presence on paper."
        >
          <div className="flex flex-wrap gap-4">
            <ThemePreview theme="dark" label="Night — the default" />
            <ThemePreview theme="light" label="Daylight" />
            <ThemePreview theme="amoled" label="AMOLED" />
            <ThemePreview theme="high-contrast" label="High contrast" />
            <ThemePreview theme="dusk" label="Dusk sky — a look" />
            <ThemePreview theme="paper" label="Paper & ink — a look" />
            <ThemePreview theme="slate" label="Slate — the default look" />
            <ThemePreview theme="voices" label="Aubergine — a look" />
          </div>
        </Section>
      </div>
    </div>
  );
}
