import { wallClock } from '../../../lib/formatters';

/**
 * "Sep 30, 9:12 pm": a date and the app's one wall clock (the year only when it
 * is not this one). Sheets list things from any day, so a bare time would not
 * say when.
 */
export function whenLabel(raw: string | undefined | null): string {
  if (!raw) return '';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  const sameYear = date.getFullYear() === new Date().getFullYear();
  const day = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
  return `${day}, ${wallClock(date)}`;
}
