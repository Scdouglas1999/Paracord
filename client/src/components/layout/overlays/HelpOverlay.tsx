import { useRef } from 'react';
import type { RefObject } from 'react';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { formatShortcutKey } from '../../../lib/keyboardShortcuts';
import { SheetKicker } from '../../glass/sheets/SheetParts';
import { Kbd } from '../../ui/Kbd';
import { TopBarOverlay } from './TopBarOverlay';

interface HelpOverlayProps {
  open: boolean;
  onClose: () => void;
}

interface Shortcut {
  label: string;
  keys: string[];
}

const SHORTCUT_GROUPS: Array<{ title: string; shortcuts: Shortcut[] }> = [
  {
    title: 'Navigation',
    shortcuts: [
      { label: 'Command palette', keys: ['Mod', 'K'] },
      { label: 'Search in channel', keys: ['Mod', 'F'] },
      { label: 'Switch server', keys: ['Ctrl', 'Alt', '↑/↓'] },
    ],
  },
  {
    title: 'Settings',
    shortcuts: [
      { label: 'User settings', keys: ['Ctrl', ','] },
      { label: 'Server settings', keys: ['Ctrl', 'Shift', ','] },
    ],
  },
  {
    title: 'Messaging',
    shortcuts: [
      { label: 'Send message', keys: ['Enter'] },
      { label: 'New line', keys: ['Shift', 'Enter'] },
    ],
  },
  {
    title: 'General',
    shortcuts: [{ label: 'Close a sheet or dialog', keys: ['Esc'] }],
  },
];

/** Keyboard shortcuts, as a sheet: group kickers, a name and its keys on each row. */
export function HelpOverlay({ open, onClose }: HelpOverlayProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useFocusTrap(dialogRef as RefObject<HTMLDivElement | null>, open, onClose);

  return (
    <TopBarOverlay
      open={open}
      onClose={onClose}
      dialogRef={dialogRef as RefObject<HTMLDivElement | null>}
      titleId="topbar-help-title"
      title="Keyboard shortcuts"
      closeLabel="Close keyboard shortcuts"
    >
      {SHORTCUT_GROUPS.map((group) => (
        <section key={group.title} aria-label={group.title}>
          <SheetKicker>{group.title}</SheetKicker>
          <dl className="glass-help__list">
            {group.shortcuts.map((item) => (
              <div key={item.label} className="glass-help__row">
                <dt className="glass-sheet-row__name glass-help__name">{item.label}</dt>
                <dd className="glass-help__keys">
                  {item.keys.map((k) => (
                    <Kbd key={k}>{formatShortcutKey(k)}</Kbd>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </TopBarOverlay>
  );
}
