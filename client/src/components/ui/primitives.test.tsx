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
 * There is one rule no primitive may break: **no literal colour**. The final
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

  it('Raised uses the lifted shadow only when asked', () => {
    const { container, rerender } = render(<Raised>row</Raised>);
    expect(container.firstElementChild?.className).toContain('var(--shadow-raised)');
    rerender(<Raised lifted>row</Raised>);
    expect(container.firstElementChild?.className).toContain('var(--shadow-lifted)');
  });
});

describe('Button', () => {
  it('defaults to the emerald primary action', () => {
    render(<Button>Join</Button>);
    expect(screen.getByRole('button', { name: 'Join' })).toHaveClass('bg-accent-primary');
  });

  it('the light variant is a white-light fill with ink text', () => {
    render(<Button variant="light">Join</Button>);
    const btn = screen.getByRole('button', { name: 'Join' });
    expect(btn).toHaveClass('bg-light-white');
    expect(btn).toHaveClass('text-text-on-light');
  });

  it('danger is the danger well carrying danger ink, never a red fill', () => {
    render(<Button variant="danger">Leave</Button>);
    const btn = screen.getByRole('button', { name: 'Leave' });
    expect(btn).toHaveClass('bg-danger-well');
    expect(btn).toHaveClass('text-accent-danger');
  });

  it('sizes map onto the spec control heights (28 / 32 / 44)', () => {
    const { rerender } = render(<Button size="sm">a</Button>);
    expect(screen.getByRole('button').className).toContain('var(--h-control-sm)');
    rerender(<Button size="md">a</Button>);
    expect(screen.getByRole('button').className).toContain('var(--h-control)');
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
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveClass('bg-bg-raised');
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
});

describe('Chip', () => {
  it('renders neutral by default', () => {
    render(<Chip>3</Chip>);
    expect(screen.getByText('3')).toHaveClass('text-text-secondary');
  });

  it('light tones map to the two light tokens', () => {
    const { rerender } = render(<Chip tone="talking">3 talking</Chip>);
    expect(screen.getByText('3 talking')).toHaveClass('text-light-white');
    rerender(<Chip tone="reading">5 reading</Chip>);
    expect(screen.getByText('5 reading')).toHaveClass('text-light-amber');
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
    // The row you are on is the selection wash, which a server's own colour can
    // take over (`--row-selected`), not a fixed grey step.
    expect(row).toHaveClass('bg-[var(--row-selected)]');
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
  it('is sentence case — it never uppercases its own text (§6.8)', () => {
    const { container } = render(<SectionLabel meta="24 in">Kestrel Robotics</SectionLabel>);
    expect(screen.getByText('Kestrel Robotics')).toBeInTheDocument();
    expect(container.firstElementChild?.className).not.toContain('uppercase');
    expect(screen.getByText('24 in')).toBeInTheDocument();
  });
});

describe('Kbd', () => {
  it('renders a kbd element in the meta face', () => {
    const { container } = render(<Kbd>⌘K</Kbd>);
    const kbd = container.querySelector('kbd')!;
    expect(kbd).toHaveClass('pc-mono');
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

  it('SearchWell is a well with an accessible name and a shortcut hint', () => {
    const { container } = render(<SearchWell shortcut={<Kbd>⌘K</Kbd>} />);
    expect(container.firstElementChild).toHaveClass('pc-well');
    expect(screen.getByLabelText('Search')).toBeInTheDocument();
    expect(screen.getByText('⌘K')).toBeInTheDocument();
  });
});

describe('Divider', () => {
  it('renders a hairline rule', () => {
    const { container } = render(<Divider />);
    expect(container.querySelector('hr')).toHaveClass('bg-border-subtle');
  });

  it('renders a labelled separator', () => {
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
    expect(screen.getByRole('menuitem', { name: 'Leave' })).toHaveClass('text-accent-danger');
  });
});

describe('presence is light, never a coloured dot (§1.5)', () => {
  it('maps every status onto a rim, a matte, and a text equivalent', () => {
    expect(presenceLight('online')).toMatchObject({ lit: true, avatarClass: 'pc-lit', label: 'Lights on' });
    expect(presenceLight('streaming')).toMatchObject({ lit: true, live: true });
    expect(presenceLight('idle')).toMatchObject({ dim: true, avatarClass: 'pc-dim', label: 'Away' });
    expect(presenceLight('dnd')).toMatchObject({ dim: true, dnd: true });
    expect(presenceLight('offline')).toMatchObject({ dim: true, label: 'Lights off' });
    expect(presenceLight(undefined).label).toBe('Lights off');
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

  it('off is a well, on is the emerald — never a light token (§6.3)', () => {
    const { rerender } = render(<Switch checked={false} onChange={() => {}} label="a" />);
    expect(screen.getByRole('switch')).toHaveClass('bg-bg-well');
    rerender(<Switch checked onChange={() => {}} label="a" />);
    const on = screen.getByRole('switch');
    expect(on).toHaveClass('bg-accent-primary');
    expect(on.className).not.toContain('light-white');
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

  it('selection is a raised surface, never an accent bar', () => {
    render(<Tabs items={TAB_ITEMS} value="general" onChange={() => {}} label="Server settings" />);
    // The raised surface is ONE element the engine slides between the tabs
    // (§5.1 "the indicator slides, never jumps"), so it is the indicator that
    // carries the raised recipe — and no tab carries a fill of its own.
    const list = screen.getByRole('tablist', { name: 'Server settings' });
    const indicator = list.querySelector('[aria-hidden="true"]');
    expect(indicator).toHaveClass('bg-bg-raised');
    expect(screen.getByRole('tab', { name: 'General' })).not.toHaveClass('bg-accent-primary');
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
  it('is one plate carrying a named index and the selected section', () => {
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
    expect(container.firstElementChild).toHaveClass('pc-plate');
    const index = screen.getByRole('navigation', { name: 'User settings' });
    expect(within(index).getByRole('button', { name: 'Voice and video' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('heading', { name: 'Voice and video' })).toBeInTheDocument();
  });

  it('section labels stay sentence case (§6.8)', () => {
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
    expect(screen.getByText('Preferences').className).not.toContain('uppercase');
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

describe('no primitive hard-codes a colour', () => {
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
    // Arbitrary Tailwind values reference tokens (var(--…)); a raw colour never appears.
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(markup).not.toMatch(/\brgba?\(\s*\d/);
  });
});
