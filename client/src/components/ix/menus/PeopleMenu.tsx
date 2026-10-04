import { useNavigate } from 'react-router';
import { MessageSquarePlus, Settings, UserPlus, Users } from 'lucide-react';

import { useUIStore } from '../../../stores/uiStore';
import type { MenuAnchor } from './anchor';
import { closeMenu, openDmPicker } from './hostStore';
import { IxMenu, type IxMenuEntry } from './IxMenu';
import { modHint } from './menuUtils';

/**
 * The People menu (docs/index-spec.md §4.1, §6.6): "..." in the People header.
 * New message and Start a group (the DM picker, on its Direct or its Group half), Add
 * friend (the Friends page with its form open), and Settings.
 *
 * HOW TO OPEN IT (IX-14's People header): `openPeopleMenu(anchor)` from
 * `components/ix/menus`, the "..." button as `{ element, align: 'end' }`.
 */

export interface PeopleMenuActions {
  newMessage: () => void;
  startGroup: () => void;
  addFriend: () => void;
  settings: () => void;
}

export function buildPeopleMenu(actions: PeopleMenuActions): IxMenuEntry[] {
  return [
    { type: 'item', id: 'new-message', label: 'New message', icon: <MessageSquarePlus size={16} strokeWidth={1.7} />, onSelect: actions.newMessage },
    { type: 'item', id: 'start-group', label: 'Start a group', icon: <Users size={16} strokeWidth={1.7} />, onSelect: actions.startGroup },
    { type: 'item', id: 'add-friend', label: 'Add friend', icon: <UserPlus size={16} strokeWidth={1.7} />, onSelect: actions.addFriend },
    { type: 'separator', id: 'sep' },
    { type: 'item', id: 'settings', label: 'Settings', icon: <Settings size={16} strokeWidth={1.7} />, hint: modHint(','), onSelect: actions.settings },
  ];
}

export function PeopleMenuView({ anchor }: { anchor: MenuAnchor }) {
  const navigate = useNavigate();
  const entries = buildPeopleMenu({
    newMessage: () => openDmPicker('direct'),
    startGroup: () => openDmPicker('group'),
    // The Friends page with its add form already open.
    addFriend: () => navigate('/app/friends', { state: { addFriend: true } }),
    settings: () => useUIStore.getState().setUserSettingsOpen(true),
  });
  return <IxMenu open onClose={closeMenu} anchor={anchor} label="People menu" width={240} entries={entries} testId="ix-people-menu" />;
}
