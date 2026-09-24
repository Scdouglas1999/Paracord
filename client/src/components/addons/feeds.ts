import { Rss } from 'lucide-react';
import { feedsApi } from '../../api/feeds';
import { FeedsSection } from '../feeds/FeedsSection';
import type { AddonDescriptor } from './registry';

export const feedsAddon: AddonDescriptor = {
  id: 'feeds',
  name: 'Feeds',
  description: 'New posts, videos, releases and streams from outside Paracord, posted into a channel.',
  icon: Rss,
  Section: FeedsSection,
  status: {
    load: async (guildId) => (await feedsApi.list(guildId)).data.enabled,
    set: async (guildId, enabled) => {
      await feedsApi.setEnabled(guildId, enabled);
    },
  },
};
