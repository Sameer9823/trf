/**
 * Calendar-day helpers.
 *
 * A PostgreSQL DATE is a day with no time and no zone. node-pg hands it back as
 * a local-midnight Date, and `toISOString()` then shifts it one day earlier east
 * of Greenwich (for example in India, UTC+05:30). Everything here formats the
 * local calendar day instead, so a DATE read at 00:00 local stays the same day.
 */

/** A Date as its local `YYYY-MM-DD` calendar day. */
export function localDay(value: Date): string {
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

/** Today's calendar day in the server's local time, as `YYYY-MM-DD`. */
export function today(): string {
  return localDay(new Date());
}

/** A DATE value (plain `YYYY-MM-DD` text from pg, or a legacy Date) as a day. */
export function dateOnly(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value.slice(0, 10) : localDay(value);
}