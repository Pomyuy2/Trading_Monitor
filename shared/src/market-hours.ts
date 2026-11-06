/**
 * US equity market hours (NYSE / Nasdaq) computed from rules, so it keeps working
 * in future years without a hard-coded calendar:
 *   - regular session 09:30–16:00 ET, pre-market 04:00–09:30, after-hours 16:00–20:00
 *   - early close 13:00 ET (after-hours until 17:00) on: July 3 (when it's a weekday trading
 *     day), the day after Thanksgiving, and Christmas Eve (when it's a weekday trading day)
 *   - holidays with NYSE "observed" rules (Saturday → Friday, Sunday → Monday; New Year's Day
 *     on a Saturday is not observed on the Friday before)
 *   - daylight saving handled through the America/New_York time zone
 * Unscheduled closures (e.g. national days of mourning) can't be predicted.
 */

export type MarketPhase = 'pre' | 'open' | 'post' | 'closed';

export type HolidayKey =
  | 'newYear' | 'mlk' | 'presidents' | 'goodFriday' | 'memorial' | 'juneteenth'
  | 'independence' | 'labor' | 'thanksgiving' | 'christmas';

const TZ = 'America/New_York';
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** Day of week (0 = Sunday) for a calendar date. */
function dow(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function addDays(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** n-th (1-based) weekday of a month; n = -1 for the last one. */
function nthWeekday(y: number, m: number, weekday: number, n: number): number {
  if (n > 0) {
    const first = dow(y, m, 1);
    return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  }
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = dow(y, m, lastDay);
  return lastDay - ((last - weekday + 7) % 7);
}

/** Easter Sunday (Gregorian, "anonymous" algorithm). */
function easter(y: number): { m: number; d: number } {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { m: month, d: day };
}

/** Fixed-date holiday moved to the nearest weekday (Sat → Fri, Sun → Mon). */
function observed(y: number, m: number, d: number): string | null {
  const w = dow(y, m, d);
  if (w === 6) return addDays(ymd(y, m, d), -1);
  if (w === 0) return addDays(ymd(y, m, d), 1);
  return ymd(y, m, d);
}

const holidayCache = new Map<number, Map<string, HolidayKey>>();

/** NYSE full-day holidays for a year: date → holiday. */
export function nyseHolidays(year: number): Map<string, HolidayKey> {
  const hit = holidayCache.get(year);
  if (hit) return hit;
  const h = new Map<string, HolidayKey>();
  const put = (date: string | null, key: HolidayKey) => {
    if (date && date.startsWith(String(year))) h.set(date, key);
  };
  // New Year's Day: Sunday → Monday; Saturday → not observed (Dec 31 stays a trading day).
  if (dow(year, 1, 1) !== 6) put(observed(year, 1, 1), 'newYear');
  put(ymd(year, 1, nthWeekday(year, 1, 1, 3)), 'mlk');
  put(ymd(year, 2, nthWeekday(year, 2, 1, 3)), 'presidents');
  const e = easter(year);
  put(addDays(ymd(year, e.m, e.d), -2), 'goodFriday');
  put(ymd(year, 5, nthWeekday(year, 5, 1, -1)), 'memorial');
  if (year >= 2022) put(observed(year, 6, 19), 'juneteenth');
  put(observed(year, 7, 4), 'independence');
  put(ymd(year, 9, nthWeekday(year, 9, 1, 1)), 'labor');
  put(ymd(year, 11, nthWeekday(year, 11, 4, 4)), 'thanksgiving');
  put(observed(year, 12, 25), 'christmas');
  holidayCache.set(year, h);
  return h;
}

export function holidayOn(date: string): HolidayKey | null {
  return nyseHolidays(Number(date.slice(0, 4))).get(date) ?? null;
}

export function isTradingDay(date: string): boolean {
  const [y, m, d] = date.split('-').map(Number);
  const w = dow(y, m, d);
  return w !== 0 && w !== 6 && !holidayOn(date);
}

/** 13:00 ET closes. */
export function isEarlyClose(date: string): boolean {
  if (!isTradingDay(date)) return false;
  const [y, m, d] = date.split('-').map(Number);
  if (m === 7 && d === 3) return true; // trading day before Independence Day
  if (m === 12 && d === 24) return true; // Christmas Eve
  if (m === 11 && date === addDays(ymd(y, 11, nthWeekday(y, 11, 4, 4)), 1)) return true; // day after Thanksgiving
  return false;
}

// ---------- time-zone helpers ----------
const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function nyParts(ms: number) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second };
}

/** Calendar date in New York for an instant. */
export function nyDateOf(ms: number): string {
  const p = nyParts(ms);
  return ymd(p.y, p.m, p.d);
}

/** UTC offset of New York at an instant, in minutes (e.g. -300 in winter, -240 in summer). */
function nyOffset(ms: number): number {
  const p = nyParts(ms);
  return Math.round((Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(ms / 1000) * 1000) / 60000);
}

/** Instant (ms) of a New York wall-clock time — correct across daylight-saving changes. */
export function nyTime(date: string, hour: number, minute: number): number {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  const first = guess - nyOffset(guess) * 60000;
  return guess - nyOffset(first) * 60000;
}

// ---------- status ----------
export interface SessionTimes {
  date: string;
  preStart: number;
  open: number;
  close: number;
  postEnd: number;
  earlyClose: boolean;
}

export function sessionOn(date: string): SessionTimes | null {
  if (!isTradingDay(date)) return null;
  const early = isEarlyClose(date);
  return {
    date,
    preStart: nyTime(date, 4, 0),
    open: nyTime(date, 9, 30),
    close: nyTime(date, early ? 13 : 16, 0),
    postEnd: nyTime(date, early ? 17 : 20, 0),
    earlyClose: early,
  };
}

/** The next session whose regular open is after `ms`. */
export function nextSession(ms: number): SessionTimes {
  let date = nyDateOf(ms);
  for (let i = 0; i < 14; i++) {
    const s = sessionOn(date);
    if (s && s.open > ms) return s;
    date = addDays(date, 1);
  }
  throw new Error('No trading session within 14 days');
}

export interface MarketStatus {
  phase: MarketPhase;
  /** Session for today (New York date), if it's a trading day. */
  today: SessionTimes | null;
  /** Next regular open after now. */
  nextOpen: number;
  /** When the current phase ends (close for 'open', open for 'pre', post end for 'post'). */
  phaseEnds: number | null;
  /** Full-day holiday today, if any. */
  holiday: HolidayKey | null;
}

export function marketStatus(now = Date.now()): MarketStatus {
  const date = nyDateOf(now);
  const today = sessionOn(date);
  const next = nextSession(now);
  const holiday = holidayOn(date);
  if (!today) return { phase: 'closed', today: null, nextOpen: next.open, phaseEnds: null, holiday };
  if (now < today.preStart) return { phase: 'closed', today, nextOpen: today.open, phaseEnds: null, holiday };
  if (now < today.open) return { phase: 'pre', today, nextOpen: today.open, phaseEnds: today.open, holiday };
  if (now < today.close) return { phase: 'open', today, nextOpen: next.open, phaseEnds: today.close, holiday };
  if (now < today.postEnd) return { phase: 'post', today, nextOpen: next.open, phaseEnds: today.postEnd, holiday };
  return { phase: 'closed', today, nextOpen: next.open, phaseEnds: null, holiday };
}
