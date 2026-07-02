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

  it('activates the highlighted item with Space', () => {
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
