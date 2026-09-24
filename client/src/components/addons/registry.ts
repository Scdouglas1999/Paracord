import type { ComponentType, ReactNode } from 'react';
import { feedsAddon } from './feeds';
import { sportsAddon } from './sports';

/** What an add-on's page receives. */
export interface AddonSectionProps {
  guildId: string;
}

/**
 * Whether an add-on is on for a server, for the switch on its hub card. An
 * add-on without one shows only "Set up"; its own page carries the switch.
 */
export interface AddonStatus {
  load: (guildId: string) => Promise<boolean>;
  set: (guildId: string, enabled: boolean) => Promise<void>;
}

/**
 * One add-on in Server settings → Add-ons. To add one, export a descriptor
 * from its own module and list it in {@link ADDONS} below.
 */
export interface AddonDescriptor {
  id: string;
  name: string;
  /** One line on the hub card. */
  description: string;
  /** A component taking `size`, or a ready element. */
  icon: ComponentType<{ size?: number }> | ReactNode;
  /** The add-on's page, opened by "Set up". */
  Section: ComponentType<AddonSectionProps>;
  status?: AddonStatus;
}

/** Every add-on, in the order the hub lists them. */
export const ADDONS: readonly AddonDescriptor[] = [
  sportsAddon,
  feedsAddon,
];

export function findAddon(id: string | null | undefined): AddonDescriptor | undefined {
  return id ? ADDONS.find((addon) => addon.id === id) : undefined;
}
