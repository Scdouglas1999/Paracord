import { create } from 'zustand';

import type { AccountScope } from '../../../lib/serverScope';
import { registerSessionReset } from '../../../stores/sessionReset';
import type { User } from '../../../types';
import type { MenuAnchor } from './anchor';

/**
 * What is open in the menu host (components/ix/menus/MenuHost.tsx, mounted by the
 * sheet slot).
 *
 * The server menu is opened from two packages (the sidebar's header, the dock's
 * right click), the channel menu from the conversation's title, the People menu
 * from the People header, the profile card from a face anywhere, and the Help
 * dialog from the account menu and Ctrl /. They share one host and open through
 * the functions at the bottom of this file, so none of them mounts a menu of its
 * own. One menu is open at a time: opening one closes the last.
 */

/** A server as the menus need it: the account it is on (a menu acts on that account) and its name. */
export interface ServerRef {
  guildId: string;
  scope: AccountScope;
  name: string;
}

/** A conversation as the channel menu needs it. Structurally a `ConversationSubject`. */
export type ChannelMenuSubject =
  | { kind: 'channel'; guildId: string; channelId: string; channelName?: string }
  | { kind: 'dm'; channelId: string; title?: string; isGroup?: boolean };

export interface ChannelMenuRequest {
  subject: ChannelMenuSubject;
  /** Whether the server allows a catch-up summary here, and why not. */
  summary: { allowed: boolean; reason: string | null };
}

export type ProfileSubject = Pick<User, 'id' | 'username'> & Partial<User>;

export interface CreateChannelRequest {
  guildId: string;
  scope: AccountScope;
  /** A text channel, or a room (a voice channel). */
  kind: 'text' | 'room';
  /** Preselect a category. */
  parentId?: string | null;
}

export interface InviteRequest {
  guildName: string;
  /** The channel an invite is minted through. */
  channelId: string;
}

export type OpenMenu =
  | { kind: 'server'; server: ServerRef; anchor: MenuAnchor }
  | { kind: 'channel'; request: ChannelMenuRequest; anchor: MenuAnchor }
  | { kind: 'people'; anchor: MenuAnchor }
  | null;

interface HostState {
  menu: OpenMenu;
  help: boolean;
  profile: { user: ProfileSubject; position: { x: number; y: number } } | null;
  createChannel: CreateChannelRequest | null;
  invite: InviteRequest | null;
  dmPicker: boolean;
  setMenu: (menu: OpenMenu) => void;
  setHelp: (open: boolean) => void;
  setProfile: (profile: HostState['profile']) => void;
  setCreateChannel: (request: CreateChannelRequest | null) => void;
  setInvite: (request: InviteRequest | null) => void;
  setDmPicker: (open: boolean) => void;
  reset: () => void;
}

export const useMenuHostStore = create<HostState>()((set) => ({
  menu: null,
  help: false,
  profile: null,
  createChannel: null,
  invite: null,
  dmPicker: false,
  setMenu: (menu) => set({ menu }),
  setHelp: (help) => set({ help }),
  setProfile: (profile) => set({ profile }),
  setCreateChannel: (createChannel) => set({ createChannel }),
  setInvite: (invite) => set({ invite }),
  setDmPicker: (dmPicker) => set({ dmPicker }),
  reset: () => set({ menu: null, help: false, profile: null, createChannel: null, invite: null, dmPicker: false }),
}));

registerSessionReset('ix-menu-host', () => useMenuHostStore.getState().reset());

/* ---- Openers ----------------------------------------------------------------------- */

/** Open the server menu (§6.2): the header's "...", a right click on the header or on a dock mark. */
export function openServerMenu(server: ServerRef, anchor: MenuAnchor): void {
  useMenuHostStore.getState().setMenu({ kind: 'server', server, anchor });
}

/** Open the channel menu (§6.5) under the large or folded title. */
export function openChannelMenu(request: ChannelMenuRequest, anchor: MenuAnchor): void {
  useMenuHostStore.getState().setMenu({ kind: 'channel', request, anchor });
}

/** Open the People menu (§6.6) from the People header's "...". */
export function openPeopleMenu(anchor: MenuAnchor): void {
  useMenuHostStore.getState().setMenu({ kind: 'people', anchor });
}

/** Close whichever menu is open. */
export function closeMenu(): void {
  useMenuHostStore.getState().setMenu(null);
}

/** Open the profile card (§6.9) beside a point (usually the face that was clicked). */
export function openProfileCard(user: ProfileSubject, position: { x: number; y: number }): void {
  useMenuHostStore.getState().setProfile({ user, position });
}

export function closeProfileCard(): void {
  useMenuHostStore.getState().setProfile(null);
}

/** Open the Help dialog (keyboard shortcuts; Ctrl /). */
export function openHelp(): void {
  useMenuHostStore.getState().setHelp(true);
}

export function closeHelp(): void {
  useMenuHostStore.getState().setHelp(false);
}

/** Open the Create channel / Create voice channel dialog (the server menu, a category's "+"). */
export function openCreateChannel(request: CreateChannelRequest): void {
  useMenuHostStore.getState().setCreateChannel(request);
}

export function closeCreateChannel(): void {
  useMenuHostStore.getState().setCreateChannel(null);
}

/** Open the invite dialog for a server (the server menu's "Invite people"). */
export function openInvite(request: InviteRequest): void {
  useMenuHostStore.getState().setInvite(request);
}

export function closeInvite(): void {
  useMenuHostStore.getState().setInvite(null);
}

/** Open the New message / group picker (the People menu). */
export function openDmPicker(): void {
  useMenuHostStore.getState().setDmPicker(true);
}

export function closeDmPicker(): void {
  useMenuHostStore.getState().setDmPicker(false);
}

/** Is the server menu open for this server? A header's "..." button reads it for `aria-expanded`. */
export function useServerMenuOpenFor(guildId: string | null): boolean {
  return useMenuHostStore((state) => state.menu?.kind === 'server' && state.menu.server.guildId === guildId);
}
