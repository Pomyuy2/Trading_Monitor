const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Calendar date (YYYY-MM-DD) in New York for a unix-seconds timestamp. */
export function nyDate(tsSec: number): string {
  return etDate.format(new Date(tsSec * 1000));
}

/** "YYYY-MM-DD" → unix seconds at 00:00 UTC (how daily bars are keyed). */
export function dateToUtcSec(date: string): number {
  return Date.parse(`${date.slice(0, 10)}T00:00:00Z`) / 1000;
}
