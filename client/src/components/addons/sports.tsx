import { SportsSettingsSection } from '../sports/SportsSettingsSection';
import { sportsApi } from '../../api/sports';
import { useSportsStore } from '../../stores/sportsStore';
import type { AddonDescriptor } from './registry';

/** The Sports add-on's mark: a ball over a strip of turf. */
export function SportsMark() {
  const size = 28;
  return (
    <svg viewBox="0 0 28 28" width={size} height={size} aria-hidden>
      <path d="M4 20 Q14 8 24 20" fill="none" stroke="var(--sports-turf)" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="14" cy="16" r="3.1" fill="var(--sports-leather)" />
      <path d="M14 13.4 V18.6 M11.6 16 H16.4" stroke="var(--sports-lace)" strokeWidth="0.7" />
    </svg>
  );
}

export const sportsAddon: AddonDescriptor = {
  id: 'sports',
  name: 'Sports',
  description: 'A scoreboard for the leagues your server follows. Adds a Sports page to the sidebar.',
  icon: SportsMark,
  Section: SportsSettingsSection,
  status: {
    load: async (guildId) => {
      await useSportsStore.getState().ensureSettings(guildId);
      const current = useSportsStore.getState().byGuild[guildId];
      if (!current?.settings || current.settingsStatus !== 'ready') {
        throw new Error(current?.settingsError || "Sports settings couldn't be loaded.");
      }
      return current.settings.enabled;
    },
    set: async (guildId, enabled) => {
      const res = await sportsApi.updateSettings(guildId, { enabled });
      useSportsStore.getState().adoptSettings(res.data);
    },
  },
};
