import { Gamepad2 } from 'lucide-react';
import { gameServersApi } from '../../api/gameServers';
import { GAME_SERVERS_DESCRIPTION, GameServersSection } from '../gameServers/GameServersSection';
import { useGameServerStore } from '../../stores/gameServerStore';
import type { AddonDescriptor } from './registry';

/** The Game servers add-on, as the add-ons hub lists it. */
export const gameServersAddon: AddonDescriptor = {
  id: 'game-servers',
  name: 'Game servers',
  description: GAME_SERVERS_DESCRIPTION,
  icon: Gamepad2,
  Section: GameServersSection,
  status: {
    load: async (guildId) => (await gameServersApi.list(guildId)).data.enabled,
    set: async (guildId, enabled) => {
      await gameServersApi.setEnabled(guildId, enabled);
      useGameServerStore.getState().setEnabled(guildId, enabled);
      void useGameServerStore.getState().refresh(guildId);
    },
  },
};
