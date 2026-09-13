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
    expect(row).toHaveClass('bg-bg-raised');
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
        label="Room actions"
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
    const menu = screen.getByRole('menu', { name: 'Room actions' });
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
      </Plate>,
    );
    const markup = container.innerHTML;
    // Arbitrary Tailwind values reference tokens (var(--…)); a raw colour never appears.
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(markup).not.toMatch(/\brgba?\(\s*\d/);
  });
});
