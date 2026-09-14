import { createRef } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContextMenu, useContextMenu, type ContextMenuItem } from './ContextMenu';

describe('ContextMenu', () => {
  const defaultItems: ContextMenuItem[] = [
    { label: 'Copy', action: vi.fn() },
    { label: 'Edit', action: vi.fn() },
    { label: '', action: vi.fn(), divider: true },
    { label: 'Delete', action: vi.fn(), danger: true },
  ];

  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders all non-divider items as buttons', () => {
    render(
      <ContextMenu
        items={defaultItems}
        position={{ x: 100, y: 100 }}
        onClose={onClose}
      />
    );
    expect(screen.getByRole('menuitem', { name: /copy/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /edit/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /delete/i })).toBeInTheDocument();
  });

  it('renders a menu role', () => {
    render(
      <ContextMenu
        items={defaultItems}
        position={{ x: 100, y: 100 }}
        onClose={onClose}
      />
    );
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('calls action and onClose when item is clicked', () => {
    render(
      <ContextMenu
        items={defaultItems}
        position={{ x: 100, y: 100 }}
        onClose={onClose}
      />
    );
    fireEvent.click(screen.getByRole('menuitem', { name: /copy/i }));
    expect(defaultItems[0].action).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape key', () => {
    render(
      <ContextMenu
        items={defaultItems}
        position={{ x: 100, y: 100 }}
        onClose={onClose}
      />
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('focuses the menu container on mount for keyboard navigation', () => {
    render(
      <ContextMenu
        items={defaultItems}
        position={{ x: 100, y: 100 }}
        onClose={onClose}
      />
    );
    expect(screen.getByRole('menu')).toHaveFocus();
  });

  it('activates the highlighted item with Enter', () => {
    render(
      <ContextMenu
        items={defaultItems}
        position={{ x: 100, y: 100 }}
        onClose={onClose}
      />
    );
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(screen.getByRole('menu')).toHaveAttribute('aria-activedescendant', 'context-menu-item-0');
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(defaultItems[0].action).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('activates the highlighted item with Server', () => {
    render(
      <ContextMenu
        items={defaultItems}
        position={{ x: 100, y: 100 }}
        onClose={onClose}
      />
    );
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: ' ' });
    expect(defaultItems[0].action).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('skips disabled items and dividers during keyboard navigation', () => {
    const enabledAction = vi.fn();
    const disabledAction = vi.fn();
    const items: ContextMenuItem[] = [
      { label: 'Disabled', action: disabledAction, disabled: true },
      { label: '', action: vi.fn(), divider: true },
      { label: 'Enabled', action: enabledAction },
    ];
    render(
      <ContextMenu
        items={items}
        position={{ x: 100, y: 100 }}
        onClose={onClose}
      />
    );
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(screen.getByRole('menu')).toHaveAttribute('aria-activedescendant', 'context-menu-item-2');
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(disabledAction).not.toHaveBeenCalled();
    expect(enabledAction).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('does not call action for disabled items', () => {
    const items: ContextMenuItem[] = [
      { label: 'Disabled', action: vi.fn(), disabled: true },
    ];
    render(
      <ContextMenu
        items={items}
        position={{ x: 100, y: 100 }}
        onClose={onClose}
      />
    );
    fireEvent.click(screen.getByRole('menuitem', { name: /disabled/i }));
    expect(items[0].action).not.toHaveBeenCalled();
  });

  it('keeps the menu open for its own scrolling but closes on surrounding scroll', () => {
    render(<ContextMenu items={defaultItems} position={{ x: 100, y: 100 }} onClose={onClose} />);
    fireEvent.scroll(screen.getByRole('menu'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.scroll(document);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps an anchored header menu open when the timeline scrolls', () => {
    const anchor = createRef<HTMLButtonElement>();
    render(<><button ref={anchor}>Actions</button><ContextMenu anchorRef={anchor} items={defaultItems} position={{ x: 100, y: 100 }} onClose={onClose} /></>);
    fireEvent.scroll(document);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('supports Home and End across disabled items and exits on Tab', () => {
    render(<ContextMenu items={[...defaultItems, { label: 'Unavailable', disabled: true, action: vi.fn() }]} position={{ x: 100, y: 100 }} onClose={onClose} />);
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'End' });
    expect(menu).toHaveAttribute('aria-activedescendant', 'context-menu-item-3');
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(menu).toHaveAttribute('aria-activedescendant', 'context-menu-item-0');
    fireEvent.keyDown(menu, { key: 'Tab' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders icon when provided', () => {
    const items: ContextMenuItem[] = [
      { label: 'With Icon', icon: <span data-testid="icon">I</span>, action: vi.fn() },
    ];
    render(
      <ContextMenu
        items={items}
        position={{ x: 100, y: 100 }}
        onClose={onClose}
      />
    );
    expect(screen.getByTestId('icon')).toBeInTheDocument();
  });

  it('keeps one label column when only some rows carry an icon', () => {
    // "Follow the building" is the fourth choice of a four-way radio group and
    // the only one without an icon; it used to start 26px left of the three
    // above it, which reads as a row that has slipped out of its own menu.
    const items: ContextMenuItem[] = [
      { label: 'Every message', icon: <span data-testid="bell">B</span>, action: vi.fn(), selected: false },
      { label: 'Follow the server', action: vi.fn(), selected: true },
    ];
    render(
      <ContextMenu
        items={items}
        position={{ x: 100, y: 100 }}
        onClose={onClose}
      />
    );
    const rows = screen.getAllByRole('menuitemradio');
    const columns = rows.map((row) => row.querySelectorAll('span.h-4.w-4').length);
    expect(columns).toEqual([1, 1]);
  });

  it('leaves a menu with no icons at all flush', () => {
    render(
      <ContextMenu
        items={[{ label: 'Copy', action: vi.fn() }, { label: 'Paste', action: vi.fn() }]}
        position={{ x: 100, y: 100 }}
        onClose={onClose}
      />
    );
    for (const row of screen.getAllByRole('menuitem')) {
      expect(row.querySelectorAll('span.h-4.w-4')).toHaveLength(0);
    }
  });

  it('renders shortcut text when provided', () => {
    const items: ContextMenuItem[] = [
      { label: 'Save', action: vi.fn(), shortcut: 'Ctrl+S' },
    ];
    render(
      <ContextMenu
        items={items}
        position={{ x: 100, y: 100 }}
        onClose={onClose}
      />
    );
    expect(screen.getByText('Ctrl+S')).toBeInTheDocument();
  });
});

describe('useContextMenu', () => {
  it('starts closed', () => {
    let result: ReturnType<typeof useContextMenu> | undefined;
    function TestComponent() {
      result = useContextMenu();
      return null;
    }
    render(<TestComponent />);
    expect(result!.contextMenu.isOpen).toBe(false);
  });
});
