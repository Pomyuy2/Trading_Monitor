import { isEarlyClose, isTradingDay, marketStatus, nextSession, nyseHolidays, nyTime } from '@tm/shared';
import { describe, expect, it } from 'vitest';

const at = (iso: string) => Date.parse(iso);

describe('NYSE holidays (rule-based)', () => {
  it('matches the published 2026 calendar', () => {
    expect([...nyseHolidays(2026).keys()].sort()).toEqual([
      '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
      '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
    ]);
  });

  it('applies observed-day rules in 2027 (Juneteenth, July 4, Christmas fall on weekends)', () => {
    const h = nyseHolidays(2027);
    expect(h.get('2027-03-26')).toBe('goodFriday');
    expect(h.get('2027-06-18')).toBe('juneteenth'); // Sat → Fri
    expect(h.get('2027-07-05')).toBe('independence'); // Sun → Mon
    expect(h.get('2027-12-24')).toBe('christmas'); // Sat → Fri
  });

  it('does not observe New Year’s Day on the Friday before when it falls on a Saturday', () => {
    // 2028-01-01 is a Saturday: 2027-12-31 is a normal trading day.
    expect(isTradingDay('2027-12-31')).toBe(true);
    expect(nyseHolidays(2028).has('2027-12-31')).toBe(false);
  });

  it('knows the 2025 Good Friday and Thanksgiving', () => {
    expect(nyseHolidays(2025).get('2025-04-18')).toBe('goodFriday');
    expect(nyseHolidays(2025).get('2025-11-27')).toBe('thanksgiving');
  });
});

describe('early closes (13:00 ET)', () => {
  it('2026: day after Thanksgiving and Christmas Eve, no July early close (July 3 is the holiday)', () => {
    expect(isEarlyClose('2026-11-27')).toBe(true);
    expect(isEarlyClose('2026-12-24')).toBe(true);
    expect(isEarlyClose('2026-07-02')).toBe(false);
    expect(isEarlyClose('2026-07-03')).toBe(false);
  });

  it('2025: July 3 is an early close', () => {
    expect(isEarlyClose('2025-07-03')).toBe(true);
  });

  it('2027: Christmas Eve is a holiday, not an early close', () => {
    expect(isEarlyClose('2027-12-24')).toBe(false);
  });
});

describe('daylight saving', () => {
  it('09:30 New York is 14:30 UTC in winter and 13:30 UTC in summer', () => {
    expect(new Date(nyTime('2026-11-06', 9, 30)).toISOString()).toBe('2026-11-06T14:30:00.000Z');
    expect(new Date(nyTime('2026-07-01', 9, 30)).toISOString()).toBe('2026-07-01T13:30:00.000Z');
  });

  it('handles the switch days (2026-03-08 and 2026-11-01)', () => {
    expect(new Date(nyTime('2026-03-09', 9, 30)).toISOString()).toBe('2026-03-09T13:30:00.000Z'); // first Monday of EDT
    expect(new Date(nyTime('2026-11-02', 9, 30)).toISOString()).toBe('2026-11-02T14:30:00.000Z'); // first Monday of EST
  });
});

describe('marketStatus', () => {
  it('regular session on a normal day', () => {
    const s = marketStatus(at('2026-11-06T15:00:00Z')); // 10:00 ET Friday
    expect(s.phase).toBe('open');
    expect(new Date(s.phaseEnds!).toISOString()).toBe('2026-11-06T21:00:00.000Z'); // 16:00 ET
  });

  it('pre-market and after-hours', () => {
    expect(marketStatus(at('2026-11-06T10:00:00Z')).phase).toBe('pre'); // 05:00 ET
    expect(marketStatus(at('2026-11-06T22:00:00Z')).phase).toBe('post'); // 17:00 ET
    expect(marketStatus(at('2026-11-07T02:00:00Z')).phase).toBe('closed'); // 21:00 ET
  });

  it('weekend: closed, next open is Monday 09:30 ET', () => {
    const s = marketStatus(at('2026-11-07T15:00:00Z')); // Saturday
    expect(s.phase).toBe('closed');
    expect(new Date(s.nextOpen).toISOString()).toBe('2026-11-09T14:30:00.000Z');
  });

  it('holiday: closed with the holiday name; Thanksgiving → Friday half day', () => {
    const s = marketStatus(at('2026-11-26T16:00:00Z'));
    expect(s.phase).toBe('closed');
    expect(s.holiday).toBe('thanksgiving');
    expect(new Date(s.nextOpen).toISOString()).toBe('2026-11-27T14:30:00.000Z');
    const fri = marketStatus(at('2026-11-27T17:30:00Z')); // 12:30 ET
    expect(fri.phase).toBe('open');
    expect(new Date(fri.phaseEnds!).toISOString()).toBe('2026-11-27T18:00:00.000Z'); // 13:00 ET close
    expect(marketStatus(at('2026-11-27T18:30:00Z')).phase).toBe('post');
  });

  it('skips a long weekend to find the next session (Good Friday 2026)', () => {
    expect(nextSession(at('2026-04-02T21:00:00Z')).date).toBe('2026-04-06');
  });
});
