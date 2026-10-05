import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ContextMenu } from '../../../ui/ContextMenu';
import { IxMenu } from '../../menus/IxMenu';

// A phone (index-spec §9): menus are bottom action sheets.
vi.mock('./phoneLayout', () => ({ useIsPhone: () => true, usePhoneLandscape: () => false, isPhoneNow: () => true }));

describe('menus on a phone are action sheets', () => {
  it('the Index menu: a sheet at the foot with its rows, a scrim and Cancel; no anchor geometry', () => {
    const onClose = vi.fn();
    const choose = vi.fn();
    render(
      <IxMenu
        open
        onClose={onClose}
        anchor={{ x: 40, y: 60 }}
        label="Server options"
        entries={[
          { type: 'item', id: 'invite', label: 'Invite people', onSelect: choose },
          { type: 'item', id: 'settings', label: 'Settings', hint: 'Ctrl ,', onSelect: () => {} },
        ]}
      />,
    );
    const menu = screen.getByRole('menu', { name: 'Server options' });
    expect(menu).toHaveAttribute('data-presentation', 'sheet');
    expect(menu).toHaveClass('ix-menu--sheet');
    // Placed by CSS at the foot, not at the point that opened it.
    expect(menu.style.left).toBe('');
    expect(menu.style.top).toBe('');
    expect(document.querySelector('.ix-action-scrim')).not.toBeNull();
    // A shortcut is marked so a sheet can leave it out.
    expect(screen.getByText('Ctrl ,')).toHaveClass('ix-menu__hint--key');

    fireEvent.click(screen.getByRole('menuitem', { name: 'Invite people' }));
    expect(choose).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith('select');

    onClose.mockClear();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledWith('escape');
  });

  it('a tap on the scrim puts it away', () => {
    const onClose = vi.fn();
    render(<IxMenu open onClose={onClose} anchor={{ x: 0, y: 0 }} label="Channel" entries={[{ type: 'item', id: 'a', label: 'A', onSelect: () => {} }]} />);
    fireEvent.pointerDown(document.querySelector('.ix-action-scrim') as Element);
    expect(onClose).toHaveBeenCalledWith('outside');
  });

  it('the shared context menu (a row held down): the same sheet, with Cancel', () => {
    const onClose = vi.fn();
    const mute = vi.fn();
    render(<ContextMenu label="clips" position={{ x: 80, y: 300 }} onClose={onClose} items={[{ label: 'Mute channel', action: mute }]} />);
    const menu = screen.getByRole('menu', { name: 'clips' });
    expect(menu).toHaveAttribute('data-presentation', 'sheet');
    expect(menu).toHaveClass('ix-action-sheet');
    expect(menu.style.left).toBe('');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mute channel' }));
    expect(mute).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
