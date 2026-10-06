import { cleanup, fireEvent, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { serverPlace, type Place } from '../components/ix/shell/place';
import { useKeyboardNavigation } from './useKeyboardNavigation';

/**
 * Ctrl+Alt+Up/Down and Ctrl+1…9 (docs/index-spec.md §4.8, §10): the place
 * shortcuts of the dock. The order and navigation are the dock's own
 * (`usePlaceOrder`, `useGoToPlace`); this holds what the hook does with a key.
 */

const mocks = vi.hoisted(() => ({
  order: ['people', 'fuel', 'game', 'base'],
  place: { kind: 'server', guildId: 'fuel' } as Place,
  go: vi.fn(async () => {}),
  mac: false,
}));

vi.mock('../components/ix/shell/usePlace', () => ({
  usePlaceOrder: () => mocks.order,
  useCurrentPlace: () => mocks.place,
}));
vi.mock('../components/ix/shell/placeKeys', () => ({
  usePlaceKeys: () => ({ keys: { currentKey: (place: Place) => (place.kind === 'server' ? place.guildId : 'people') } }),
}));
vi.mock('../components/ix/dock/usePlaceNavigation', () => ({ useGoToPlace: () => mocks.go }));
vi.mock('../lib/keyboardShortcuts', () => ({ isMacOS: () => mocks.mac }));
vi.mock('./useGuilds', () => ({ useSelectedGuildId: () => null }));
vi.mock('./useCurrentUser', () => ({ useCurrentAccountScope: () => null }));

function Harness() {
  useKeyboardNavigation();
  return (
    <div>
      <textarea aria-label="message" />
      <button type="button">row</button>
    </div>
  );
}

const mount = () =>
  render(
    <MemoryRouter>
      <Harness />
    </MemoryRouter>,
  );

beforeEach(() => {
  mocks.order = ['people', 'fuel', 'game', 'base'];
  mocks.place = serverPlace('fuel');
  mocks.mac = false;
  mocks.go.mockClear();
});

afterEach(() => {
  cleanup();
  document.querySelectorAll('[data-test-dialog]').forEach((node) => node.remove());
});

/** Dispatches the key and says whether the app took it (its default was prevented). */
function press(init: KeyboardEventInit, target: Element = document.body): boolean {
  return !fireEvent.keyDown(target, init);
}

describe('Ctrl+Alt+Up / Down steps through the places', () => {
  it('goes to the next and the previous place in the dock', () => {
    mount();
    expect(press({ key: 'ArrowDown', ctrlKey: true, altKey: true })).toBe(true);
    expect(mocks.go).toHaveBeenLastCalledWith('game');
    expect(press({ key: 'ArrowUp', ctrlKey: true, altKey: true })).toBe(true);
    expect(mocks.go).toHaveBeenLastCalledWith('people');
  });

  it('wraps from the last place to People and from People to the last', () => {
    mocks.place = serverPlace('base');
    mount();
    press({ key: 'ArrowDown', ctrlKey: true, altKey: true });
    expect(mocks.go).toHaveBeenLastCalledWith('people');
    cleanup();
    mocks.place = { kind: 'people' };
    mount();
    press({ key: 'ArrowUp', ctrlKey: true, altKey: true });
    expect(mocks.go).toHaveBeenLastCalledWith('base');
  });

  it('is ⌥⌘↑/↓ on macOS, and Ctrl+Alt does nothing there', () => {
    mocks.mac = true;
    mount();
    expect(press({ key: 'ArrowDown', metaKey: true, altKey: true })).toBe(true);
    expect(mocks.go).toHaveBeenLastCalledWith('game');
    mocks.go.mockClear();
    press({ key: 'ArrowDown', ctrlKey: true, altKey: true });
    expect(mocks.go).not.toHaveBeenCalled();
  });

  it('leaves Alt+Up/Down to the channels', () => {
    mount();
    press({ key: 'ArrowDown', altKey: true });
    expect(mocks.go).not.toHaveBeenCalled();
  });
});

describe('Ctrl+1…9 jump to the nth server', () => {
  it('goes to the nth server, never People', () => {
    mount();
    expect(press({ key: '1', code: 'Digit1', ctrlKey: true })).toBe(true);
    expect(mocks.go).toHaveBeenLastCalledWith('fuel');
    press({ key: '3', code: 'Digit3', ctrlKey: true });
    expect(mocks.go).toHaveBeenLastCalledWith('base');
  });

  it('does nothing, and does not take the key, for a number with no server behind it', () => {
    mount();
    expect(press({ key: '7', code: 'Digit7', ctrlKey: true })).toBe(false);
    expect(mocks.go).not.toHaveBeenCalled();
  });

  it('is ⌘1…9 on macOS', () => {
    mocks.mac = true;
    mount();
    expect(press({ key: '2', code: 'Digit2', metaKey: true })).toBe(true);
    expect(mocks.go).toHaveBeenLastCalledWith('game');
  });

  it('is not Ctrl+0, nor with Shift', () => {
    mount();
    press({ key: '0', code: 'Digit0', ctrlKey: true });
    press({ key: '1', code: 'Digit1', ctrlKey: true, shiftKey: true });
    expect(mocks.go).not.toHaveBeenCalled();
  });
});

describe('while typing, and behind a dialog', () => {
  it('works with the message box focused: these modifiers never insert text', () => {
    const { getByLabelText } = mount();
    const box = getByLabelText('message');
    box.focus();
    expect(press({ key: '2', code: 'Digit2', ctrlKey: true }, box)).toBe(true);
    expect(mocks.go).toHaveBeenLastCalledWith('game');
    expect(press({ key: 'ArrowDown', ctrlKey: true, altKey: true }, box)).toBe(true);
    expect(mocks.go).toHaveBeenLastCalledWith('game');
  });

  it('keeps out of a modal dialog: the app behind it does not move', () => {
    mount();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('data-test-dialog', '');
    document.body.appendChild(dialog);
    expect(press({ key: '1', code: 'Digit1', ctrlKey: true }, dialog)).toBe(false);
    expect(mocks.go).not.toHaveBeenCalled();
  });

  it('works with a sheet open (a sheet is not a modal in the way)', () => {
    mount();
    const sheet = document.createElement('div');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('data-sheet', 'people');
    sheet.setAttribute('data-test-dialog', '');
    document.body.appendChild(sheet);
    press({ key: '1', code: 'Digit1', ctrlKey: true });
    expect(mocks.go).toHaveBeenLastCalledWith('fuel');
  });
});
