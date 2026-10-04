import { useId } from 'react';
import { formatShortcutKey } from '../../../lib/keyboardShortcuts';
import { CreamButton } from '../../ix/primitives';
import { Kbd } from '../../ui/Kbd';
import { Modal } from '../../ui/Modal';

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
      { label: 'Quick switcher', keys: ['Mod', 'K'] },
      { label: 'Search messages', keys: ['Mod', 'F'] },
      { label: 'Previous or next channel', keys: ['Alt', '↑/↓'] },
      { label: 'Switch server', keys: ['Ctrl', 'Alt', '↑/↓'] },
      { label: 'Jump to a server', keys: ['Ctrl', '1–9'] },
    ],
  },
  {
    title: 'Settings',
    shortcuts: [
      { label: 'User settings', keys: ['Ctrl', ','] },
      { label: 'Server settings', keys: ['Ctrl', 'Shift', ','] },
      { label: 'Keyboard shortcuts', keys: ['Mod', '/'] },
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
    title: 'Calls',
    shortcuts: [
      { label: 'Mute', keys: ['Ctrl', 'Shift', 'M'] },
      { label: 'Deafen', keys: ['Ctrl', 'Shift', 'D'] },
      { label: 'Theater, in the call view', keys: ['T'] },
      { label: 'Chat, in the call view', keys: ['H'] },
      { label: 'Clip, in the call view', keys: ['C'] },
    ],
  },
  {
    title: 'General',
    shortcuts: [{ label: 'Close a sheet, menu or dialog', keys: ['Esc'] }],
  },
];

/**
 * Keyboard shortcuts, as a dialog (docs/index-spec.md §6.4, §6.12; the account
 * menu's "Keyboard shortcuts" and Ctrl /): centered, max 440 wide, radius 20,
 * the card color; a section label (sentence case) over rows of a name and its
 * keys; one cream "Done". The shared `Modal` owns the focus trap, Escape and the
 * scrim, so it follows the dialog restyle (IX-17) with the rest.
 */
export function HelpOverlay({ open, onClose }: HelpOverlayProps) {
  const titleId = useId();
  return (
    <Modal
      open={open}
      onClose={onClose}
      labeledBy={titleId}
      panelClassName="ix-dialog-panel ix-help-panel"
    >
      <div className="ix-dialog ix-help">
        <h2 id={titleId} className="ix-dialog__title">
          Keyboard shortcuts
        </h2>
        <div className="ix-help__scroll">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title} aria-label={group.title} className="ix-help__group">
              <h3 className="ix-help__label">{group.title}</h3>
              <dl className="ix-help__list">
                {group.shortcuts.map((item) => (
                  <div key={item.label} className="ix-help__row">
                    <dt className="ix-help__name">{item.label}</dt>
                    <dd className="ix-help__keys">
                      {item.keys.map((key) => (
                        <Kbd key={key}>{formatShortcutKey(key)}</Kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <div className="ix-dialog__actions">
          <CreamButton onClick={onClose}>Done</CreamButton>
        </div>
      </div>
    </Modal>
  );
}
