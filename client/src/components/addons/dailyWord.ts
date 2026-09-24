import { dailyWordApi } from '../../api/dailyWord';
import { useDailyWordStore } from '../../stores/dailyWordStore';
import { DailyWordMark } from './DailyWordMark';
import { DAILY_WORD_DESCRIPTION, DailyWordSection } from './DailyWordSection';
import type { AddonDescriptor } from './registry';

/** The Daily word add-on, as the add-ons hub lists it. */
export const dailyWordAddon: AddonDescriptor = {
  id: 'daily-word',
  name: 'Daily word',
  description: DAILY_WORD_DESCRIPTION,
  icon: DailyWordMark,
  Section: DailyWordSection,
  status: {
    load: async (guildId) => (await dailyWordApi.getSettings(guildId)).data.enabled,
    set: async (guildId, enabled) => {
      const res = await dailyWordApi.updateSettings(guildId, { enabled });
      useDailyWordStore.getState().adoptSettings(res.data);
    },
  },
};
