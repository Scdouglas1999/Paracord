import { DailyWordMark } from './DailyWordMark';
import { DAILY_WORD_DESCRIPTION, DailyWordSection } from './DailyWordSection';

/** The Daily word add-on, as the add-ons hub lists it. */
export const dailyWordAddon = {
  id: 'daily-word',
  name: 'Daily word',
  description: DAILY_WORD_DESCRIPTION,
  icon: DailyWordMark,
  Section: DailyWordSection,
} as const;
