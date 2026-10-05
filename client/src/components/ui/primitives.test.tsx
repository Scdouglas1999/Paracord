import { describe, expect, it, vi } from 'vitest';
import { createRef, useRef, useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Plate, Lamp } from './Plate';
import { Well, Raised } from './Well';
import { Button } from './Button';
import { IconButton } from './IconButton';
import { Chip } from './Chip';
import { NavRow } from './NavRow';
import { SectionLabel } from './SectionLabel';
import { Kbd } from './Kbd';
import { TextField, SearchWell } from './TextField';
import { Divider } from './Divider';
import { Popover, MenuItem, MenuLabel } from './Popover';
import { Switch, ToggleRow } from './Switch';
import { Tabs } from './Tabs';
import { SettingsShell, SettingsSectionHeader } from './SettingsShell';
import { presenceLight } from '../../lib/presence';

/**
 * The primitives carry the design contract, so these assert the contract, not
 * the markup: the right recipe class, the right token-driven height, and the
 * accessibility guarantees from spec §9 (a name on every control, a text
 * equivalent for every light state).
 *
 * There is one rule no primitive may break: **no literal color**. The final
 * test walks every rendered element and fails on a raw hex or rgb() value.
 */

describe('Plate', () => {
  it('renders the plate recipe and no lit ring by default', () => {
    const { container } = render(<Plate data-testid="p">content</Plate>);
    const plate = container.firstElementChild!;
    expect(plate).toHaveClass('pc-plate');
    expect(plate).not.toHaveClass('is-lit');
  });

  it('adds the lit ring only when its room is live', () => {
    const { container } = render(<Plate lit>content</Plate>);
    expect(container.firstElementChild).toHaveClass('is-lit');
  });

  it('renders as the requested element so the tag can carry the semantics', () => {
    const { container } = render(<Plate as="aside">nav</Plate>);
    expect(container.querySelector('aside')).not.toBeNull();
  });

  it('Lamp is decorative and hidden from assistive tech', () => {
    const { container } = render(<Lamp />);
    const lamp = container.firstElementChild!;
    expect(lamp).toHaveClass('pc-lamp');
    expect(lamp).toHaveAttribute('aria-hidden');
  });
});

describe('Well and Raised', () => {
  it('Well renders the recessed recipe', () => {
    const { container } = render(<Well>search</Well>);
    expect(container.firstElementChild).toHaveClass('pc-well');
  });

  it('Raised is the quiet control fill and takes the room card shadow only when lifted', () => {
    const { container, rerender } = render(<Raised>row</Raised>);
    expect(container.firstElementChild?.className).toContain('bg-[var(--ix-fill-ctl)]');
    expect(container.firstElementChild?.className).not.toContain('shadow');
    rerender(<Raised lifted>row</Raised>);
    expect(container.firstElementChild?.className).toContain('shadow-[var(--ix-shadow-room)]');
  });
});

describe('Button', () => {
  it('defaults to the cream primary action (Join), one step lighter on hover and darker on press', () => {
    render(<Button>Join</Button>);
    const btn = screen.getByRole('button', { name: 'Join' });
    expect(btn).toHaveClass('bg-accent-primary', 'text-text-on-accent');
    expect(btn).toHaveClass('hover:bg-accent-primary-hover', 'active:bg-accent-primary-active');
  });

  it('the light variant is the same cream fill (`--light-white` is `--join`), not a second look', () => {
    render(<Button variant="light">Join</Button>);
    const btn = screen.getByRole('button', { name: 'Join' });
    expect(btn).toHaveClass('bg-light-white');
    expect(btn).toHaveClass('text-text-on-light');
    expect(btn).toHaveClass('hover:bg-accent-primary-hover', 'active:bg-accent-primary-active');
  });

  it('nothing scales on press, in any variant or size (§9)', () => {
    const variants = ['primary', 'light', 'ghost', 'glass', 'danger', 'default', 'destructive', 'secondary', 'outline', 'link'] as const;
    const sizes = ['sm', 'md', 'lg', 'icon', 'icon-lg', 'default'] as const;
    for (const variant of variants) {
      for (const size of sizes) {
        const { unmount } = render(
          <Button variant={variant} size={size}>
            x
          </Button>,
        );
        const cls = screen.getByRole('button').className;
        expect(cls, `${variant}/${size}`).not.toMatch(/scale|pc-pressable|brightness/);
        unmount();
      }
    }
  });

  it('ghost is a text decision and glass is the quiet control fill (radius 11)', () => {
    const { rerender } = render(<Button variant="ghost">Cancel</Button>);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveClass('bg-transparent', 'hover:bg-[var(--ix-fill)]', 'rounded-[11px]');
    rerender(<Button variant="glass">Upload</Button>);
    expect(screen.getByRole('button', { name: 'Upload' })).toHaveClass('bg-[var(--ix-fill-ctl)]', 'hover:bg-[var(--ix-fill-ctl-hover)]', 'rounded-[11px]');
  });

  it('danger is the danger fill carrying the danger ink, never a red fill and never cream', () => {
    render(<Button variant="danger">Leave</Button>);
    const btn = screen.getByRole('button', { name: 'Leave' });
    expect(btn).toHaveClass('bg-[var(--ix-danger-fill)]');
    expect(btn).toHaveClass('text-[var(--ix-danger-ink)]');
    expect(btn.className).not.toContain('accent-primary');
  });

  it('the cream action is 36 tall at radius 11 and 14/700', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveClass('h-9', 'rounded-[11px]', 'text-[14px]', 'font-bold');
  });

  it('sizes are 32 / 36 / 44', () => {
    const { rerender } = render(<Button size="sm">a</Button>);
    expect(screen.getByRole('button')).toHaveClass('h-8');
    rerender(<Button size="md">a</Button>);
    expect(screen.getByRole('button')).toHaveClass('h-9');
    rerender(<Button size="lg">a</Button>);
    expect(screen.getByRole('button').className).toContain('var(--h-control-phone)');
  });

  it('is disabled and non-interactive while loading', async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    await userEvent.click(btn).catch(() => undefined);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('keeps the legacy variant names building', () => {
    render(<Button variant="secondary">Cancel</Button>);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveClass('bg-[var(--ix-fill-ctl)]');
  });
});

describe('IconButton', () => {
  it('always has an accessible name (§9: an icon is not a label)', () => {
    render(<IconButton label="Mute microphone">M</IconButton>);
    expect(screen.getByRole('button', { name: 'Mute microphone' })).toBeInTheDocument();
  });

  it('exposes pressed state', () => {
    render(
      <IconButton label="Mute" active>
        M
      </IconButton>,
    );
    expect(screen.getByRole('button', { name: 'Mute' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('the stage size uses the 46px control token', () => {
    render(
      <IconButton label="Share" size="stage">
        S
      </IconButton>,
    );
    expect(screen.getByRole('button').className).toContain('var(--h-stage-control)');
  });

  it('carries the focus-ring recipe', () => {
    render(<IconButton label="More">…</IconButton>);
    expect(screen.getByRole('button')).toHaveClass('pc-focusable');
  });

  it('is a 36px tile at radius 11 that never scales, with a control fill for the raised look', () => {
    render(
      <IconButton label="Close" tone="raised">
        x
      </IconButton>,
    );
    const cls = screen.getByRole('button').className;
    expect(cls).toContain('rounded-[11px]');
    expect(cls).toContain('bg-[var(--ix-fill-ctl)]');
    expect(cls).not.toMatch(/scale|pc-pressable|brightness/);
  });

  it('a call control is a circle', () => {
    render(
      <IconButton label="Share" size="stage">
        S
      </IconButton>,
    );
    expect(screen.getByRole('button').className).toContain('rounded-full');
  });
});

describe('Chip', () => {
  it('renders neutral by default: the quiet fill at radius 8 in ink-2', () => {
    render(<Chip>3</Chip>);
    expect(screen.getByText('3')).toHaveClass('text-[var(--ix-ink-2)]', 'bg-[var(--ix-fill)]', 'rounded-[8px]');
  });

  it('live tones are amber and the danger tone is the one danger ink', () => {
    const { rerender } = render(<Chip tone="talking">3 talking</Chip>);
    expect(screen.getByText('3 talking')).toHaveClass('text-[var(--ix-amber)]');
    rerender(<Chip tone="reading">5 here</Chip>);
    expect(screen.getByText('5 here')).toHaveClass('text-[var(--ix-amber)]');
    rerender(<Chip tone="danger">2</Chip>);
    expect(screen.getByText('2')).toHaveClass('text-[var(--ix-danger-ink)]');
  });

  it('becomes a real button when asked', () => {
    render(
      <Chip as="button" onClick={() => {}}>
        Filter
      </Chip>,
    );
    expect(screen.getByRole('button', { name: 'Filter' })).toBeInTheDocument();
  });
});

describe('NavRow', () => {
  it('renders a button by default and a link when href is given', () => {
    const { rerender } = render(<NavRow>Home</NavRow>);
    expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument();
    rerender(<NavRow href="/app">Home</NavRow>);
    expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
  });

  it('marks the active row for assistive tech, not just visually', () => {
    render(<NavRow active>Shop floor</NavRow>);
    const row = screen.getByRole('button', { name: 'Shop floor' });
    expect(row).toHaveAttribute('aria-current', 'page');
    // The row you are on wears the hue selection (the place's `--ix-hue`), not a
    // fixed gray step and not an accent bar.
    expect(row).toHaveClass('ix-hue-selected');
  });

  it('uses the 34px nav-row height token', () => {
    render(<NavRow>Home</NavRow>);
    expect(screen.getByRole('button').className).toContain('var(--h-nav-row)');
  });

  it('renders trailing content', () => {
    render(<NavRow trailing={<Chip>3</Chip>}>Home</NavRow>);
    expect(within(screen.getByRole('button')).getByText('3')).toBeInTheDocument();
  });
});

describe('SectionLabel', () => {
  it('is 12.5/600 sentence case in the tertiary ink, never an uppercase kicker', () => {
    const { container } = render(<SectionLabel meta="24 in">Coming up</SectionLabel>);
    expect(screen.getByText('Coming up')).toBeInTheDocument();
    const label = container.firstElementChild!;
    expect(label).toHaveClass('text-[12.5px]', 'font-semibold', 'text-[var(--ix-ink-3)]');
    expect(label.className).not.toMatch(/uppercase|glass-kicker/);
    expect(screen.getByText('24 in')).toHaveClass('tabular-nums');
  });
});

describe('Kbd', () => {
  it('renders a kbd element: 11/500 tabular on a hairline key cap', () => {
    const { container } = render(<Kbd>⌘K</Kbd>);
    const kbd = container.querySelector('kbd')!;
    expect(kbd).toHaveClass('tabular-nums', 'text-[11px]');
    expect(kbd).toHaveTextContent('⌘K');
  });
});

describe('TextField and SearchWell', () => {
  it('wires the label to the input', () => {
    render(<TextField label="Room name" />);
    expect(screen.getByLabelText('Room name')).toBeInTheDocument();
  });

  it('keeps the label for assistive tech when hidden', () => {
    render(<TextField label="Room name" hideLabel />);
    expect(screen.getByLabelText('Room name')).toBeInTheDocument();
  });

  it('announces the error and links it to the field', () => {
    render(<TextField label="Room name" error="That name is taken" />);
    const input = screen.getByLabelText('Room name');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.getAttribute('aria-describedby')).toBe(
      screen.getByText('That name is taken').id,
    );
  });

  it('accepts typing', async () => {
    render(<TextField label="Room name" />);
    await userEvent.type(screen.getByLabelText('Room name'), 'Shop floor');
    expect(screen.getByLabelText('Room name')).toHaveValue('Shop floor');
  });

  it('SearchWell is a field with an accessible name and a shortcut hint', () => {
    const { container } = render(<SearchWell shortcut={<Kbd>⌘K</Kbd>} />);
    expect(container.firstElementChild).toHaveClass('pc-field');
    expect(screen.getByLabelText('Search')).toBeInTheDocument();
    expect(screen.getByText('⌘K')).toBeInTheDocument();
  });
});

describe('Divider', () => {
  it('renders a hairline rule', () => {
    const { container } = render(<Divider />);
    expect(container.querySelector('hr')).toHaveClass('bg-[var(--ix-line)]');
  });

  it('renders a labeled separator', () => {
    render(<Divider label="Today" />);
    expect(screen.getByRole('separator')).toHaveTextContent('Today');
  });
});

function PopoverHarness({ onClose }: { onClose?: () => void }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={anchor} type="button" onClick={() => setOpen((v) => !v)}>
        Open
      </button>
      <Popover
        anchor={anchor}
        open={open}
        onClose={() => {
          setOpen(false);
          onClose?.();
        }}
        role="menu"
        label="Channel actions"
      >
        <MenuLabel>Room</MenuLabel>
        <MenuItem onClick={() => {}}>Invite</MenuItem>
        <MenuItem danger onClick={() => {}}>
          Leave
        </MenuItem>
      </Popover>
    </>
  );
}

describe('Popover', () => {
  it('renders nothing while closed', () => {
    render(<PopoverHarness />);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens onto the floating surface with an accessible name', async () => {
    render(<PopoverHarness />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const menu = screen.getByRole('menu', { name: 'Channel actions' });
    expect(menu).toHaveClass('pc-floating');
    expect(within(menu).getByRole('menuitem', { name: 'Invite' })).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    render(<PopoverHarness onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on a click outside', async () => {
    render(
      <div>
        <PopoverHarness />
        <button type="button">Elsewhere</button>
      </div>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('a destructive item takes danger ink, not a red fill', async () => {
    render(<PopoverHarness />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('menuitem', { name: 'Leave' })).toHaveClass('text-[var(--ix-danger-ink)]');
  });
});

describe('presence is light, never a colored dot (§1.5)', () => {
  it('maps every status onto a rim, a matte, and a text equivalent', () => {
    expect(presenceLight('online')).toMatchObject({ lit: true, avatarClass: 'pc-lit', label: 'Online' });
    expect(presenceLight('streaming')).toMatchObject({ lit: true, live: true });
    expect(presenceLight('idle')).toMatchObject({ dim: true, avatarClass: 'pc-dim', label: 'Away' });
    expect(presenceLight('dnd')).toMatchObject({ dim: true, dnd: true });
    expect(presenceLight('offline')).toMatchObject({ dim: true, label: 'Offline' });
    expect(presenceLight(undefined).label).toBe('Offline');
  });
});

describe('Switch', () => {
  it('exposes the boolean to assistive tech, not just to the eye', () => {
    render(<Switch checked={false} onChange={() => {}} label="Compact messages" />);
    const control = screen.getByRole('switch', { name: 'Compact messages' });
    expect(control).toHaveAttribute('aria-checked', 'false');
  });

  it('toggles to the opposite value', async () => {
    const onChange = vi.fn();
    render(<Switch checked onChange={onChange} label="Compact messages" />);
    await userEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('off is the quiet control fill, on is cream, and neither glows amber (amber means live)', () => {
    const { rerender, container } = render(<Switch checked={false} onChange={() => {}} label="a" />);
    expect(screen.getByRole('switch')).toHaveClass('bg-[var(--ix-fill-ctl-hover)]');
    rerender(<Switch checked onChange={() => {}} label="a" />);
    const on = screen.getByRole('switch');
    expect(on).toHaveClass('bg-accent-primary');
    expect(on.className).not.toContain('light-white');
    expect(container.innerHTML).not.toContain('thumb-glow');
  });

  it('ToggleRow names its switch from the row text', () => {
    render(
      <ToggleRow
        label="Play a sound for mentions"
        description="Only when the app is in the background."
        checked
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole('switch', { name: 'Play a sound for mentions' })).toBeInTheDocument();
  });
});

const TAB_ITEMS = [
  { value: 'general', label: 'General' },
  { value: 'roles', label: 'Roles', meta: '4' },
  { value: 'audit', label: 'Audit log' },
] as const;

describe('Tabs', () => {
  it('renders a named tablist with one selected tab', () => {
    render(<Tabs items={TAB_ITEMS} value="roles" onChange={() => {}} label="Server settings" />);
    const list = screen.getByRole('tablist', { name: 'Server settings' });
    expect(within(list).getByRole('tab', { name: /Roles/ })).toHaveAttribute('aria-selected', 'true');
    expect(within(list).getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'false');
  });

  it('selection is the lit fill on a segment, never an accent bar', () => {
    render(<Tabs items={TAB_ITEMS} value="general" onChange={() => {}} label="Server settings" />);
    // The selected pill is ONE element the engine slides between the tabs (it
    // slides, it never jumps), so it is the indicator that carries the fill,
    // and no tab carries a fill of its own.
    const list = screen.getByRole('tablist', { name: 'Server settings' });
    const indicator = list.querySelector('[aria-hidden="true"]');
    expect(indicator).toHaveClass('bg-[var(--ix-fill-2)]', 'rounded-[9px]');
    expect(screen.getByRole('tab', { name: 'General' })).not.toHaveClass('bg-accent-primary');
    expect(screen.getByRole('tab', { name: 'General' }).className).not.toMatch(/scale/);
  });

  it('the sliding indicator is marked on the selected tab only', () => {
    render(<Tabs items={TAB_ITEMS} value="roles" onChange={() => {}} label="Server settings" />);
    expect(screen.getByRole('tab', { name: /Roles/ })).toHaveAttribute('data-indicator-target');
    expect(screen.getByRole('tab', { name: 'General' })).not.toHaveAttribute(
      'data-indicator-target',
    );
  });

  it('moves between tabs with the arrow keys (WAI-ARIA tabs pattern)', async () => {
    const onChange = vi.fn();
    render(<Tabs items={TAB_ITEMS} value="general" onChange={onChange} label="Server settings" />);
    screen.getByRole('tab', { name: 'General' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('roles');
    await userEvent.keyboard('{End}');
    expect(onChange).toHaveBeenCalledWith('audit');
  });

  it('only the selected tab is in the tab order', () => {
    render(<Tabs items={TAB_ITEMS} value="audit" onChange={() => {}} label="Server settings" />);
    expect(screen.getByRole('tab', { name: 'Audit log' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('tabindex', '-1');
  });
});

const SETTINGS_GROUPS = [
  { items: [{ id: 'account', label: 'My account' }] },
  { label: 'Preferences', items: [{ id: 'voice', label: 'Voice and video' }] },
];

describe('SettingsShell', () => {
  it('is one full-window surface carrying a named index and the selected section', () => {
    const { container } = render(
      <SettingsShell
        label="User settings"
        title="Sam Douglas"
        groups={SETTINGS_GROUPS}
        active="voice"
        onSelect={() => {}}
        onClose={() => {}}
        closeLabel="Close user settings"
      >
        <SettingsSectionHeader title="Voice and video" description="Pick the microphone you use." />
      </SettingsShell>,
    );
    expect(container.firstElementChild).toHaveClass('ix-settings');
    const index = screen.getByRole('navigation', { name: 'User settings' });
    expect(within(index).getByRole('button', { name: 'Voice and video' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('heading', { name: 'Voice and video' })).toBeInTheDocument();
  });

  it('section labels are sentence case, never an uppercase kicker', () => {
    render(
      <SettingsShell
        label="User settings"
        title="Sam Douglas"
        groups={SETTINGS_GROUPS}
        active="account"
        onSelect={() => {}}
        onClose={() => {}}
        closeLabel="Close user settings"
      >
        content
      </SettingsShell>,
    );
    expect(screen.getByText('Preferences').parentElement?.className).not.toMatch(/glass-kicker|uppercase/);
    expect(screen.getByText('Preferences').parentElement).toHaveClass('text-[12.5px]');
  });

  it('selects a section from the index', async () => {
    const onSelect = vi.fn();
    render(
      <SettingsShell
        label="User settings"
        title="Sam Douglas"
        groups={SETTINGS_GROUPS}
        active="account"
        onSelect={onSelect}
        onClose={() => {}}
        closeLabel="Close user settings"
      >
        content
      </SettingsShell>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Voice and video' }));
    expect(onSelect).toHaveBeenCalledWith('voice');
  });

  it('on a phone the index and the content are two screens', async () => {
    const onShowIndex = vi.fn();
    const { rerender } = render(
      <SettingsShell
        label="User settings"
        title="Sam Douglas"
        groups={SETTINGS_GROUPS}
        active="account"
        onSelect={() => {}}
        onClose={() => {}}
        closeLabel="Close user settings"
        isMobile
        showIndex
        onShowIndex={onShowIndex}
      >
        content
      </SettingsShell>,
    );
    expect(screen.queryByText('content')).toBeNull();

    rerender(
      <SettingsShell
        label="User settings"
        title="Sam Douglas"
        groups={SETTINGS_GROUPS}
        active="account"
        onSelect={() => {}}
        onClose={() => {}}
        closeLabel="Close user settings"
        isMobile
        showIndex={false}
        onShowIndex={onShowIndex}
      >
        content
      </SettingsShell>,
    );
    expect(screen.getByText('content')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Back to the settings index' }));
    expect(onShowIndex).toHaveBeenCalledWith(true);
  });
});

describe('no primitive hard-codes a color', () => {
  it('renders every primitive without a literal hex or rgb value', () => {
    const ref = createRef<HTMLButtonElement>();
    const { container } = render(
      <Plate>
        <Lamp />
        <Well>
          <SearchWell shortcut={<Kbd>⌘K</Kbd>} />
        </Well>
        <Raised>raised</Raised>
        <SectionLabel meta="24 in">Kestrel Robotics</SectionLabel>
        <NavRow icon={<span />} trailing={<Chip tone="reading">5</Chip>}>
          build-log
        </NavRow>
        <Divider label="Today" />
        <Button variant="primary">Join</Button>
        <Button variant="light">Join</Button>
        <Button variant="ghost">Invite</Button>
        <Button variant="danger">Leave</Button>
        <IconButton ref={ref} label="More" tone="raised">
          …
        </IconButton>
        <TextField label="Room name" hint="Short and specific" />
        <Switch checked onChange={() => {}} label="Compact messages" />
        <Switch checked={false} onChange={() => {}} label="Quiet hours" />
        <ToggleRow label="Play a sound" checked onChange={() => {}} />
        <Tabs items={TAB_ITEMS} value="roles" onChange={() => {}} label="Server settings" />
        <Tabs
          items={TAB_ITEMS}
          value="roles"
          onChange={() => {}}
          label="Server settings, as pages"
          variant="underline"
        />
      </Plate>,
    );
    const markup = container.innerHTML;
    // Arbitrary Tailwind values reference tokens (var(--…)); a raw color never appears.
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(markup).not.toMatch(/\brgba?\(\s*\d/);
  });
});
